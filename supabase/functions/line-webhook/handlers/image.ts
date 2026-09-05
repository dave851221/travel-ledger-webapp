// ============================================================
// handlers/image.ts —— 收據照片的 OCR 路徑
//
// 下載 → 上傳 Storage → Gemini OCR → 驗證（成員／幣別／分類／日期）→ 出卡片。
//
// ⚠️ 照片一旦上傳就要負責清乾淨：辨識不出來、不是收據、或整段拋例外時，
//    都要把 filePath 從 bucket 移除，否則會留下沒有支出指向它的孤兒照片。
//    唯一的例外是「幣別沒匯率」（M10）—— 那時刻意保留照片，
//    讓使用者選一個幣別就能直接存入，不必重拍。
// ============================================================

import { Decimal } from "../../_shared/deps.ts"
import { calculateDistribution, DEFAULT_PRECISION } from "../../_shared/finance.ts"
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import {
  applyParticipantDefaults,
  extractJSON,
  normalizeCurrency,
  normalizeDate,
  normalizeExpenseAmountMaps,
  resolveCategory,
  resolveCurrencyByRule,
  resolveExpenseMembers,
} from "../guards.ts"
import { isRateLimit, RATE_LIMIT_MSG, RECEIPTS_BUCKET, WEBAPP_URL } from "../config.ts"
import { type EventContext, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import { storePendingExpense } from "../drafts.ts"
import { askGemini, GEMINI_OCR_MODELS, OCR_RESPONSE_SCHEMA } from "../gemini.ts"
import { downloadLineContent, replyMessage } from "../line-api.ts"
import { buildDraftLiffUrl, buildExpenseCard } from "../messages.ts"
import { runInBackground } from "../util.ts"
import type { PrecisionConfig } from "../../_shared/types.ts"
import type { ExpenseDraft, ImageMessageEvent, OcrResponse } from "../types.ts"

/** 處理一張收據照片。呼叫端已經確認 ctx.isBound。 */
export async function handleImage(ctx: EventContext, event: ImageMessageEvent): Promise<void> {
  const { boundQR, isGroup, memberName, replyToken, sourceId, userState } = ctx

  const messageId = event.message.id

  if (!userState?.current_trip_id) {
    await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程，再傳送收據照片喔！' }], sourceId)
    return
  }

  const tripId = userState.current_trip_id
  const filePath = `expenses/${tripId}/${messageId}.jpg`
  try {
    console.log(`[IMAGE] Downloading messageId: ${messageId}`)
    const [lineRes, { data: trip }] = await Promise.all([
      downloadLineContent(messageId),
      supabase.from('trips').select('*').eq('id', tripId).single()
    ])
    if (!lineRes.ok) throw new Error('Failed to download image from LINE')

    if (!trip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
      return
    }
    // 照片還沒上傳，直接回覆就好，不需要清理 Storage。
    // 以前是靜默 continue —— 使用者傳了照片卻什麼都沒發生，
    // 與文件寫的「回覆已封存」不符（H8）。
    if (trip.is_archived) {
      console.log(`[PHOTO] Trip ${tripId} is archived, ignoring photo from ${sourceId}`)
      await replyMessage(replyToken, [{
        type: 'text', text: '🔒 此旅程已封存，無法新增支出（照片未儲存）。', quickReply: boundQR,
      }], sourceId)
      return
    }

    const imageBuffer = await lineRes.arrayBuffer()

    console.log(`[STORAGE] Uploading to: ${filePath}`)
    const { error: uploadErr } = await supabase.storage.from(RECEIPTS_BUCKET).upload(filePath, imageBuffer, {
      contentType: 'image/jpeg', upsert: true
    })
    if (uploadErr) throw uploadErr

    const { data: { publicUrl } } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(filePath)
    const base64Image = encodeBase64(new Uint8Array(imageBuffer))
    const today = tripToday(trip)

    const ocrPrompt = `
### 你的身份
你是一位專業又貼心的旅遊記帳小幫手「耀西」，是瑪利歐系列的一位知名角色。
在遊戲中的叫聲通常是高亢、可愛的「Yoshi! Yoshi!」或「嗯——嗯！」，與使用者聊天時，偶爾可以適當穿插這樣的叫聲。

### 你的任務
這是一張消費收據或發票的照片。請扮演專業的記帳小幫手並進行解析。

### 背景資訊
- 旅程：${trip.name} (網址: ${WEBAPP_URL}/#/trip/${tripId}/dashboard)
- 成員清單(僅能從中選擇成員)：${trip.members.join(', ')}
- 分類：${trip.categories.join(', ')} (預設: ${trip.default_category || '無'})
- 記帳預設幣別：${trip.default_currency || trip.base_currency}（收據上看不出幣別時填這個）
- 結算主幣別：${trip.base_currency}（只用於統計，不要拿來當記帳幣別）；可用幣別：${Object.keys(trip.rates ?? {}).join(', ') || '（尚未設定）'}
- 今日：${today}
- 封存狀態：${trip.is_archived ? '已封存 (唯讀)' : '進行中'}
- 記帳偏好(整趟旅程共用)：${trip.ai_preference || '無'}
- 使用者名稱(傳訊息的人)：${memberName}
- 旅程預設付款人：${trip.default_payer?.length ? trip.default_payer.join(', ') : '無'}
- 旅程預設分攤成員：${trip.default_split_members?.length ? trip.default_split_members.join(', ') : '全部成員'}

### 任務規則
1. 辨識「總金額」與「幣別」。
   - 🚫 **嚴禁換算匯率。** amount 必須是收據上印的那個數字，currency 必須是收據本身的幣別。
     例如日本的收據寫 3,200 円，就填 amount: 3200、currency: "JPY"，
     **絕對不可以**幫忙換成台幣，也不可以因為旅程的主幣別是 TWD 就改寫金額。
     換算是系統在統計時自己會做的事，你只要忠實照抄。
   - 幣別從符號、地址或語系判斷 (¥/JPY、$/USD、NT/TWD、€/EUR、₩/KRW、฿/THB)。
   - 收據上真的看不出幣別時，才依序參考：記帳偏好提及的幣別 → 背景資訊的記帳預設幣別。
   - currency_source 要誠實回報幣別是哪裡來的：收據上看得出來填 "stated"、
     只能靠記帳偏好推斷填 "preference"、兩者都沒有填 "none"
     （填 none 時系統會自動改用記帳預設幣別，不必勉強猜）。
2. 辨識「日期」。若收據上無明確日期，請使用今日。
3. 辨識「品項描述」。提取商店名稱或主要品項。
   - 外文店名請保留原文，並在括號內補上簡短的繁體中文說明，讓人看得懂那是什麼店，
     例如「肉の匠家 (和牛燒肉店)」、「一蘭ラーメン (拉麵)」、「ドン・キホーテ (驚安殿堂．藥妝百貨)」。
   - 括號裡寫「這是什麼」而不是逐字直譯；只寫原文別人會看不懂，只寫中文又失去原始資訊。
4. 辨識「分類」。若無法判別，可以先看是否有"其他"類別，若無"其他"類別可優先使用預設分類。
5. 請詳讀「記帳偏好」，再來決定 payer_data (墊付) 與 split_details (應付)。
   - 分帳時盡量不要有小數點(除非總金額有小數點)，按照以下規則分配好金額後，請務必確保總數加起來相等。
   - 🚫 payer_data 及 split_details 的 key **絕對只能**寫「成員清單」中已列出的字串，一字不差。
     若使用者用了暱稱、口誤、諧音或縮寫，可以合理推測對應到清單裡最接近的成員，並使用清單上的正式名稱。
     但若沒把握、找不到夠接近的對應，請寧可走「成員第一位 / 全員均分」的預設邏輯，**絕對不可以**自創、音譯、或把不存在的名字寫進 JSON。
   - 墊付邏輯的優先權(payer_data):
     1. 旅程預設付款人（若有設定）
     2. 記帳偏好內所提及的預設付款人
     3. 根據上述的「使用者名稱」，判斷是否可對應到某一名成員，即該成員擔任付款人。(對應關係可能會在記帳偏好中提及，但請注意務必要用「成員清單」內定義的名字)
     4. 由成員中第一位擔任付款人
   - 金額分攤邏輯的優先權(split_details):
     1. 旅程預設分攤成員（若有設定）
     2. 記帳偏好所提及的分攤方式
     3. 全員均分
6. 回傳格式由系統的 response schema 約束，type 請填 "expense"。
   payer_data 與 split_details 都是陣列，每個元素是 { "member": "成員名稱", "amount": 金額 }。
7. 如果這看起來**與消費無關**（例如：人物照、風景照、風景明信片、與消費無關的截圖），
   請回傳 type: "not_receipt"，無需任何說明或讚美，系統會自動清除照片。
   ⚠️ 但**付款成功畫面與交易通知一律視為收據**，照常回 type: "expense"：
   行動支付（LINE Pay、街口、PayPay、Suica、悠遊卡）的付款完成畫面、
   信用卡的消費通知簡訊或 App 推播、轉帳成功畫面、電子發票畫面、訂單確認頁。
   這些沒有紙本收據的品項描述，就用商店名稱或服務名稱當描述。
8. **重要限制**：若封存狀態為「已封存」，一律回傳 type: "not_receipt"，系統會另行告知使用者旅程已封存。
`

    const aiResponse = await askGemini([
      { role: "user", parts: [
        { text: ocrPrompt },
        { inlineData: { mimeType: "image/jpeg", data: base64Image } }
      ]}
    ], { models: GEMINI_OCR_MODELS, responseSchema: OCR_RESPONSE_SCHEMA, temperature: 0.2 })

    let res: OcrResponse
    try {
      res = JSON.parse(extractJSON(aiResponse))
    } catch {
      console.error('[OCR] Non-JSON response:', aiResponse.substring(0, 200))
      await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
      await replyMessage(replyToken, [{ type: 'text', text: '😅 收據辨識格式異常，請重新傳送照片。' }], sourceId)
      return
    }
    if (res.type === 'expense') {
      // normalizeExpenseAmountMaps 之後金額欄位一定是 map，才收斂成 ExpenseDraft
      const expense = res.data as ExpenseDraft

      normalizeExpenseAmountMaps(expense)

      // 成員名稱：先嘗試對應回正式名稱（暱稱、大小寫、部分符合都能救回來）。
      // 對不上的名字由 resolveExpenseMembers 從 map 裡拿掉，後面的
      // applyParticipantDefaults 會補上旅程預設 —— 照片留著、卡片照出，
      // 使用者按「✏️ 編輯」改就好（M10）。
      // 以前是刪照片、要人家重傳一次，只為了改一個名字。
      const { unresolved } = resolveExpenseMembers(expense, trip.members)
      const memberWarning = unresolved.length > 0
        ? `⚠️ 收據的分帳裡有對不上的名字：${unresolved.join('、')}\n`
          + `（目前成員：${trip.members.join('、')}）\n`
          + '已改用旅程的預設分攤，不對的話請按卡片上的「✏️ 編輯」。'
        : null
      if (unresolved.length > 0) console.warn(`[OCR] Unresolvable members: ${unresolved.join(', ')}`)

      // 幣別與日期的把關。以前這兩個欄位是 AI 講什麼就寫什麼，
      // 幻想出來的幣別會讓金額在統計時默默失真，錯誤的年份則會讓支出跑到別的月份去。
      // 幣別先走規則（T3）：AI 說 none 就一律用旅程的記帳預設幣別。
      // OCR 沒有使用者文字可以驗證 stated，所以 text 傳 null 代表直接採信。
      const ocrRule = resolveCurrencyByRule(expense.currency, expense.currency_source, null, trip)
      if (ocrRule.overrode) {
        console.log(`[CURRENCY] OCR said ${expense.currency} (source=${expense.currency_source}), using ${ocrRule.currency}`)
      }
      expense.currency = ocrRule.currency
      const ocrCurrency = normalizeCurrency(expense.currency, trip)
      if (ocrCurrency.reject) {
        // 這趟旅程沒有這個幣別的匯率。直接存下去統計會以 1:1 換算而失真，
        // 所以還是不能存 —— 但**照片要留著**（M10）。
        // 以前是連照片一起刪掉，使用者設好匯率後還得把收據重拍一次。
        // 改成把辨識結果暫存起來，附上「以 XXX 存入」的快速回覆讓他當場選一個幣別。
        const available = Object.keys(trip.rates ?? {})
        applyParticipantDefaults(expense, trip, memberName)
        const pendingNonce = Math.random().toString(36).substring(2, 10)
        await storePendingExpense(sourceId, pendingNonce, {
          exp: {
            d: expense.description, a: expense.amount, c: expense.currency,
            dt: normalizeDate(expense.date, today).date, cat: expense.category,
            p: expense.payer_data, s: expense.split_details,
          },
          p: [messageId], tid: tripId,
        })
        // 幣別按鈕 + 取消。快速回覆上限 13 顆，留一顆給取消。
        const currencyItems = available.slice(0, 12).map(cur => ({
          type: 'action',
          action: {
            type: 'postback', label: `以 ${cur} 存入`,
            data: JSON.stringify({ act: 'cur', n: pendingNonce, c: cur }),
          },
        }))
        await replyMessage(replyToken, [{
          type: 'text',
          text: `${ocrCurrency.reject}\n\n📷 收據已經先幫你留著了，選一個幣別就能直接存入（金額不會換算）。`,
          quickReply: {
            items: [
              ...currencyItems,
              { type: 'action', action: { type: 'postback', label: '❌ 取消', data: JSON.stringify({ act: 'cancel', n: pendingNonce }) } },
            ],
          },
        }], sourceId)
        return
      }
      expense.currency = ocrCurrency.currency
      const ocrDate = normalizeDate(expense.date, today)
      expense.date = ocrDate.date
      // 分類也要驗（M18）：AI 回「美食」但旅程只有「餐飲」時，
      // 以前會原封不動存進去，網頁的分類統計就多出一個永遠選不到的欄位（F7）。
      const ocrCategory = resolveCategory(expense.category, trip.categories, trip.default_category)
      expense.category = ocrCategory.category
      const ocrWarnings = [memberWarning, ocrCurrency.warning, ocrCategory.warning, ocrDate.warning].filter(Boolean) as string[]

      // AI 偶爾會回空的付款人或分攤，卡片會出現整片空白的區塊，
      // 按下確認才在 Σ 檢查那裡爆掉。先套上與網頁快速記帳一致的預設值（H6）。
      // 補上的預設值只是 0 佔位：分配時必須改傳 {} 當 lockedData，
      // 否則 0 會被 calculateDistribution 當成「鎖定金額」，整筆餘額落到調整成員身上。
      const { filledPayer, filledSplit } = applyParticipantDefaults(expense, trip, memberName)

      const precision = (trip?.precision_config as PrecisionConfig | null)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
      expense.amount = new Decimal(expense.amount || 0).toDecimalPlaces(precision).toNumber()
      const payerMembers = Object.keys(expense.payer_data)
      const splitMembers = Object.keys(expense.split_details)
      const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
      if (payerMembers.length > 0) {
        expense.payer_data = calculateDistribution(expense.amount, payerMembers, filledPayer ? {} : expense.payer_data, payerMembers[0], precision)
      }
      if (splitMembers.length > 0) {
        expense.split_details = calculateDistribution(expense.amount, splitMembers, filledSplit ? {} : expense.split_details, adjustMember, precision)
      }

      const photo_ids = [messageId]
      const nonce = Math.random().toString(36).substring(2, 10)
      const exp_short = {
        d: expense.description, a: expense.amount, c: expense.currency,
        dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
      }

      // ⚠️ 這裡刻意不讓舊草稿失效。一次選兩張收據送出時，
      //    第二張會讓第一張作廢，使用者只記得到最後一張（H1、H7）。
      //    卡片失效只發生在 AI 明確指出「這句是在修正某張草稿」的時候。
      await storePendingExpense(sourceId, nonce, { exp: exp_short, p: photo_ids, tid: tripId })

      // 摘要要帶 nonce：AI 才有辦法用 corrects_draft 指名它要修正哪一張卡片
      const historySummary = `[記帳建議] ${JSON.stringify({ ...expense, photo_ids, nonce }, null, 2)}`
      runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary }))

      const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
      // 草稿卡片的「✏️ 編輯」只帶 nonce，完整內容 LiffEdit 自己去 pending 列撈（T2）
      const liffUrl = buildDraftLiffUrl(trip.id, nonce, sourceId)

      // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西
      const ocrWarningMsg = ocrWarnings.length > 0
        ? [{ type: 'text' as const, text: ocrWarnings.join('\n') }]
        : []

      await replyMessage(replyToken, [...ocrWarningMsg, buildExpenseCard({
        expense,
        title: "🔍 AI 辨識結果",
        altText: `收據辨識預覽: ${expense.description}`,
        heroUrl: publicUrl,
        nonce, webUrl, liffUrl,
      })], sourceId)
    } else if (res.type === 'not_receipt') {
      console.log(`[PHOTO] Not a receipt, deleting: ${filePath}`)
      await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
      // 群組維持靜默（大家常在群裡貼風景照，不該每張都被機器人回一句），
      // 但一對一非回不可 —— 使用者傳了照片卻什麼都沒發生，
      // 根本不知道是沒收到、當機了、還是被判定不是收據（M8）。
      if (!isGroup) {
        await replyMessage(replyToken, [{
          type: 'text',
          text: '🤔 這張看起來不是收據，所以我沒有記帳（照片也沒有留下）。\n\n'
            + '如果要記這一筆，直接打字就可以，例如「晚餐 300」。\n'
            + '行動支付的付款完成畫面、信用卡消費通知截圖我也讀得懂，可以再試一次。',
          quickReply: boundQR,
        }], sourceId)
      }
    } else {
      console.log(`[PHOTO] Non-expense photo response, deleting: ${filePath}`)
      await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
      await replyMessage(replyToken, [{ type: 'text', text: res.content || '抱歉，這張照片我辨識不出來。' }], sourceId)
    }
  } catch (e) {
    console.error('[OCR_ERROR]', e)
    await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
    const msg = isRateLimit(e) ? RATE_LIMIT_MSG : '😵 處理圖片時發生錯誤，請稍後再試。'
    await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
  }
}
