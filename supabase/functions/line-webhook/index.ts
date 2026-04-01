import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"
import { decode } from "https://deno.land/std@0.168.0/encoding/base64.ts"

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') || ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !LINE_CHANNEL_SECRET) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return await crypto.subtle.verify('HMAC', key, decode(signature), encoder.encode(body))
}

async function replyMessage(replyToken: string, messages: any[]) {
  console.log(`[LINE] Replying...`)
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) console.error(`[LINE] Error: ${await res.text()}`)
}

async function askGemini(contents: any[]) {
  console.log(`[AI] Calling G3.1 Lite...`)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_API_KEY}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { response_mime_type: "application/json" } })
  })
  if (!response.ok) throw new Error(`Gemini Error: ${response.status}`)
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
      const lineUserId = event.source.userId
      const replyToken = event.replyToken

      if (event.type === 'postback') {
        const postbackData = JSON.parse(event.postback.data)
        const nonce = postbackData.nonce

        // 防重複檢查
        if (nonce) {
          const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
          if (processed) {
            await replyMessage(replyToken, [{ type: 'text', text: `⚠️ 此操作已處理過囉！` }])
            continue
          }
        }

        if (postbackData.action === 'save_expense') {
          const { trip_id, expense } = postbackData
          if (nonce) await supabase.from('line_processed_actions').insert({ nonce, line_user_id: lineUserId, action_type: 'save' })
          
          const { error } = await supabase.from('expenses').insert({
            trip_id: trip_id,
            description: expense.description,
            amount: expense.amount,
            currency: expense.currency,
            payer_data: expense.payer_data,
            split_data: expense.split_details,
            date: expense.date,
            category: expense.category
          })
          if (error) await replyMessage(replyToken, [{ type: 'text', text: '❌ 儲存失敗' }])
          else await replyMessage(replyToken, [{ type: 'text', text: `✅ 已存入：${expense.description}` }])
        } else if (postbackData.action === 'cancel') {
          if (nonce) await supabase.from('line_processed_actions').insert({ nonce, line_user_id: lineUserId, action_type: 'cancel' })
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 已取消。' }])
        }
        continue
      }

      if (event.type !== 'message' || event.message.type !== 'text') continue
      const userText = event.message.text.trim()

      let { data: userState } = await supabase.from('line_user_states').select('*').eq('line_user_id', lineUserId).maybeSingle()
      if (!userState) {
        const { data: newState } = await supabase.from('line_user_states').insert({ line_user_id: lineUserId }).select().single()
        userState = newState
      }

      // 基礎指令
      if (userText === '斷開' || userText === '切換旅程') {
        await supabase.from('line_user_states').update({ current_trip_id: null, pending_trip_id: null }).eq('line_user_id', lineUserId)
        await replyMessage(replyToken, [{ type: 'text', text: '❌ 已解除連接' }]); continue
      }
      const isPotentialId = /^[A-Z0-9]{6}$/.test(userText.toUpperCase())
      if (isPotentialId) {
        const { data: mapping } = await supabase.from('line_trip_id_mapping').select('trip_id').eq('linebot_id', userText.toUpperCase()).maybeSingle()
        if (mapping) {
          await supabase.from('line_user_states').update({ pending_trip_id: mapping.trip_id, current_trip_id: null }).eq('line_user_id', lineUserId)
          await replyMessage(replyToken, [{ type: 'text', text: '🔍 找到旅程！請輸入密碼。' }]); continue
        }
      }
      if (userState?.pending_trip_id && !userState?.current_trip_id) {
        const { data: trip } = await supabase.from('trips').select('access_code').eq('id', userState.pending_trip_id).maybeSingle()
        if (trip?.access_code === userText) {
          await supabase.from('line_user_states').update({ current_trip_id: userState.pending_trip_id, pending_trip_id: null }).eq('line_user_id', lineUserId)
          await replyMessage(replyToken, [{ type: 'text', text: `✅ 綁定成功！` }])
        } else if (!isPotentialId) { await replyMessage(replyToken, [{ type: 'text', text: '❌ 密碼錯誤' }]) }
        continue
      }

      // AI 核心
      if (userState?.current_trip_id) {
        const { data: trip } = await supabase.from('trips').select('*').eq('id', userState.current_trip_id).single()
        const { data: expenses } = await supabase.from('expenses').select('description, amount, currency, payer_data, date').eq('trip_id', trip.id).order('date', { ascending: false })
        const { data: history } = await supabase.from('line_chat_history').select('role, content').eq('line_user_id', lineUserId).order('created_at', { ascending: true }).limit(10)

        // 存入使用者訊息 (非指令才存)
        await supabase.from('line_chat_history').insert({ line_user_id: lineUserId, role: 'user', content: userText })

        const today = new Date().toISOString().split('T')[0]
        const promptInstruction = `
### 你的身份
你是一位專業且幽默的旅遊管家。

### 背景資訊 (僅供參考，絕對不要重複記錄這些項目)
- 旅程：${trip.name}
- 成員：${trip.members.join(', ')}
- 分類：${trip.categories.join(', ')}
- 幣別：${trip.base_currency}
- 今日：${today}
- 使用者設定：${userState.default_config || '無'}

### 歷史對話 (協助理解代名詞)
${history.map(h => `${h.role === 'user' ? '使用者' : '管家'}: ${h.content}`).join('\n')}

### 資料庫最近支出 (僅供查詢參考，不要重複記帳)
${JSON.stringify(expenses)}

---
### 當前任務 (這是你唯一需要處理的請求)
使用者剛剛說：「${userText}」

請分析「當前任務」：
1. 如果使用者是想「記錄一筆新的支出」，請回傳 JSON：
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
2. 如果使用者是單純聊天、問候、或是查詢上述支出狀況，請回傳 JSON：
{
  "type": "chat",
  "content": "親切且具情緒價值的回覆，如果是詢問當前的資料庫內容，建議用條列式並適當換行。"
}

注意：如果使用者說「那筆改 500」，請結合「歷史對話」找出是哪一筆並回傳 expense 資料。
`

        try {
          const aiResponse = await askGemini([{ role: "user", parts: [{ text: promptInstruction }] }])
          const res = JSON.parse(aiResponse)

          if (res.type === 'expense') {
            const expense = res.data
            const nonce = `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`

            await replyMessage(replyToken, [{
              type: "flex", altText: `確認記帳: ${expense.description}`,
              contents: {
                type: "bubble",
                body: {
                  type: "box", layout: "vertical",
                  contents: [
                    { type: "text", text: "🤖 記帳預覽", weight: "bold", color: "#1DB446", size: "sm" },
                    { type: "text", text: String(expense.description), weight: "bold", size: "xl", margin: "md", wrap: true },
                    { type: "text", text: `📅 ${expense.date} · 🏷️ ${expense.category}`, size: "xs", color: "#aaaaaa", margin: "xs" },
                    { type: "separator", margin: "md" },
                    { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
                      { type: "box", layout: "horizontal", contents: [{ type: "text", text: "總金額", color: "#aaaaaa", size: "sm" }, { type: "text", text: `${expense.amount} ${expense.currency}`, align: "end", size: "sm", weight: "bold" }] },
                      { type: "box", layout: "vertical", margin: "sm", contents: [
                        { type: "text", text: "付款人 (墊付)", color: "#aaaaaa", size: "xs" },
                        ...Object.entries(expense.payer_data).map(([name, amt]) => ({
                          type: "box", layout: "horizontal", contents: [
                            { type: "text", text: `• ${name}`, size: "xs", color: "#666666" },
                            { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }
                          ]
                        }))
                      ]},
                      { type: "box", layout: "vertical", margin: "sm", contents: [
                        { type: "text", text: "分帳明細 (應付)", color: "#aaaaaa", size: "xs" },
                        ...Object.entries(expense.split_details).map(([name, amt]) => ({
                          type: "box", layout: "horizontal", contents: [
                            { type: "text", text: `• ${name}`, size: "xs", color: "#666666" },
                            { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }
                          ]
                        }))
                      ]}
                    ]}
                  ]
                },
                footer: {
                  type: "box", layout: "vertical", spacing: "sm",
                  contents: [
                    { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: "✅ 確認存入", data: JSON.stringify({ action: "save_expense", trip_id: trip.id, expense: expense, nonce }) } },
                    { type: "button", style: "secondary", action: { type: "postback", label: "❌ 取消", data: JSON.stringify({ action: "cancel", nonce }) } }
                  ]
                }
              }
            }])
          } else {
            await supabase.from('line_chat_history').insert({ line_user_id: lineUserId, role: 'model', content: res.content })
            await replyMessage(replyToken, [{ type: 'text', text: res.content }])
          }
        } catch (e) {
          console.error('AI Error:', e)
          await replyMessage(replyToken, [{ type: 'text', text: '😵 處理失敗，請換個說法。' }])
        }
        continue
      }
      await replyMessage(replyToken, [{ type: 'text', text: '👋 請輸入 6 位代碼連結。' }])
    }
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('Global Error:', err)
    return new Response('Internal Server Error', { status: 500 })
  }
})
