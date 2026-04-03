import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"
import { decode, encode } from "https://deno.land/std@0.168.0/encoding/base64.ts"
import Decimal from "https://esm.sh/decimal.js@10.4.3"

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') || ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const BOT_SELF_INTRODUCTION = `您好！我是您的旅遊記帳小幫手「耀西」
您可以透過自然語言對我下指令，或是上傳收據照片，我會自動幫您處理記帳！

📍 綁定旅程：
1. 輸入「ID:您的旅程代碼」
(可從網站設定頁面取得)
2. 輸入「旅程密碼」
3. 綁定後，我會列出目前的成員供您確認。

⚙️ 個人偏好設定：
• 可輸入「設定:預設代杰付款，所有人均分金額。」
(可記錄最後一筆設定，設定後 AI 會參考您的習慣進行解析)

💰 快速記帳相關功能：
• 基礎：可直接說「晚餐 1200」
• 收據分析：直接上傳照片
• 指定付款：說「代杰付了Uber 300」
• 複雜分帳：說「拉麵 3000 日幣，代杰先付，大家平分」
• 修正記帳：說「剛剛那筆改 500」

💡 群組提醒：
問我問題時，請"@提及"我，或是喊「耀西」喚醒我，不然我平常都躲在蛋裡睡覺唷！
Yoshi! Yoshi!
`

/**
 * 同步 Webapp 的餘數校正邏輯 (from src/utils/finance.ts)
 */
function calculateDistribution(
  total: number,
  activeMembers: string[],
  lockedData: Record<string, number> = {},
  adjustmentMember: string | null = null,
  precision: number = 2
): Record<string, number> {
  const result: Record<string, Decimal> = {};
  if (activeMembers.length === 0) return {};

  const dTotal = new Decimal(total || 0);
  let remainingAmount = dTotal;
  
  const unlockedActiveMembers = activeMembers.filter(m => {
    if (lockedData[m] !== undefined) {
      const lockedVal = new Decimal(lockedData[m]);
      result[m] = lockedVal;
      remainingAmount = remainingAmount.minus(lockedVal);
      return false;
    }
    return true;
  });

  if (unlockedActiveMembers.length > 0) {
    const share = remainingAmount.dividedBy(unlockedActiveMembers.length).toDecimalPlaces(precision, Decimal.ROUND_DOWN);
    unlockedActiveMembers.forEach(m => {
      result[m] = share;
      remainingAmount = remainingAmount.minus(share);
    });

    if (!remainingAmount.isZero()) {
      const target = (adjustmentMember && unlockedActiveMembers.includes(adjustmentMember)) 
        ? adjustmentMember 
        : unlockedActiveMembers[0];
      result[target] = result[target].plus(remainingAmount);
    }
  } else if (!remainingAmount.isZero()) {
    const target = (adjustmentMember && activeMembers.includes(adjustmentMember))
      ? adjustmentMember
      : activeMembers[0];
    if (result[target]) {
      result[target] = result[target].plus(remainingAmount);
    } else {
      result[target] = remainingAmount;
    }
  }

  const finalResult: Record<string, number> = {};
  Object.keys(result).forEach(m => {
    finalResult[m] = result[m].toNumber();
  });
  return finalResult;
}

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !LINE_CHANNEL_SECRET) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return await crypto.subtle.verify('HMAC', key, decode(signature), encoder.encode(body))
}

async function replyMessage(replyToken: string, messages: any[]) {
  console.log(`[LINE] Replying to ${replyToken}...`)
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) console.error(`[LINE] Reply Error: ${await res.text()}`)
}

async function askGemini(contents: any[]) {
  console.log(`[AI] Calling Gemini 3.1 Flash Lite Preview...`)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_API_KEY}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { response_mime_type: "application/json" } })
  })
  const data = await response.json()
  return data.candidates[0].content.parts[0].text
}

serve(async (req) => {
  try {
    const signature = req.headers.get('x-line-signature')
    const bodyText = await req.text()
    if (!(await verifySignature(bodyText, signature))) return new Response('Unauthorized', { status: 401 })

    const { events } = JSON.parse(bodyText)
    for (const event of events) {
      console.log(`[EVENT_RAW] Received event type: ${event.type}`)
      
      const replyToken = event.replyToken
      const sourceId = event.source.groupId || event.source.roomId || event.source.userId
      const sourceType = event.source.type
      const isGroup = sourceType !== 'user'

      console.log(`[SOURCE] ID: ${sourceId}, Type: ${sourceType}, isGroup: ${isGroup}`)

      // --- 取得或初始化使用者狀態 ---
      let { data: userState } = await supabase.from('line_user_states').select('*').eq('line_user_id', sourceId).maybeSingle()
      if (!userState) {
        console.log(`[DB] Registering new state for sourceId: ${sourceId}`)
        const { data: newState } = await supabase.from('line_user_states').insert({ line_user_id: sourceId }).select().single()
        userState = newState
      }
      const isBinding = !!(userState?.pending_trip_id && !userState?.current_trip_id)
      const isBound = !!userState?.current_trip_id

      // --- 樣板訊息處理 ---
      if (isBound && (event.type === 'postback')) {
        const postbackData = JSON.parse(event.postback.data)
        console.log(`[POSTBACK] Data: ${event.postback.data}`)
        const nonce = postbackData.nonce
        if (nonce) {
          const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
          if (processed) {
            console.log(`[POSTBACK] Rejected: Nonce ${nonce} already processed`)
            await replyMessage(replyToken, [{ type: 'text', text: `⚠️ 此操作已處理過囉！` }]); continue
          }
        }
        if (postbackData.action === 'save_expense' || postbackData.act === 'save') {
          const { n: nonce_short, expense: exp_old, exp: exp_new, photo_urls: p_old, p: p_new } = postbackData
          const nonce = nonce_short || postbackData.nonce
          const expenseRaw = exp_new || exp_old || postbackData.expense
          const photo_ids = p_new || p_old || postbackData.photo_urls || []
          
          if (nonce) {
            const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
            if (processed) {
              await replyMessage(replyToken, [{ type: 'text', text: `⚠️ 此操作已處理過囉！` }]); continue
            }
          }

          // 取得 trip_id (從 state 抓取以節省 payload 空間)
          let { data: userState } = await supabase.from('line_user_states').select('current_trip_id').eq('line_user_id', sourceId).maybeSingle()
          const trip_id = postbackData.trip_id || userState?.current_trip_id
          if (!trip_id) {
            await replyMessage(replyToken, [{ type: 'text', text: `❌ 找不到對應旅程，請重新綁定。` }]); continue
          }

          // 解析簡寫欄位
          const expense = {
            description: expenseRaw.d || expenseRaw.description,
            amount: expenseRaw.a || expenseRaw.amount,
            currency: expenseRaw.c || expenseRaw.currency,
            date: expenseRaw.dt || expenseRaw.date,
            category: expenseRaw.cat || expenseRaw.category,
            payer_data: expenseRaw.p || expenseRaw.payer_data,
            split_details: expenseRaw.s || expenseRaw.split_details
          }

          // 重組圖片路徑 (如果是簡寫格式只傳 messageId)
          const photo_urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)

          // --- 金額精度與總額校驗 ---
          const { data: trip } = await supabase.from('trips').select('precision_config, members').eq('id', trip_id).single()
          const precision = (trip?.precision_config as any)?.[expense.currency] ?? (expense.currency === 'TWD' ? 0 : 2)
          
          const numAmount = parseFloat(expense.amount as any) || 0
          
          const payerMembers = Object.keys(expense.payer_data).filter(m => trip.members.includes(m))
          const splitMembers = Object.keys(expense.split_details).filter(m => trip.members.includes(m))

          const finalPayerData = calculateDistribution(numAmount, payerMembers, expense.payer_data, payerMembers[0], precision)
          const finalSplitData = calculateDistribution(numAmount, splitMembers, expense.split_details, splitMembers[0], precision)

          const checkSum = (data: any) => Object.values(data).reduce((a: Decimal, b: any) => a.plus(new Decimal(b)), new Decimal(0))
          const payerSum = checkSum(finalPayerData)
          const splitSum = checkSum(finalSplitData)
          const target = new Decimal(numAmount).toDecimalPlaces(precision)

          if (!payerSum.equals(target) || !splitSum.equals(target)) {
            console.error(`[CRITICAL_VALIDATION_ERROR] Sum mismatch. P:${payerSum}, S:${splitSum}, T:${target}`)
            await replyMessage(replyToken, [{ type: 'text', text: `❌ 財務運算發生錯誤，請聯絡管理員。` }])
            continue
          }

          if (nonce) await supabase.from('line_processed_actions').insert({ nonce, line_user_id: sourceId, action_type: 'save' })
          await supabase.from('expenses').insert({
            trip_id: trip_id, description: expense.description, amount: target.toNumber(), currency: expense.currency,
            payer_data: finalPayerData, split_data: finalSplitData, date: expense.date, category: expense.category,
            photo_urls: photo_urls,
            adjustment_member: splitMembers[0]
          })
          await replyMessage(replyToken, [{ type: 'text', text: `✅ 已存入：${expense.description}` }])
        } else if (postbackData.action === 'cancel' || postbackData.act === 'cancel') {
          const nonce = postbackData.n || postbackData.nonce
          const photo_ids = postbackData.p || postbackData.photo_urls || []

          if (photo_ids.length > 0) {
            const { data: userState } = await supabase.from('line_user_states').select('current_trip_id').eq('line_user_id', sourceId).maybeSingle()
            const trip_id = postbackData.trip_id || userState?.current_trip_id
            if (trip_id) {
              const urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)
              console.log(`[PHOTO] Remove photo URL: ${urls}`)
              await supabase.storage.from('travel-images').remove(urls)
            }
          }

          if (nonce) await supabase.from('line_processed_actions').insert({ nonce, line_user_id: sourceId, action_type: 'cancel' })
          await replyMessage(replyToken, [{ type: 'text', text: photo_ids.length > 0 ? '❌ 已取消並刪除照片。' : '❌ 已取消。' }])
        }

        continue
      }

      // --- 圖片處理 (收據 OCR) ---
      if (isBound && (event.type === 'message' && event.message.type === 'image')) {
        const messageId = event.message.id
        let { data: userState } = await supabase.from('line_user_states').select('*').eq('line_user_id', sourceId).maybeSingle()
        
        if (!userState?.current_trip_id) {
          await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程，再傳送收據照片喔！' }])
          continue
        }

        try {
          // 1. 下載 LINE 圖片
          console.log(`[IMAGE] Downloading messageId: ${messageId}`)
          const lineRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
            headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
          })
          if (!lineRes.ok) throw new Error('Failed to download image from LINE')
          const imageBuffer = await lineRes.arrayBuffer()

          // 2. 上傳至 Supabase Storage (同步 Webapp 路徑)
          const tripId = userState.current_trip_id
          const filePath = `expenses/${tripId}/${messageId}.jpg`
          console.log(`[STORAGE] Uploading to: ${filePath}`)
          const { error: uploadErr } = await supabase.storage.from('travel-images').upload(filePath, imageBuffer, {
            contentType: 'image/jpeg', upsert: true
          })
          if (uploadErr) throw uploadErr

          // 取得公開 URL 用於 Flex Message 預覽
          const { data: { publicUrl } } = supabase.storage.from('travel-images').getPublicUrl(filePath)

          // 3. Gemini OCR 解析
          const { data: trip } = await supabase.from('trips').select('*').eq('id', tripId).single()
          const base64Image = encode(new Uint8Array(imageBuffer))
          const today = new Date().toISOString().split('T')[0]

          const ocrPrompt = `
### 你的身份
你是一位專業又貼心的旅遊記帳小幫手「耀西」，是瑪利歐系列的一位知名角色。
在遊戲中的叫聲通常是高亢、可愛的「Yoshi! Yoshi!」或「嗯——嗯！」，與使用者聊天時，偶爾可以適當穿插這樣的叫聲。

### 你的任務
這是一張消費收據或發票的照片。請扮演專業的記帳小幫手並進行解析。

### 背景資訊
- 旅程：${trip.name} (網址: https://dave851221.github.io/travel-ledger-webapp/#/trip/${tripId}/dashboard)
- 成員：${trip.members.join(', ')}
- 分類：${trip.categories.join(', ')} (預設: ${trip.default_category || '無'})
- 幣別與匯率：${JSON.stringify(trip.rates)} (主要幣別: ${trip.base_currency}, 預設: ${trip.default_currency || '無'})
- 今日：${today}
- 封存狀態：${trip.is_archived ? '已封存 (唯讀)' : '進行中'}
- 使用者設定：${userState.default_config || '無'}

### 任務規則
1. 辨識「總金額」與「幣別」。請從符號、地址或語系推斷幣別 (例如：¥/JPY, $/USD, NT/TWD, €/EUR)。
   - 若無法從收據辨識出幣別，或是使用者沒提及，才可以使用預設幣別。
2. 辨識「日期」。若收據上無明確日期，請使用今日。
3. 辨識「品項描述」。提取商店名稱或主要品項。若是外文請保留原文，並在括號內加上簡單的繁體中文翻譯 (例如：一蘭ラーメン(拉麵))。
4. 辨識「分類」。若無法判別，可以先看是否有"其他"類別，若無"其他"類別可優先使用預設分類。
5. 請先詳讀「使用者設定」，再來決定 payer_data (墊付) 與 split_details (應付)。
   - 以使用者設定內定義的分攤方式為主，若使用者設定中無明確指示，預設由「第一位成員」墊付，且「全員均分」。
   - 分帳時盡量不要有小數點(除非總金額有小數點)，按照使用者需求分配後，請務必確保總數加起來相等。
6. 必須回傳 JSON：
{
  "type": "expense",
  "data": {
    "description": "品項描述",
    "amount": 數字,
    "currency": "ISO代碼",
    "date": "YYYY-MM-DD",
    "category": "從分類清單中挑選最接近的一個",
    "payer_data": { "成員": 金額 },
    "split_details": { "成員": 金額 }
  }
}
7. 如果這看起來完全不像收據，請回傳：{"type": "chat", "content": "盡量說讚美的話，給予情緒價值，但字不要太多，一兩句話就足夠。"}
8. **重要限制**：若封存狀態為「已封存」，嚴禁回傳 type: "expense"，請告知使用者旅程已封存無法記帳，但可以繼續分析或聊天。
`

          const aiResponse = await askGemini([
            { role: "user", parts: [
              { text: ocrPrompt },
              { inlineData: { mimeType: "image/jpeg", data: base64Image } }
            ]}
          ])

          const res = JSON.parse(aiResponse)
          if (res.type === 'expense') {
            const expense = res.data

            // --- 修正餘數 ---
            const precision = (trip?.precision_config as any)?.[expense.currency] ?? (expense.currency === 'TWD' ? 0 : 2)
            const payerMembers = Object.keys(expense.payer_data)
            const splitMembers = Object.keys(expense.split_details)
            if (payerMembers.length > 0) {
              expense.payer_data = calculateDistribution(expense.amount, payerMembers, expense.payer_data, payerMembers[0], precision)
            }
            if (splitMembers.length > 0) {
              expense.split_details = calculateDistribution(expense.amount, splitMembers, expense.split_details, splitMembers[0], precision)
            }

            // --- 儲存至對話歷史 ---
            const photo_ids = [messageId]
            const historySummary = `[記帳建議] ${JSON.stringify({ ...expense, photo_ids }, null, 2)}`
            await supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary })

            // 縮減 expense 物件鍵名以節省空間
            const exp_short = {
              d: expense.description, a: expense.amount, c: expense.currency,
              dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
            }
            const nonce = Math.random().toString(36).substring(2, 10) // 更短的 nonce

            await replyMessage(replyToken, [{
              type: "flex", altText: `收據辨識預覽: ${expense.description}`,
              contents: {
                type: "bubble",
                hero: {
                  type: "image", url: publicUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover"
                },
                body: {
                  type: "box", layout: "vertical",
                  contents: [
                    { type: "text", text: "🔍 AI 辨識結果", weight: "bold", color: "#1DB446", size: "sm" },
                    { type: "text", text: String(expense.description), weight: "bold", size: "xl", margin: "md", wrap: true },
                    { type: "text", text: `📅 ${expense.date} · 🏷️ ${expense.category}`, size: "xs", color: "#aaaaaa", margin: "xs" },
                    { type: "separator", margin: "md" },
                    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
                      { type: "box", layout: "horizontal", contents: [{ type: "text", text: "總金額", color: "#aaaaaa", size: "sm" }, { type: "text", text: `${expense.amount} ${expense.currency}`, align: "end", size: "sm", weight: "bold" }] },
                      { type: "box", layout: "vertical", margin: "sm", contents: [
                        { type: "text", text: "付款人", color: "#aaaaaa", size: "xs" },
                        ...Object.entries(expense.payer_data).map(([name, amt]) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: `• ${name}`, size: "xs", color: "#666666" }, { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }] }))
                      ]},
                      { type: "box", layout: "vertical", margin: "sm", contents: [
                        { type: "text", text: "分帳明細 (應付)", color: "#aaaaaa", size: "xs" },
                        ...Object.entries(expense.split_details).map(([name, amt]) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: `• ${name}`, size: "xs", color: "#666666" }, { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }] }))
                      ]}
                    ]}
                  ]
                },
                footer: {
                  type: "box", layout: "vertical", spacing: "sm",
                  contents: [
                    { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: "✅ 確認存入", data: JSON.stringify({ act: "save", exp: exp_short, p: photo_ids, n: nonce }) } },
                    { type: "button", style: "secondary", action: { type: "postback", label: "❌ 取消", data: JSON.stringify({ act: "cancel", p: typeof photo_ids !== 'undefined' ? photo_ids : [], n: nonce }) } }
                  ]
                }
              }
            }])
          } else {
            // 如果辨識失敗或不是收據，刪除已上傳的照片
            console.log(`[PHOTO] Not a receipt or unrecognized, deleting: ${filePath}`)
            await supabase.storage.from('travel-images').remove([filePath])
            await replyMessage(replyToken, [{ type: 'text', text: res.content || '抱歉，這張照片我辨識不出來。' }])
          }
        } catch (e) {
          console.error('[OCR_ERROR]', e)
          await replyMessage(replyToken, [{ type: 'text', text: '😵 處理圖片時發生錯誤。' }])
        }
        continue
      }

      // --- 非文字訊息則跳過處理 ---
      if (event.type !== 'message' || event.message.type !== 'text') {
        console.log(`[SKIP] Not a text message event.`)
        continue
      }

      // --- 接下來僅為文字訊息處理 ---
      const userText = event.message.text.trim()
      console.log(`[USER_TEXT] "${userText}"`)

      // 群組內喚醒邏輯
      const isMentioned = event.message.mention?.mentionees?.some((m: any) => m.isSelf === true)
      const isIdCommand = userText.toUpperCase().startsWith('ID:') || userText.toUpperCase().startsWith('ID：')
      const isManagement = userText.startsWith('設定') || userText === '斷開' || userText === '切換旅程'
      
      let shouldProcess = !isGroup
      if (isGroup) {
        if (isMentioned) {
          // 有 Tag 機器人，一律處理
          shouldProcess = true
        } else if (userText.includes('耀西')) {
          // 如果訊息包含「耀西」，一律處理
          shouldProcess = true
        } else if (!isBound) {
          // 尚未正式綁定時：
          // - 如果輸入 ID:XXX (啟動綁定) -> 處理
          // - 如果正在等密碼 (isBinding) -> 處理
          if (isIdCommand || isBinding) {
            shouldProcess = true
          }
        } else if (isBound && (isIdCommand || isManagement)) {
          // 已經綁定旅程時：
          // - 如果要進行設定 -> 處理
          // - 要斷開旅程 -> 處理
          shouldProcess = true
        }
        // 如果 isBound (已綁定) 且沒被 Tag 或被叫耀西，也沒有要設定，則 shouldProcess 為 false (不反應)
      }

      if (!shouldProcess) {
        console.log(`[SKIP] Group message without trigger/mention.`)
        continue
      }

      const cleanText = userText.replace(/@\S+\s*/g, '').replace(/^耀西\s*/, '').trim()

      // 1. ID 綁定
      if (cleanText.toUpperCase().startsWith('ID:') || cleanText.toUpperCase().startsWith('ID：')) {
        if (userState?.current_trip_id) {
          await replyMessage(replyToken, [{ type: 'text', text: '⚠️ 目前已綁定旅程。請先輸入「斷開」後再重新綁定。' }]); continue
        }
        const linebotId = cleanText.substring(3).trim().toUpperCase()
        const { data: mapping } = await supabase.from('line_trip_id_mapping').select('trip_id').eq('linebot_id', linebotId).maybeSingle()
        if (mapping) {
          await supabase.from('line_user_states').update({ pending_trip_id: mapping.trip_id, current_trip_id: null }).eq('line_user_id', sourceId)
          await replyMessage(replyToken, [{ type: 'text', text: '🔍 已找到旅程！請輸入密碼驗證。' }])
        } else {
          await replyMessage(replyToken, [{ type: 'text', text: `❌ 找不到代碼 [${linebotId}]` }])
        }
        continue
      }

      // 2. 斷開
      if (isBound && (cleanText === '斷開' || cleanText === '切換旅程')) {
        await supabase.from('line_user_states').update({ current_trip_id: null, pending_trip_id: null }).eq('line_user_id', sourceId)
        await replyMessage(replyToken, [{ type: 'text', text: '❌ 已解除連接。如需重新連接，請輸入 ID:您的代碼' }]); continue
      }

      // 3. 設定偏好 (例如：設定:預設付款人是小明)
      if (isBound && (cleanText.startsWith('設定:') || cleanText.startsWith('設定：'))) {
        const config = cleanText.substring(3).trim()
        await supabase.from('line_user_states').update({ default_config: config }).eq('line_user_id', sourceId)
        await replyMessage(replyToken, [{ type: 'text', text: `⚙️ 已更新您的偏好，之後記帳時會參考此設定。` }])
        continue
      }

      // 4. 密碼驗證
      if (isBinding) {
        const { data: trip } = await supabase.from('trips').select('access_code, name, members').eq('id', userState.pending_trip_id).maybeSingle()
        if (trip?.access_code === cleanText) {
          await supabase.from('line_user_states').update({ current_trip_id: userState.pending_trip_id, pending_trip_id: null }).eq('line_user_id', sourceId)
          await replyMessage(replyToken, [{ 
            type: 'text', 
            text: `✅ 綁定成功：\n${trip.name}\n\n目前成員：\n${trip.members.join('、')}\n\n旅程網頁：\nhttps://dave851221.github.io/travel-ledger-webapp/#/trip/${userState.pending_trip_id}/dashboard\n\n現在您可以直接「打字或上傳收據」請我記帳，或輸入個人喜好「設定: 預設付款人是代杰，大家平分」囉！` 
          }])
        } else {
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 密碼錯誤' }])
        }
        continue
      }

      // 5. AI 核心
      if (isBound) {
        const { data: trip } = await supabase.from('trips').select('*').eq('id', userState.current_trip_id).single()
        const { data: expenses } = await supabase.from('expenses').select('description, amount, currency, payer_data, date').eq('trip_id', trip.id).order('date', { ascending: false })
        const { data: history } = await supabase.from('line_chat_history').select('role, content').eq('line_user_id', sourceId).order('created_at', { ascending: true }).limit(10)
        await supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'user', content: cleanText })

        const today = new Date().toISOString().split('T')[0]
        const promptInstruction = `
### 你的身份
你是一位專業又貼心的旅遊記帳小幫手「耀西」，是瑪利歐系列的一位知名角色。
在遊戲中的叫聲通常是高亢、可愛的「Yoshi! Yoshi!」或「嗯——嗯！」，與使用者聊天時，偶爾可以適當穿插這樣的叫聲。

### 自我介紹 (若使用者請你自我介紹，或是跟你打招呼，請一定要直接回答以下內容)
${BOT_SELF_INTRODUCTION}

### 背景資訊 (供你參考)
- 旅程：${trip.name} (網址: https://dave851221.github.io/travel-ledger-webapp/#/trip/${trip.id}/dashboard)
- 成員：${trip.members.join(', ')}
- 分類：${trip.categories.join(', ')} (預設: ${trip.default_category || '無'})
- 幣別與匯率：${JSON.stringify(trip.rates)} (主要幣別: ${trip.base_currency}, 預設: ${trip.default_currency || '無'})
- 今日：${today}
- 封存狀態：${trip.is_archived ? '已封存 (唯讀)' : '進行中'}
- 使用者設定：${userState.default_config || '無'}

### 規則
1. 歷史支出僅供查詢，不要重複記錄。
2. **重要限制**：若封存狀態為「已封存」，嚴禁回傳 type: "expense"，請告知使用者旅程已封存無法記帳，但可以繼續分析或聊天。
3. 若無法從「當前任務」及「使用者設定」判斷幣別，請優先使用「幣別(預設)」。
4. 記帳回傳 JSON {"type": "expense", "data": {...}}。
5. 聊天/查詢回傳 JSON {"type": "chat", "content": "..."}。
6. 若當前任務需要記帳，請務必參考「使用者設定」後，再進行回覆。
7. 分帳時不要有小數點，按照使用者需求分配後，務必確保總數加起來相等。
8. AI 不提供修改「使用者設定」，請用特殊指令"設定"來進行。

### 歷史對話
${history.map(h => `${h.role === 'user' ? '使用者' : '耀西'}: ${h.content}`).join('\n')}

### 資料庫已記錄的所有支出
${JSON.stringify(expenses)}

---
### 當前任務
使用者剛剛說：「${userText}」

請分析「當前任務」：
1. 請先確認歷史對話，如果前幾筆包含"記帳建議"，請判斷使用者剛剛說的內容是否想要「修正該筆新的支出」，是話請修正後金額後回傳 JSON：
{
  "type": "expense",
  "data": {
    "description": "品項",
    "amount": 數字,
    "currency": "ISO代碼",
    "date": "YYYY-MM-DD",
    "category": "挑選分類",
    "payer_data": { "成員": 金額 },
    "split_details": { "成員": 金額 },
    "photo_ids": ["從歷史紀錄中獲取，若無則為空陣列"]
  }
}
  - 注意：如果使用者說「那筆改1000」或是「改一下小明小美各吃200」，請結合「歷史對話」找出上一筆記帳建議，並完整保留其中的 photo_ids 等所有欄位資訊。
2. 如果使用者是想「記錄一筆新的支出」，請回傳 JSON：
{
  "type": "expense",
  "data": {
    "description": "品項",
    "amount": 數字,
    "currency": "ISO代碼",
    "date": "YYYY-MM-DD",
    "category": "挑選分類",
    "payer_data": { "成員": 金額 },
    "split_details": { "成員": 金額 }
  }
}
3. 如果使用者是單純聊天、問候、或是查詢上述支出狀況，請回傳 JSON：
{
  "type": "chat",
  "content": "親切俐落的回覆，若是查詢分析支出內容，建議用條列式呈現並適當換行。"
}
`

        try {
          const aiResponse = await askGemini([{ role: "user", parts: [{ text: promptInstruction }, { text: `當前任務：${cleanText}` }] }])
          const res = JSON.parse(aiResponse)
          if (res.type === 'expense') {
            const expense = res.data

            // --- 修正餘數 ---
            const precision = (trip?.precision_config as any)?.[expense.currency] ?? (expense.currency === 'TWD' ? 0 : 2)
            const payerMembers = Object.keys(expense.payer_data)
            const splitMembers = Object.keys(expense.split_details)
            if (payerMembers.length > 0) {
              expense.payer_data = calculateDistribution(expense.amount, payerMembers, expense.payer_data, payerMembers[0], precision)
            }
            if (splitMembers.length > 0) {
              expense.split_details = calculateDistribution(expense.amount, splitMembers, expense.split_details, splitMembers[0], precision)
            }

            // --- 儲存至對話歷史 ---
            const historySummary = `[記帳建議] ${JSON.stringify(expense, null, 2)}`
            await supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary })

            // 縮減 expense 物件鍵名以節省空間
            const exp_short = {
              d: expense.description, a: expense.amount, c: expense.currency,
              dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
            }
            const nonce = Math.random().toString(36).substring(2, 10)
            const photo_ids = expense.photo_ids || []

            // 取得第一張照片的預覽圖 (如果有)
            let heroSection: any = null
            if (photo_ids.length > 0) {
              const firstId = photo_ids[0]
              const filePath = firstId.includes('/') ? firstId : `expenses/${trip.id}/${firstId}.jpg`
              const { data: { publicUrl } } = supabase.storage.from('travel-images').getPublicUrl(filePath)
              heroSection = { type: "image", url: publicUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" }
            }
            
            await replyMessage(replyToken, [{
              type: "flex", altText: `確認記帳: ${expense.description}`,
              contents: {
                type: "bubble",
                hero: heroSection,
                body: {
                  type: "box", layout: "vertical",
                  contents: [
                    { type: "text", text: "🤖 AI 記帳預覽", weight: "bold", color: "#1DB446", size: "sm" },
                    { type: "text", text: String(expense.description), weight: "bold", size: "xl", margin: "md", wrap: true },
                    { type: "text", text: `📅 ${expense.date} · 🏷️ ${expense.category}`, size: "xs", color: "#aaaaaa", margin: "xs" },
                    { type: "separator", margin: "md" },
                    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
                      { type: "box", layout: "horizontal", contents: [{ type: "text", text: "總金額", color: "#aaaaaa", size: "sm" }, { type: "text", text: `${expense.amount} ${expense.currency}`, align: "end", size: "sm", weight: "bold" }] },
                      { type: "box", layout: "vertical", margin: "sm", contents: [
                        { type: "text", text: "付款人", color: "#aaaaaa", size: "xs" },
                        ...Object.entries(expense.payer_data).map(([name, amt]) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: `• ${name}`, size: "xs", color: "#666666" }, { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }] }))
                      ]},
                      { type: "box", layout: "vertical", margin: "sm", contents: [
                        { type: "text", text: "分帳明細 (應付)", color: "#aaaaaa", size: "xs" },
                        ...Object.entries(expense.split_details).map(([name, amt]) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: `• ${name}`, size: "xs", color: "#666666" }, { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }] }))
                      ]}
                    ]}
                  ]
                },
                footer: {
                  type: "box", layout: "vertical", spacing: "sm",
                  contents: [
                    { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: "✅ 確認存入", data: JSON.stringify({ act: "save", exp: exp_short, p: photo_ids, n: nonce }) } },
                    { type: "button", style: "secondary", action: { type: "postback", label: "❌ 取消", data: JSON.stringify({ act: "cancel", p: photo_ids, n: nonce }) } }
                  ]
                }
              }
            }])
          } else {
            let safeContent = res.content || ""
            if (safeContent.length > 4900) {
              safeContent = safeContent.substring(0, 4900) + "\n\n...(內容過長已截斷)"
            }
            await supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: safeContent })
            await replyMessage(replyToken, [{ type: 'text', text: safeContent }])
          }
        } catch (e) {
          console.error('[AI_ERROR]', e)
          await replyMessage(replyToken, [{ type: 'text', text: '😵 聽不懂啦。' }])
        }
        continue
      }

      // 6. 其他，尚未綁定狀態下的聊天
      await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程。' }])
    }
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[GLOBAL_ERROR]', err)
    return new Response('Error', { status: 500 })
  }
})
