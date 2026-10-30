// ============================================================
// handlers/image.ts —— 收據照片的 OCR 路徑
//
// 下載 → 上傳 Storage → AI OCR（ai.ts 決定用哪一家）→ 驗證（成員／幣別／分類／日期）→ 出卡片。
//
// 照片分三種（OCR_RESPONSE_SCHEMA 的 type）：
//   expense     收據、付款畫面 → 照常辨識金額
//   item_photo  不是收據但拍的是可以記帳的東西（食物、商品、門票…）→ 判斷是什麼、金額填 0，
//               卡片只有「✏️ 填金額」沒有「✅ 確認存入」，使用者到編輯頁補上金額才存得進去
//   not_receipt 認不出是什麼 → 照片照樣留著，出一張描述與金額都空白的卡片讓使用者自己填。
//               AI 回了壞掉的格式、或根本沒回應（額度、忙碌、逾時）時也一樣（使用者要求：上傳的照片不要丟）。
//
// ⚠️ 照片一旦上傳就要負責清乾淨：處理過程拋出 AI 以外的例外時（上傳失敗、回覆失敗…），
//    要把 filePath 從 bucket 移除，否則會留下沒有支出指向它的孤兒照片。
//    卡片出去之後由「❌ 取消」負責刪照片。
// ============================================================

import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { extractJSON } from "../guards.ts"
import { prepareExpense } from "../../_shared/tools/expenses.ts"
import { aiUnavailableMessage, FALLBACK_NOTICES, RECEIPTS_BUCKET, WEBAPP_URL } from "../config.ts"
import { type EventContext, extendFollowup, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import { storePendingExpense } from "../drafts.ts"
import { ai, OCR_RESPONSE_SCHEMA } from "../ai.ts"
import { downloadLineContent, replyMessage, showLoading } from "../line-api.ts"
import { buildDraftLiffUrl, buildExpenseCard } from "../messages.ts"
import { runInBackground } from "../util.ts"
import type { ExpenseInput } from "../../_shared/tools/types.ts"
import type { ImageMessageEvent, OcrResponse } from "../types.ts"

/** 處理一張收據照片。呼叫端已經確認 ctx.isBound。 */
export async function handleImage(ctx: EventContext, event: ImageMessageEvent): Promise<void> {
  const { boundQR, memberName, replyToken, sourceId, userState } = ctx

  const messageId = event.message.id

  // 群組靜音模式：照片完全不碰（不下載、不辨識、不回覆）。
  // 有人問「怎麼沒反應」時，AI 的 context 裡有目前的模式，答得出來（ai-text.ts）。
  if (ctx.isGroup && ctx.groupMode === 'silent') {
    console.log(`[IMAGE] Group is in silent mode, ignoring messageId: ${messageId}`)
    return
  }

  if (!userState?.current_trip_id) {
    await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程，再傳送收據照片喔！' }], sourceId)
    return
  }

  // 一對一顯示「輸入中…」：下載、上傳、辨識加起來常常要好幾秒
  runInBackground(showLoading(sourceId))

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
     0. **照片上看得到是誰付的錢**，而且對得上成員清單裡的某一位 → 就是那位成員，優先於下面所有規則。
        例如訂位／訂單確認信的「親愛的吳艷櫻先生/小姐」、訂購人、持卡人、付款帳號名稱、轉帳的付款方、簽名欄。
        照片上常是全名，成員清單常只寫名字或暱稱（「吳艷櫻」→「艷櫻」），請對應到清單上的正式名稱。
        ⚠️ 傳照片的人只是轉傳，不代表是他付的 —— 照片上的證據比「使用者名稱」可靠。
        收款方、店家、服務人員的名字不算；看到的名字對不上任何成員就跳過這一條。
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
7. 照片分三種，type 請照實回報：
   a. **收據或付款證明** → type: "expense"，照上面的規則辨識金額。
   b. **不是收據，但拍的是可以記帳的東西**：食物、飲料、甜點、商品、紀念品、門票、
      餐廳或店家的門面、菜單、價目表 → type: "item_photo"。
      - description 寫出「這是什麼」：菜名、商品名或店名，看得出外文就照規則 3 保留原文加中文說明，
        例如「一蘭ラーメン (拉麵)」、「抹茶霜淇淋」、「東京鐵塔紀念磁鐵」。看不出具體名稱就寫類別，例如「拉麵」。
      - category 依照片內容挑最接近的分類；date 填今日。
      - 🚫 **不要猜金額**，就算照片上看得到價格也一樣 —— 金額會留空，使用者自己填實際付的錢。
        amount 與 payer_data、split_details 裡每個人的 amount 一律填 0（系統會當成「還沒填」），
        成員一樣照規則 5 決定。
   c. **看不出是可以記帳的東西**（人物照、風景照、與消費無關的截圖）→ type: "not_receipt"，
      無需任何說明或讚美，系統會保留照片、讓使用者自己填內容。拿不準是 b 還是 c 時，照片主體是可以買的東西就選 b。
   ⚠️ **付款成功畫面與交易通知一律視為收據**，照常回 type: "expense"：
   行動支付（LINE Pay、街口、PayPay、Suica、悠遊卡）的付款完成畫面、
   信用卡的消費通知簡訊或 App 推播、轉帳成功畫面、電子發票畫面、訂單確認頁。
   這些沒有紙本收據的品項描述，就用商店名稱或服務名稱當描述。
8. **重要限制**：若封存狀態為「已封存」，一律回傳 type: "not_receipt"，系統會另行告知使用者旅程已封存。
`

    // 認不出來、格式壞掉、AI 沒回應都不丟照片，改出一張空白卡讓使用者自己填
    let busyNote: string | null = null
    // 主要的 AI 失敗、改由備援辨識時要說一聲（FALLBACK_NOTICES）
    let fallbackNotice: string | null = null
    let res: OcrResponse
    try {
      const aiResponse = await ai.generate({
        task: 'vision',
        messages: [{ role: 'user', parts: [
          { text: ocrPrompt },
          { media: { mimeType: 'image/jpeg', data: base64Image } },
        ]}],
        json: true,
        schema: OCR_RESPONSE_SCHEMA,
        temperature: 0.2,
        onFallback: (reason) => { fallbackNotice = FALLBACK_NOTICES[reason] },
      })
      try {
        res = JSON.parse(extractJSON(aiResponse))
      } catch {
        console.error('[OCR] Non-JSON response:', aiResponse.substring(0, 200))
        res = { type: 'not_receipt' }
      }
    } catch (e) {
      // 額度用完、忙碌、逾時或任何其他錯誤：告訴使用者 AI 沒回應，但照片與卡片照出
      console.warn('[OCR] AI did not answer, keeping the photo as a blank card:', e)
      busyNote = aiUnavailableMessage(e) ?? '😵 AI 這次沒有回應。'
      res = { type: 'not_receipt' }
    }
    const unidentified = res.type !== 'expense' && res.type !== 'item_photo'
    if (unidentified) {
      console.log(`[PHOTO] Could not identify (${res.type}), keeping it as a blank card: ${filePath}`)
      res = { type: 'item_photo', data: { description: '' } }
    }
    if (res.type === 'expense' || res.type === 'item_photo') {
      // 品項照片的金額留空：不管模型填了什麼都當成「還沒填」（草稿裡以 0 占位），
      // 卡片上不給「確認存入」，使用者一定要到編輯頁補上金額（commitExpense 也會擋 0 元，雙重保險）
      const needsAmount = res.type === 'item_photo'
      if (needsAmount) {
        res.data = { ...(res.data ?? {}), amount: 0 } as typeof res.data
        console.log(`[PHOTO] Item photo (no amount yet): ${String(res.data?.description ?? '')}`)
      }
      // 驗證與分帳整段走共用工具層（_shared/tools/expenses.ts），與文字路徑、
      // 「確認存入」用的是同一份實作 —— 以前這段在三個地方各寫一次。
      // OCR 沒有使用者文字可以驗證 stated，sourceText 傳 null 代表直接採信（T3）。
      const prepared = prepareExpense(
        (res.data ?? {}) as unknown as ExpenseInput,
        trip,
        { today, actorName: memberName, sourceText: null },
      )
      const expense = prepared.expense

      // 成員名稱：prepareExpense 會先嘗試對應回正式名稱（暱稱、大小寫、部分符合
      // 都能救回來），對不上的從 map 裡拿掉並補上旅程預設 —— 照片留著、卡片照出，
      // 使用者按「✏️ 編輯」改就好（M10）。
      // 以前是刪照片、要人家重傳一次，只為了改一個名字。
      const unresolved = prepared.unresolvedMembers
      const memberWarning = unresolved.length > 0
        ? `⚠️ 收據的分帳裡有對不上的名字：${unresolved.join('、')}\n`
          + `（目前成員：${trip.members.join('、')}）\n`
          + '已改用旅程的預設分攤，不對的話請按卡片上的「✏️ 編輯」。'
        : null
      if (unresolved.length > 0) console.warn(`[OCR] Unresolvable members: ${unresolved.join(', ')}`)

      if (prepared.reject) {
        // 這趟旅程沒有這個幣別的匯率。直接存下去統計會以 1:1 換算而失真，
        // 所以還是不能存 —— 但**照片要留著**（M10）。
        // 以前是連照片一起刪掉，使用者設好匯率後還得把收據重拍一次。
        // 改成把辨識結果暫存起來，附上「以 XXX 存入」的快速回覆讓他當場選一個幣別。
        // （prepareExpense 被拒時仍回傳正規化好的內容，所以這裡直接存得下去。）
        const available = Object.keys(trip.rates ?? {})
        const pendingNonce = Math.random().toString(36).substring(2, 10)
        await storePendingExpense(sourceId, pendingNonce, {
          exp: {
            d: expense.description, a: expense.amount, c: expense.currency,
            dt: expense.date, cat: expense.category,
            p: expense.payer_data, s: expense.split_details,
          },
          p: [messageId], rc: !needsAmount, tid: tripId,
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
          text: `${fallbackNotice ? `${fallbackNotice}\n\n` : ''}${prepared.reject}\n\n📷 收據已經先幫你留著了，選一個幣別就能直接存入（金額不會換算）。`,
          quickReply: {
            items: [
              ...currencyItems,
              { type: 'action', action: { type: 'postback', label: '❌ 取消', data: JSON.stringify({ act: 'cancel', n: pendingNonce }) } },
            ],
          },
        }], sourceId)
        return
      }
      // 幣別、日期、分類的把關與付款人／分攤的預設值都在 prepareExpense 裡做完了
      // （幻想出來的幣別會讓金額在統計時默默失真，錯誤的年份會讓支出跑到別的月份去，
      //  不存在的分類會在網頁統計多出一個永遠選不到的欄位 —— M18、F7）。
      // 成員警告是 OCR 專屬的，排在最前面。
      const ocrWarnings = [memberWarning, ...prepared.warnings].filter(Boolean) as string[]

      const photo_ids = [messageId]
      const nonce = Math.random().toString(36).substring(2, 10)
      const exp_short = {
        d: expense.description, a: expense.amount, c: expense.currency,
        dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
      }

      // ⚠️ 這裡刻意不讓舊草稿失效。一次選兩張收據送出時，
      //    第二張會讓第一張作廢，使用者只記得到最後一張（H1、H7）。
      //    卡片失效只發生在 AI 明確指出「這句是在修正某張草稿」的時候。
      await storePendingExpense(sourceId, nonce, { exp: exp_short, p: photo_ids, rc: !needsAmount, tid: tripId })

      // 摘要要帶 nonce：AI 才有辦法用 corrects_draft 指名它要修正哪一張卡片
      const historySummary = `[記帳建議] ${JSON.stringify({ ...expense, photo_ids, nonce }, null, 2)}`
      runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary }))

      const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
      // 草稿卡片的「✏️ 編輯」只帶 nonce，完整內容 LiffEdit 自己去 pending 列撈（T2）
      const liffUrl = buildDraftLiffUrl(trip.id, nonce, sourceId)

      // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西
      // AI 全忙時多說一句為什麼卡片是空的
      const notes = [
        ...(fallbackNotice ? [fallbackNotice] : []),
        ...(busyNote ? [`${busyNote}\n照片先幫你留著了，可以按卡片上的「✏️ 填寫內容」自己填。`] : []),
        ...ocrWarnings,
      ]
      const ocrWarningMsg = notes.length > 0
        ? [{ type: 'text' as const, text: notes.join('\n') }]
        : []

      await replyMessage(replyToken, [...ocrWarningMsg, buildExpenseCard({
        expense,
        title: needsAmount ? "📷 照片記帳" : "🔍 AI 辨識結果",
        altText: unidentified
          ? '照片記帳（請填寫內容與金額）'
          : needsAmount ? `照片記帳（還沒填金額）: ${expense.description}` : `收據辨識預覽: ${expense.description}`,
        heroUrl: publicUrl,
        nonce, webUrl, liffUrl, needsAmount, unidentified,
      })], sourceId)
      // 傳完照片接著打「這是抹茶冰淇淋 600」來補充，群組的提及模式下也不必再 @
      extendFollowup(ctx)
    }
  } catch (e) {
    console.error('[OCR_ERROR]', e)
    await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
    const msg = aiUnavailableMessage(e) ?? '😵 處理圖片時發生錯誤，請稍後再試。'
    await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
  }
}
