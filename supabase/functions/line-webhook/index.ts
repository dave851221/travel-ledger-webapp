import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"
import { encodeBase64, decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import Decimal from "https://esm.sh/decimal.js@10.4.3"

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') || ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const WEBAPP_URL = Deno.env.get('WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp'

const DEFAULT_PRECISION: Record<string, number> = { TWD: 0, JPY: 0, KRW: 0 }

const RATE_LIMIT_MSG = '⚠️ AI 服務暫時達到使用量上限，請稍候約 30 秒後再重新傳送。'
const isRateLimit = (e: any) => String(e?.message).startsWith('RATE_LIMIT:')

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function getQuickReply(bound: boolean, showGroupToggle = false, mentionRequired = true) {
  if (!bound) {
    return {
      items: [
        { type: "action", action: { type: "message", label: "❓ 如何使用", text: "耀西" } },
      ]
    }
  }
  const items: any[] = [
    { type: "action", action: { type: "message", label: "📅 今日支出", text: "今日支出" } },
    { type: "action", action: { type: "message", label: "📊 本月支出", text: "本月支出" } },
    { type: "action", action: { type: "message", label: "💰 結算", text: "結算" } },
    { type: "action", action: { type: "message", label: "🗺️ 旅程總覽", text: "旅程總覽" } },
    { type: "action", action: { type: "message", label: "❓ 如何使用", text: "耀西" } },
  ]
  if (showGroupToggle) {
    items.push(mentionRequired
      ? { type: "action", action: { type: "message", label: "📣開啟全回應模式", text: "模式:全回應模式" } }
      : { type: "action", action: { type: "message", label: "🎯改回提及模式", text: "模式:提及模式" } }
    )
  }
  return { items }
}

// Gemini 偶爾會用 markdown code block 包裝 JSON，此函式負責安全提取
function extractJSON(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return text.substring(start, end + 1)
  return text.trim()
}

// 將待確認支出暫存於 chat_history，讓 postback 只傳 nonce（避免 300 bytes 上限）
async function storePendingExpense(sourceId: string, nonce: string, data: any) {
  await supabase.from('line_chat_history').insert({
    line_user_id: sourceId,
    role: 'pending',
    content: JSON.stringify({ n: nonce, ...data })
  })
}

async function getPendingExpense(sourceId: string, nonce: string): Promise<any | null> {
  const { data } = await supabase.from('line_chat_history')
    .select('content')
    .eq('line_user_id', sourceId)
    .eq('role', 'pending')
    .order('created_at', { ascending: false })
    .limit(10)
  if (!data) return null
  for (const row of data) {
    try {
      const parsed = JSON.parse(row.content)
      if (parsed.n === nonce) return parsed
    } catch { /* skip malformed */ }
  }
  return null
}

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
• 撤銷記帳：輸入「取消上一筆」或「撤銷上一筆」

📊 快捷查詢（直接輸入或點選下方按鈕）：
• 今日支出 / 本月支出 / 結算 / 旅程總覽

💡 群組提醒：
問我問題時，請"@提及"我，或是喊「耀西」喚醒我，不然我平常都躲在蛋裡睡覺唷！
Yoshi! Yoshi!
`

const CURRENCY_TIMEZONE: Record<string, string> = {
  TWD: 'Asia/Taipei',   JPY: 'Asia/Tokyo',        KRW: 'Asia/Seoul',
  HKD: 'Asia/Hong_Kong', SGD: 'Asia/Singapore',   MYR: 'Asia/Kuala_Lumpur',
  THB: 'Asia/Bangkok',  VND: 'Asia/Ho_Chi_Minh',  IDR: 'Asia/Jakarta',
  PHP: 'Asia/Manila',   CNY: 'Asia/Shanghai',
  AUD: 'Australia/Sydney', NZD: 'Pacific/Auckland',
  GBP: 'Europe/London', EUR: 'Europe/Paris',       CHF: 'Europe/Zurich',
  USD: 'America/New_York', CAD: 'America/Toronto',
}

function getTripTimezone(trip: any): string {
  const candidates = [trip.base_currency, ...Object.keys(trip.rates || {})]
  for (const cur of candidates) {
    if (CURRENCY_TIMEZONE[cur]) return CURRENCY_TIMEZONE[cur]
  }
  return 'UTC'
}

function getTodayString(timezone = 'Asia/Taipei'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

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

function calculateSettlements(memberBalances: Record<string, number>): { from: string, to: string, amount: number }[] {
  const EPSILON = new Decimal('0.01')
  const debtors: { name: string, amt: Decimal }[] = []
  const creditors: { name: string, amt: Decimal }[] = []
  Object.entries(memberBalances).forEach(([name, bal]) => {
    const d = new Decimal(bal)
    if (d.lt(EPSILON.negated())) debtors.push({ name, amt: d.negated() })
    else if (d.gt(EPSILON)) creditors.push({ name, amt: d })
  })
  debtors.sort((a, b) => b.amt.comparedTo(a.amt))
  creditors.sort((a, b) => b.amt.comparedTo(a.amt))
  const result: { from: string, to: string, amount: number }[] = []
  let i = 0, j = 0
  while (i < debtors.length && j < creditors.length) {
    const minAmt = Decimal.min(debtors[i].amt, creditors[j].amt)
    result.push({ from: debtors[i].name, to: creditors[j].name, amount: minAmt.toNumber() })
    debtors[i].amt = debtors[i].amt.minus(minAmt)
    creditors[j].amt = creditors[j].amt.minus(minAmt)
    if (debtors[i].amt.lt(EPSILON)) i++
    if (creditors[j].amt.lt(EPSILON)) j++
  }
  return result
}

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !LINE_CHANNEL_SECRET) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return await crypto.subtle.verify('HMAC', key, decodeBase64(signature), encoder.encode(body))
}

async function analyzeReceiptPhoto(photoUrl: string, question: string): Promise<string> {
  const imgRes = await fetch(photoUrl)
  if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`)
  const imgBuffer = await imgRes.arrayBuffer()
  const base64Image = encodeBase64(new Uint8Array(imgBuffer))
  const analyzePrompt = `請詳細分析這張收據照片，並以繁體中文回答問題。若收據為外文（日文、韓文等），請逐項翻譯。
使用者的問題：${question}
回傳 JSON: {"type":"chat","content":"詳細的繁體中文回答，條列式呈現品項"}`
  const analysisText = await askGemini([{
    role: "user",
    parts: [{ text: analyzePrompt }, { inlineData: { mimeType: "image/jpeg", data: base64Image } }]
  }], false)
  const analysisRes = JSON.parse(extractJSON(analysisText))
  return analysisRes.content || '抱歉，無法分析此照片。'
}

async function pushMessage(to: string, messages: any[]) {
  console.log(`[LINE] Pushing to ${to}...`)
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  })
  if (!res.ok) console.error(`[LINE] Push Error: ${await res.text()}`)
}

async function replyMessage(replyToken: string, messages: any[], to?: string) {
  console.log(`[LINE] Replying to ${replyToken}...`)
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[LINE] Reply Error: ${errorText}`);
    if (to) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
        body: JSON.stringify({ to, messages: [{ type: 'text', text: `⚠️ 訊息發送失敗：\n${errorText}` }] }),
      })
    }
  }
}

const GEMINI_FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
]

async function askGemini(contents: any[], useJsonMode = true) {
  const generationConfig = useJsonMode ? { response_mime_type: "application/json" } : {}
  for (const model of GEMINI_FALLBACK_MODELS) {
    console.log(`[AI] Calling Gemini model: ${model}`)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig })
    })
    if (response.status === 429) {
      console.warn(`[AI] Rate limited on ${model}, falling back to next model...`)
      continue
    }
    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini API error ${response.status}: ${errText}`)
    }
    const data = await response.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error(`Gemini returned empty response: ${JSON.stringify(data).substring(0, 500)}`)
    return text
  }
  throw new Error('RATE_LIMIT: All Gemini models are currently rate limited.')
}

async function getGroupMemberName(groupId: string, userId: string): Promise<string> {
  try {
    const response = await fetch(
      `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
      { headers: { "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    if (!response.ok) {
      console.error(`[LINE API Error] 無法取得成員名稱: ${await response.text()}`);
      return "";
    }
    const profile = await response.json();
    console.log(`[PROFILE in GROUP] ${JSON.stringify(profile, null, 2)}`)
    return profile.displayName;
  } catch (error) {
    console.error("[Fetch Error] 呼叫 LINE API 失敗:", error);
    return "";
  }
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
      console.log(`[EVENT] ${JSON.stringify(event, null, 2)}`);

      let memberName = "未知";
      const needsMemberName = event.type === 'message' && (event.message?.type === 'text' || event.message?.type === 'image');
      if (event.source.type === "group" && needsMemberName) {
        const fetchedName = await getGroupMemberName(event.source.groupId, event.source.userId);
        memberName = fetchedName || `User_${event.source.userId.substring(0, 8)}`;
      }

      let { data: userState } = await supabase.from('line_user_states').select('*').eq('line_user_id', sourceId).maybeSingle()
      if (!userState) {
        console.log(`[DB] Registering new state for sourceId: ${sourceId}`)
        const { data: newState } = await supabase.from('line_user_states').insert({ line_user_id: sourceId }).select().single()
        userState = newState
      }
      const isBinding = !!(userState?.pending_trip_id && !userState?.current_trip_id)
      const isBound = !!userState?.current_trip_id
      const mentionRequired = userState?.mention_required ?? true
      // 預計算綁定狀態下的快速回覆（含群組切換按鈕），整個 event 共用
      const boundQR = getQuickReply(true, isGroup, mentionRequired)

      // --- Postback 處理 ---
      if (isBound && (event.type === 'postback')) {
        let postbackData: any
        try {
          postbackData = JSON.parse(event.postback.data)
        } catch {
          console.error('[POSTBACK] Failed to parse postback data:', event.postback.data)
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 無效的操作資料，請重試。' }], sourceId)
          continue
        }

        console.log(`[POSTBACK] Data: ${event.postback.data}`)

        // 撤銷存入（postback 按鈕）
        if (postbackData.act === 'undo') {
          const expenseId = postbackData.eid
          const description = postbackData.d || '該筆支出'
          if (expenseId) {
            const { error } = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', expenseId)
            if (error) {
              await replyMessage(replyToken, [{ type: 'text', text: '❌ 撤銷失敗，請至網頁手動刪除。' }], sourceId)
            } else {
              await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${description}`, quickReply: boundQR }], sourceId)
            }
          } else {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到可撤銷的記錄。' }], sourceId)
          }
          continue
        }

        if (postbackData.action === 'save_expense' || postbackData.act === 'save') {
          const { n: nonce_short, expense: exp_old, exp: exp_new, photo_urls: p_old, p: p_new } = postbackData
          const nonce = nonce_short || postbackData.nonce

          // 優先從 chat_history 取得 pending 資料（避免 300 bytes 限制）
          let expenseRaw = exp_new || exp_old || postbackData.expense
          let photo_ids = p_new || p_old || postbackData.photo_urls || []
          let trip_id = postbackData.trip_id || userState?.current_trip_id

          if (!expenseRaw && nonce) {
            const pending = await getPendingExpense(sourceId, nonce)
            if (pending) {
              expenseRaw = pending.exp
              photo_ids = pending.p || []
              trip_id = pending.tid || trip_id
            }
          }

          if (!expenseRaw) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新記帳。' }], sourceId); continue
          }

          if (nonce) {
            const { error: nonceInsertError } = await supabase
              .from('line_processed_actions')
              .insert({ nonce, line_user_id: sourceId, action_type: 'save' });
            if (nonceInsertError) {
              // 查詢 action_type，給予更明確的重複操作提示
              const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
              const msg = processed?.action_type === 'save'
                ? `⚠️ 此筆支出已於先前成功存入！`
                : `⚠️ 此操作已處理過囉！`
              await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId); continue
            }
          }

          if (!trip_id) {
            await replyMessage(replyToken, [{ type: 'text', text: `❌ 找不到對應旅程，請重新綁定。` }], sourceId); continue
          }

          const expense = {
            description: expenseRaw.d ?? expenseRaw.description,
            amount: expenseRaw.a ?? expenseRaw.amount,
            currency: expenseRaw.c ?? expenseRaw.currency,
            date: expenseRaw.dt ?? expenseRaw.date,
            category: expenseRaw.cat ?? expenseRaw.category,
            payer_data: expenseRaw.p ?? expenseRaw.payer_data ?? {},
            split_details: expenseRaw.s ?? expenseRaw.split_details ?? {}
          }

          const photo_urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)

          const { data: trip } = await supabase.from('trips').select('precision_config, members, is_archived').eq('id', trip_id).single()

          if (trip?.is_archived) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 此旅程已封存，無法新增支出。' }], sourceId);
            continue;
          }

          const precision = (trip?.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
          const numAmount = new Decimal(parseFloat(expense.amount as any) || 0).toDecimalPlaces(precision).toNumber()
          const payerMembers = Object.keys(expense.payer_data).filter(m => trip.members.includes(m))
          const splitMembers = Object.keys(expense.split_details).filter(m => trip.members.includes(m))
          const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
          const finalPayerData = calculateDistribution(numAmount, payerMembers, expense.payer_data, payerMembers[0], precision)
          const finalSplitData = calculateDistribution(numAmount, splitMembers, expense.split_details, adjustMember, precision)

          const checkSum = (data: any) => Object.values(data).reduce((a: Decimal, b: any) => a.plus(new Decimal(b)), new Decimal(0))
          const payerSum = checkSum(finalPayerData)
          const splitSum = checkSum(finalSplitData)
          const target = new Decimal(numAmount).toDecimalPlaces(precision)

          if (!payerSum.equals(target) || !splitSum.equals(target)) {
            console.error(`[CRITICAL_VALIDATION_ERROR] Sum mismatch. P:${payerSum}, S:${splitSum}, T:${target}`)
            await replyMessage(replyToken, [{ type: 'text', text: `❌ 財務運算發生錯誤，請聯絡管理員。` }], sourceId)
            continue
          }

          const { data: savedExpense } = await supabase.from('expenses').insert({
            trip_id: trip_id, description: expense.description, amount: target.toNumber(), currency: expense.currency,
            payer_data: finalPayerData, split_data: finalSplitData, date: expense.date, category: expense.category,
            photo_urls: photo_urls, adjustment_member: adjustMember
          }).select('id').single()

          // 記錄 expense_id 供文字指令「取消上一筆」使用
          if (savedExpense?.id) {
            supabase.from('line_chat_history').insert({
              line_user_id: sourceId, role: 'saved',
              content: JSON.stringify({ expense_id: savedExpense.id, description: expense.description })
            }).then(() => {})
          }

          // 存入後附帶撤銷快速按鈕，讓使用者可即時反悔
          const undoItems = savedExpense?.id
            ? [{ type: "action", action: { type: "postback", label: "↩️ 撤銷", data: JSON.stringify({ act: "undo", eid: savedExpense.id, d: expense.description }) } }]
            : []
          await replyMessage(replyToken, [{
            type: 'text', text: `✅ 已存入：${expense.description}`,
            quickReply: { items: [...undoItems, ...boundQR.items] }
          }], sourceId)

        } else if (postbackData.action === 'cancel' || postbackData.act === 'cancel') {
          const nonce = postbackData.n ?? postbackData.nonce
          let photo_ids = postbackData.p ?? postbackData.photo_urls ?? []
          let trip_id = postbackData.trip_id ?? userState?.current_trip_id

          // 從 pending 取得照片資訊（用於刪除 Storage 的照片）
          if (photo_ids.length === 0 && nonce) {
            const pending = await getPendingExpense(sourceId, nonce)
            if (pending) {
              photo_ids = pending.p || []
              trip_id = pending.tid || trip_id
            }
          }

          if (nonce) {
            const { error: nonceInsertError } = await supabase
              .from('line_processed_actions')
              .insert({ nonce, line_user_id: sourceId, action_type: 'cancel' })
            if (nonceInsertError) {
              await replyMessage(replyToken, [{ type: 'text', text: `⚠️ 此操作已處理過囉！` }], sourceId); continue
            }
          }

          if (photo_ids.length > 0 && trip_id) {
            const urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)
            console.log(`[PHOTO] Remove photo URL: ${urls}`)
            await supabase.storage.from('travel-images').remove(urls)
          }

          await replyMessage(replyToken, [{ type: 'text', text: photo_ids.length > 0 ? '❌ 已取消並刪除照片。' : '❌ 已取消。' }], sourceId)
        }

        continue
      }

      // --- 圖片處理 (收據 OCR) ---
      if (isBound && (event.type === 'message' && event.message.type === 'image')) {
        const messageId = event.message.id

        if (!userState?.current_trip_id) {
          await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程，再傳送收據照片喔！' }], sourceId)
          continue
        }

        const tripId = userState.current_trip_id
        const filePath = `expenses/${tripId}/${messageId}.jpg`
        try {
          console.log(`[IMAGE] Downloading messageId: ${messageId}`)
          const [lineRes, { data: trip }] = await Promise.all([
            fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
              headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
            }),
            supabase.from('trips').select('*').eq('id', tripId).single()
          ])
          if (!lineRes.ok) throw new Error('Failed to download image from LINE')
          const imageBuffer = await lineRes.arrayBuffer()

          console.log(`[STORAGE] Uploading to: ${filePath}`)
          const { error: uploadErr } = await supabase.storage.from('travel-images').upload(filePath, imageBuffer, {
            contentType: 'image/jpeg', upsert: true
          })
          if (uploadErr) throw uploadErr

          const { data: { publicUrl } } = supabase.storage.from('travel-images').getPublicUrl(filePath)
          const base64Image = encodeBase64(new Uint8Array(imageBuffer))
          const today = getTodayString(getTripTimezone(trip))

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
- 幣別與匯率：${JSON.stringify(trip.rates)} (主要幣別: ${trip.base_currency}, 預設: ${trip.default_currency || '無'})
- 今日：${today}
- 封存狀態：${trip.is_archived ? '已封存 (唯讀)' : '進行中'}
- 使用者設定：${userState.default_config || '無'}
- 使用者名稱(傳訊息的人)：${memberName}
- 旅程預設付款人：${trip.default_payer?.length ? trip.default_payer.join(', ') : '無'}
- 旅程預設分攤成員：${trip.default_split_members?.length ? trip.default_split_members.join(', ') : '全部成員'}

### 任務規則
1. 辨識「總金額」與「幣別」。請從符號、地址或語系推斷幣別 (例如：¥/JPY, $/USD, NT/TWD, €/EUR)。
   - 決定幣別的優先權為 (1.從收據辨識出幣別; 2.使用者設定中提及; 3.上方背景資訊的預設幣別)
2. 辨識「日期」。若收據上無明確日期，請使用今日。
3. 辨識「品項描述」。提取商店名稱或主要品項。若是外文請保留原文，並在括號內加上簡單的繁體中文翻譯 (例如：一蘭ラーメン(拉麵))。
4. 辨識「分類」。若無法判別，可以先看是否有"其他"類別，若無"其他"類別可優先使用預設分類。
5. 請詳讀「使用者設定」，再來決定 payer_data (墊付) 與 split_details (應付)。
   - 分帳時盡量不要有小數點(除非總金額有小數點)，按照以下規則分配好金額後，請務必確保總數加起來相等。
   - payer_data 及 split_details 內的成員，必須要在背景資訊內的「成員清單」中。
   - 墊付邏輯的優先權(payer_data):
     1. 旅程預設付款人（若有設定）
     2. 使用者設定內所提及的預設付款人
     3. 根據上述的「使用者名稱」，判斷是否可對應到某一名成員，即該成員擔任付款人。(對應關係可能會在使用者設定中提及，但請注意務必要用「成員清單」內定義的名字)
     4. 由成員中第一位擔任付款人
   - 金額分攤邏輯的優先權(split_details):
     1. 旅程預設分攤成員（若有設定）
     2. 使用者設定所提及的分攤方式
     3. 全員均分
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
7. 只有在照片完全無法關聯到任何消費行為時（例如：純人物自拍、動植物照、風景照、藝術品照等與金錢/交易完全無關的內容），才回傳：{"type": "not_receipt"}。
   若照片中含有任何金額數字、品項列表、條碼、QR Code、日期、店名、發票字樣、電子支付截圖、帳單、手寫明細等任何可能與消費相關的視覺資訊，請務必嘗試解析，不可回傳 not_receipt。
8. **重要限制**：若封存狀態為「已封存」，嚴禁回傳 type: "expense"，請告知使用者旅程已封存無法記帳，但可以繼續分析或聊天。
`

          const aiResponse = await askGemini([
            { role: "user", parts: [
              { text: ocrPrompt },
              { inlineData: { mimeType: "image/jpeg", data: base64Image } }
            ]}
          ], false)

          const res = JSON.parse(extractJSON(aiResponse))
          if (res.type === 'expense') {
            const expense = res.data

            const precision = (trip?.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
            expense.amount = new Decimal(expense.amount || 0).toDecimalPlaces(precision).toNumber()
            const payerMembers = Object.keys(expense.payer_data)
            const splitMembers = Object.keys(expense.split_details)
            const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
            if (payerMembers.length > 0) {
              expense.payer_data = calculateDistribution(expense.amount, payerMembers, expense.payer_data, payerMembers[0], precision)
            }
            if (splitMembers.length > 0) {
              expense.split_details = calculateDistribution(expense.amount, splitMembers, expense.split_details, adjustMember, precision)
            }

            const photo_ids = [messageId]
            const nonce = Math.random().toString(36).substring(2, 10)
            const exp_short = {
              d: expense.description, a: expense.amount, c: expense.currency,
              dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
            }

            // storePendingExpense 與 chat history insert 並行執行
            await storePendingExpense(sourceId, nonce, { exp: exp_short, p: photo_ids, tid: tripId })

            const historySummary = `[記帳建議] ${JSON.stringify({ ...expense, photo_ids }, null, 2)}`
            supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary }).then(() => {})

            const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
            const liffData = encodeBase64(new TextEncoder().encode(JSON.stringify({ ...exp_short, pi: photo_ids, n: nonce, u: sourceId })))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const liffUrl = `${WEBAPP_URL}/#/liff/edit?tripId=${trip.id}&data=${liffData}`

            await replyMessage(replyToken, [{
              type: "flex", altText: `收據辨識預覽: ${expense.description}`,
              contents: {
                type: "bubble",
                hero: { type: "image", url: publicUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
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
                        { type: "text", text: "分帳明細", color: "#aaaaaa", size: "xs" },
                        ...Object.entries(expense.split_details).map(([name, amt]) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: `• ${name}`, size: "xs", color: "#666666" }, { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }] }))
                      ]}
                    ]}
                  ]
                },
                footer: {
                  type: "box", layout: "vertical", spacing: "sm",
                  contents: [
                    { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: "✅ 確認存入", data: JSON.stringify({ act: "save", n: nonce }) } },
                    { type: "box", layout: "horizontal", spacing: "sm", contents: [
                      { type: "button", style: "primary", color: "#5AC8FA", action: { type: "uri", label: "✏️ 編輯", uri: liffUrl } },
                      { type: "button", style: "secondary", action: { type: "postback", label: "❌ 取消", data: JSON.stringify({ act: "cancel", n: nonce }) } }
                    ]},
                    { type: "button", style: "primary", color: "#AF52DE", action: { type: "uri", label: "🌐 查看網頁", uri: webUrl } }
                  ]
                }
              }
            }], sourceId)
          } else if (res.type === 'not_receipt') {
            console.log(`[PHOTO] Not a receipt, silently deleting: ${filePath}`)
            await supabase.storage.from('travel-images').remove([filePath])
          } else {
            console.log(`[PHOTO] Non-expense photo response, deleting: ${filePath}`)
            await supabase.storage.from('travel-images').remove([filePath])
            await replyMessage(replyToken, [{ type: 'text', text: res.content || '抱歉，這張照片我辨識不出來。' }], sourceId)
          }
        } catch (e) {
          console.error('[OCR_ERROR]', e)
          await supabase.storage.from('travel-images').remove([filePath])
          const msg = isRateLimit(e) ? RATE_LIMIT_MSG : '😵 處理圖片時發生錯誤，請稍後再試。'
          await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
        }
        continue
      }

      // --- 非文字訊息則跳過處理 ---
      if (event.type !== 'message' || event.message.type !== 'text') {
        console.log(`[SKIP] Not a text message event.`)
        continue
      }

      const userText = event.message.text.trim()
      console.log(`[USER_TEXT] "${userText}"`)

      const isMentioned = event.message.mention?.mentionees?.some((m: any) => m.isSelf === true)
      const isIdCommand = userText.toUpperCase().startsWith('ID:') || userText.toUpperCase().startsWith('ID：')
      const QUICK_CMD_KEYWORDS = ['今日支出', '今天支出', '本週支出', '近期支出', '本月支出', '結算', '旅程總覽']
      const isUndoKeyword = userText === '取消上一筆' || userText === '撤銷上一筆'
      const isToggleKeyword = userText === '模式:全回應模式' || userText === '模式:提及模式'
      const isManagement = userText.startsWith('設定') || userText === '斷開' || userText === '切換旅程' || QUICK_CMD_KEYWORDS.includes(userText) || isUndoKeyword || isToggleKeyword

      // 「耀西」必須出現在訊息開頭（去除 @mention 前綴後），避免誤觸
      const strippedForTrigger = userText.replace(/@\S+\s*/g, '').trimStart()
      const startsWithYoshi = strippedForTrigger.startsWith('耀西')

      // 群組觸發邏輯：
      //   - 全回應模式（mention_required=false）→ 處理所有訊息
      //   - 快捷指令、設定指令 → 免觸發
      //   - AI 記帳/聊天 → 須 @提及 或名字開頭
      let shouldProcess = !isGroup
      if (isGroup) {
        if (!mentionRequired) {
          // 全回應模式：群組所有訊息皆處理
          shouldProcess = true
        } else if (isMentioned || startsWithYoshi) {
          // @提及 或名字開頭：完整處理
          shouldProcess = true
        } else if (!isBound) {
          // 未綁定：僅允許 ID 綁定流程
          if (isIdCommand || isBinding) shouldProcess = true
        } else if (isBound && (isIdCommand || isManagement)) {
          // 已綁定：管理指令（含切換觸發模式）免觸發
          shouldProcess = true
        }
      }

      if (!shouldProcess) {
        console.log(`[SKIP] Group message without trigger/mention.`)
        continue
      }

      const cleanText = userText.replace(/@\S+\s*/g, '').replace(/^耀西\s*/, '').trim()

      // 0. 純喚醒詞「耀西」或「如何使用」按鈕 → 回傳自我介紹
      if (cleanText === '' || cleanText === '耀西') {
        await replyMessage(replyToken, [{ type: 'text', text: BOT_SELF_INTRODUCTION, quickReply: isBound ? boundQR : getQuickReply(false) }], sourceId)
        continue
      }

      // 1. ID 綁定 / 切換旅程
      if (cleanText.toUpperCase().startsWith('ID:') || cleanText.toUpperCase().startsWith('ID：')) {
        const linebotId = cleanText.substring(3).trim().toUpperCase()
        const { data: mapping } = await supabase.from('line_trip_id_mapping').select('trip_id').eq('linebot_id', linebotId).maybeSingle()
        if (mapping) {
          if (userState?.current_trip_id === mapping.trip_id) {
            await replyMessage(replyToken, [{ type: 'text', text: '✅ 您已綁定此旅程，無需重複綁定。' }], sourceId)
          } else {
            const msg = userState?.current_trip_id
              ? '🔄 已找到旅程！請輸入新旅程密碼（原旅程連結將解除）。'
              : '🔍 已找到旅程！請輸入密碼驗證。'
            await supabase.from('line_user_states').update({ pending_trip_id: mapping.trip_id, current_trip_id: null }).eq('line_user_id', sourceId)
            await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
          }
        } else {
          await replyMessage(replyToken, [{ type: 'text', text: `❌ 找不到代碼 [${linebotId}]` }], sourceId)
        }
        continue
      }

      // 2. 斷開
      if (isBound && (cleanText === '斷開' || cleanText === '切換旅程')) {
        await supabase.from('line_user_states').update({ current_trip_id: null, pending_trip_id: null }).eq('line_user_id', sourceId)
        await replyMessage(replyToken, [{ type: 'text', text: '❌ 已解除連接。如需重新連接，請輸入 ID:您的代碼', quickReply: getQuickReply(false) }], sourceId); continue
      }

      // 3. 切換群組回應模式
      if (isBound && (cleanText === '模式:全回應模式' || cleanText === '模式:提及模式')) {
        const newMentionRequired = cleanText === '模式:提及模式'
        await supabase.from('line_user_states').update({ mention_required: newMentionRequired }).eq('line_user_id', sourceId)
        const msg = newMentionRequired
          ? '🎯 已切換為提及模式。\n群組中需 @提及 或以「耀西」開頭才會回應。'
          : '📣 已切換為全回應模式。\n群組中所有訊息都會被耀西處理！'
        await replyMessage(replyToken, [{ type: 'text', text: msg, quickReply: getQuickReply(true, isGroup, newMentionRequired) }], sourceId)
        continue
      }

      // 4. 查看個人偏好設定
      if (isBound && (cleanText === '設定?' || cleanText === '設定？')) {
        const config = userState.default_config
        const msg = config
          ? `⚙️ 您目前的個人偏好設定：\n\n${config}\n\n如需修改，輸入「設定: 新設定內容」`
          : '⚙️ 您尚未設定個人偏好。\n\n輸入「設定: 預設代杰付款，大家均分」來設定。'
        await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
        continue
      }

      // 4. 設定偏好
      if (isBound && (cleanText.startsWith('設定:') || cleanText.startsWith('設定：'))) {
        const config = cleanText.substring(3).trim()
        if (!config) {
          await replyMessage(replyToken, [{ type: 'text', text: '⚙️ 設定內容不能為空，請輸入偏好內容，例如：\n「設定: 預設代杰付款，大家均分」' }], sourceId)
          continue
        }
        await supabase.from('line_user_states').update({ default_config: config }).eq('line_user_id', sourceId)
        await replyMessage(replyToken, [{ type: 'text', text: `⚙️ 已更新您的偏好，之後記帳時會參考此設定。` }], sourceId)
        continue
      }

      // 5. 密碼驗證
      if (isBinding) {
        const { data: trip } = await supabase.from('trips').select('access_code, name, members').eq('id', userState.pending_trip_id).maybeSingle()
        if (trip?.access_code === cleanText) {
          await supabase.from('line_user_states').update({ current_trip_id: userState.pending_trip_id, pending_trip_id: null }).eq('line_user_id', sourceId)
          await replyMessage(replyToken, [{
            type: 'text',
            text: `✅ 綁定成功：\n${trip.name}\n\n目前成員：\n${trip.members.join('、')}\n\n旅程網頁：\n${WEBAPP_URL}/#/trip/${userState.pending_trip_id}/dashboard\n\n現在您可以直接「打字或上傳收據」請我記帳，或輸入個人喜好「設定: 預設付款人是代杰，大家平分」囉！`,
            quickReply: boundQR
          }], sourceId)
        } else {
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 密碼錯誤' }], sourceId)
        }
        continue
      }

      // 6. AI 核心
      if (isBound) {
        const tripId = userState.current_trip_id

        // 撤銷上一筆（文字指令）
        const isUndoText = cleanText === '取消上一筆' || cleanText === '撤銷上一筆'
        if (isUndoText) {
          const { data: savedHistory } = await supabase.from('line_chat_history')
            .select('content')
            .eq('line_user_id', sourceId)
            .eq('role', 'saved')
            .order('created_at', { ascending: false })
            .limit(1)
          if (savedHistory && savedHistory.length > 0) {
            try {
              const saved = JSON.parse(savedHistory[0].content)
              const { error } = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', saved.expense_id)
              if (error) throw error
              await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${saved.description}`, quickReply: boundQR }], sourceId)
            } catch {
              await replyMessage(replyToken, [{ type: 'text', text: '❌ 撤銷失敗，請至網頁手動刪除。' }], sourceId)
            }
          } else {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到可以撤銷的最近記錄。' }], sourceId)
          }
          continue
        }

        // ── 快捷指令（直接查 DB，不走 AI）──
        if (cleanText === '今日支出' || cleanText === '今天支出') {
          const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates, default_currency').eq('id', tripId).single()
          const today = getTodayString(getTripTimezone(trip))
          const { data: todayExp } = await supabase.from('expenses')
            .select('description, amount, currency, category')
            .eq('trip_id', tripId).eq('date', today)
            .is('deleted_at', null).not('is_settlement', 'is', true)
            .order('created_at', { ascending: true })
          if (!todayExp || todayExp.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: `📅 今日（${today.substring(5)}）尚無支出記錄。`, quickReply: boundQR }], sourceId)
          } else {
            const lines = todayExp.map((e: any) => `• ${e.description}  ${e.amount} ${e.currency}  [${e.category}]`)
            const totals: Record<string, number> = {}
            todayExp.forEach((e: any) => { totals[e.currency] = (totals[e.currency] || 0) + e.amount })
            const totalStr = Object.entries(totals).map(([c, a]) => `${a} ${c}`).join('・')
            await replyMessage(replyToken, [{ type: 'text', text: `📅 今日支出（${today.substring(5)}）\n\n${lines.join('\n')}\n\n共 ${todayExp.length} 筆 · 合計 ${totalStr}`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '本週支出' || cleanText === '近期支出') {
          const { data: trip } = await supabase.from('trips').select('name, base_currency, rates, default_currency').eq('id', tripId).single()
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          const fromDate = new Intl.DateTimeFormat('en-CA', { timeZone: getTripTimezone(trip) }).format(sevenDaysAgo)
          const { data: weekExp } = await supabase.from('expenses')
            .select('description, amount, currency, category, date')
            .eq('trip_id', tripId).gte('date', fromDate)
            .is('deleted_at', null).not('is_settlement', 'is', true)
            .order('date', { ascending: false }).limit(30)
          if (!weekExp || weekExp.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: '📊 近 7 天內尚無支出記錄。', quickReply: boundQR }], sourceId)
          } else {
            const byDate: Record<string, any[]> = {}
            weekExp.forEach((e: any) => { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e) })
            const lines: string[] = []
            Object.entries(byDate).forEach(([date, exps]) => {
              lines.push(`📌 ${date.substring(5)}`)
              exps.forEach((e: any) => lines.push(`  • ${e.description}  ${e.amount} ${e.currency}`))
            })
            await replyMessage(replyToken, [{ type: 'text', text: `📊 近 7 天支出\n\n${lines.join('\n')}\n\n共 ${weekExp.length} 筆`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '本月支出') {
          const { data: trip } = await supabase.from('trips').select('name, base_currency, rates, default_currency').eq('id', tripId).single()
          const tz = getTripTimezone(trip)
          const todayStr = getTodayString(tz)
          const monthStart = todayStr.substring(0, 7) + '-01'
          const { data: monthExp } = await supabase.from('expenses')
            .select('description, amount, currency, category, date')
            .eq('trip_id', tripId).gte('date', monthStart)
            .is('deleted_at', null).not('is_settlement', 'is', true)
            .order('date', { ascending: false }).limit(50)
          if (!monthExp || monthExp.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: `📊 本月（${monthStart.substring(0, 7)}）尚無支出記錄。`, quickReply: boundQR }], sourceId)
          } else {
            const byDate: Record<string, any[]> = {}
            monthExp.forEach((e: any) => { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e) })
            const lines: string[] = []
            Object.entries(byDate).forEach(([date, exps]) => {
              lines.push(`📌 ${date.substring(5)}`)
              exps.forEach((e: any) => lines.push(`  • ${e.description}  ${e.amount} ${e.currency}`))
            })
            const totals: Record<string, number> = {}
            monthExp.forEach((e: any) => { totals[e.currency] = (totals[e.currency] || 0) + e.amount })
            const totalStr = Object.entries(totals).map(([c, a]) => `${a} ${c}`).join('・')
            let text = `📊 本月支出（${monthStart.substring(0, 7)}）\n\n${lines.join('\n')}\n\n共 ${monthExp.length} 筆 · 合計 ${totalStr}`
            if (text.length > 4900) text = text.substring(0, 4900) + '\n...(過多省略)'
            await replyMessage(replyToken, [{ type: 'text', text, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '結算') {
          const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates').eq('id', tripId).single()
          const { data: allExp } = await supabase.from('expenses')
            .select('amount, currency, payer_data, split_data, is_settlement')
            .eq('trip_id', tripId).is('deleted_at', null)
          const rates = trip.rates || {}
          const baseCurrency = trip.base_currency
          const grandTotal: Record<string, Decimal> = {}
          trip.members.forEach((m: string) => { grandTotal[m] = new Decimal(0) })
          ;(allExp || []).forEach((e: any) => {
            if (e.is_settlement) return
            const rate = e.currency === baseCurrency ? 1 : (rates[e.currency] || 1)
            trip.members.forEach((m: string) => {
              const net = new Decimal(e.payer_data?.[m] || 0).minus(new Decimal(e.split_data?.[m] || 0))
              grandTotal[m] = grandTotal[m].plus(net.times(rate))
            })
          })
          const grandTotalNum: Record<string, number> = {}
          Object.entries(grandTotal).forEach(([m, v]) => { grandTotalNum[m] = v.toNumber() })
          const settlements = calculateSettlements(grandTotalNum)
          if (settlements.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: '✅ 目前一切已結清，無需轉帳！', quickReply: boundQR }], sourceId)
          } else {
            const lines = settlements.map(s => `${s.from} → ${s.to}  ${Math.round(s.amount)} ${baseCurrency}`)
            await replyMessage(replyToken, [{ type: 'text', text: `💰 結算試算（折合 ${baseCurrency}）\n\n${lines.join('\n')}\n\n🌐 詳細：${WEBAPP_URL}/#/trip/${tripId}/dashboard`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '旅程總覽') {
          const { data: trip } = await supabase.from('trips').select('name, members, base_currency, is_archived').eq('id', tripId).single()
          const today = getTodayString(getTripTimezone(trip))
          const { data: allExp } = await supabase.from('expenses')
            .select('amount, currency').eq('trip_id', tripId)
            .is('deleted_at', null).not('is_settlement', 'is', true)
          const totals: Record<string, number> = {}
          ;(allExp || []).forEach((e: any) => { totals[e.currency] = (totals[e.currency] || 0) + e.amount })
          const totalStr = Object.keys(totals).length > 0
            ? Object.entries(totals).map(([c, a]) => `  ${a} ${c}`).join('\n')
            : '  （尚無支出）'
          const status = trip.is_archived ? '已封存 🔒' : '進行中 ✈️'
          await replyMessage(replyToken, [{ type: 'text', text: `🗺️ ${trip.name}（${status}）\n\n👥 成員：${trip.members.join('、')}\n📅 今日：${today}\n💵 主幣別：${trip.base_currency}\n\n📊 支出總計：\n${totalStr}\n\n🌐 ${WEBAPP_URL}/#/trip/${tripId}/dashboard`, quickReply: boundQR }], sourceId)
          continue
        }

        const [{ data: trip }, { data: expenses }, { data: history }] = await Promise.all([
          supabase.from('trips').select('*').eq('id', tripId).single(),
          supabase.from('expenses')
            .select('description, amount, currency, category, date, photo_urls')
            .eq('trip_id', tripId)
            .is('deleted_at', null)
            .not('is_settlement', 'is', true)
            .order('date', { ascending: false })
            .limit(10),
          // 排除 pending/saved 內部記錄，只取對話歷史
          supabase.from('line_chat_history').select('role, content').eq('line_user_id', sourceId).in('role', ['user', 'model']).order('created_at', { ascending: true }).limit(6)
        ])
        // fire-and-forget：不阻塞主流程
        supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'user', content: cleanText }).then(() => {})

        // 約 10% 機率清理 30 天前的對話記錄，降低 DB 寫入頻率
        if (Math.random() < 0.1) {
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
          supabase.from('line_chat_history').delete().eq('line_user_id', sourceId).lt('created_at', thirtyDaysAgo).then(() => {})
          // line_processed_actions 超過 7 天的 nonce 可安全移除
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
          supabase.from('line_processed_actions').delete().lt('created_at', sevenDaysAgo).then(() => {})
        }

        const today = getTodayString(getTripTimezone(trip))

        const expensesSummary = (expenses ?? []).map((e: any) => {
          const base = `${e.date} ${e.description} ${e.amount}${e.currency} [${e.category}]`
          if (e.photo_urls?.length > 0) {
            const { data: { publicUrl } } = supabase.storage.from('travel-images').getPublicUrl(e.photo_urls[0])
            return `${base} [收據照片: ${publicUrl}]`
          }
          return base
        }).join('\n')

        const promptInstruction = `你是旅遊記帳小幫手「耀西」（瑪利歐系列角色），偶爾穿插「Yoshi!」叫聲。若使用者打招呼或問自我介紹，親切介紹自己可以記帳、查詢支出、分析收據等功能。

【旅程】${trip.name}｜成員：${trip.members.join('、')}｜分類：${trip.categories.join('、')}（預設：${trip.default_category || '無'}）
【幣別】${JSON.stringify(trip.rates)}，主幣：${trip.base_currency}，預設：${trip.default_currency || '無'}
【今日】${today}｜${trip.is_archived ? '⚠️ 已封存（唯讀，禁止記帳）' : '進行中'}
【使用者設定】${userState.default_config || '無'}｜傳訊者：${memberName}
【旅程預設付款人】${trip.default_payer?.length ? trip.default_payer.join('、') : '無'}｜預設分攤：${trip.default_split_members?.length ? trip.default_split_members.join('、') : '全員'}

【規則】
- 記帳 → {"type":"expense","data":{...}}；聊天/查詢 → {"type":"chat","content":"..."}
- 已封存時嚴禁回傳 expense，改用 chat 告知。
- payer_data（墊付）優先權：①旅程預設付款人 ②使用者設定 ③傳訊者對應成員 ④成員第一位
- split_details（分攤）優先權：①旅程預設分攤 ②使用者設定 ③全員均分
- 成員名稱只能從「成員清單」中選取；金額盡量無小數，但總和必須完全相等。
- 幣別優先順序：使用者說明 > 使用者設定 > 旅程預設幣別。
- 歷史支出僅供查詢，勿重複記錄。
- 若使用者詢問某筆含收據照片的支出細節（品項、翻譯等），回傳 analyze_photo JSON，讓系統重新分析照片作答。

【近期對話】
${(history ?? []).map(h => `${h.role === 'user' ? 'U' : 'Y'}: ${h.content}`).join('\n')}

【近期支出（最近10筆）】
${expensesSummary}

---
使用者說：「${userText}」

判斷：
A. 若歷史含「記帳建議」且使用者想修正 → 回傳修正後的 expense JSON，保留原 photo_ids。
B. 若使用者想記錄新支出 → 回傳 expense JSON（無 photo_ids）。
C. 其他聊天/查詢 → 回傳 chat JSON，查詢用條列式換行呈現。
D. 若使用者詢問某筆有收據照片支出的詳細內容（如品項明細、外文翻譯等）→ 回傳 analyze_photo JSON，url 填入近期支出中對應的收據照片網址，question 填入使用者問題。

JSON schema（expense）: {"type":"expense","data":{"description":"","amount":0,"currency":"","date":"YYYY-MM-DD","category":"","payer_data":{},"split_details":{},"photo_ids":[]}}
JSON schema（chat）: {"type":"chat","content":""}
JSON schema（analyze_photo）: {"type":"analyze_photo","url":"完整收據照片網址（若近期10筆中找不到符合的支出，url 填空字串，系統會自動全庫搜尋）","question":"使用者的具體問題"}
`

        try {
          const aiResponse = await askGemini([{ role: "user", parts: [{ text: promptInstruction }] }])
          const res = JSON.parse(extractJSON(aiResponse))
          if (res.type === 'expense') {
            const expense = res.data

            const precision = (trip?.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
            expense.amount = new Decimal(expense.amount || 0).toDecimalPlaces(precision).toNumber()
            const payerMembers = Object.keys(expense.payer_data)
            const splitMembers = Object.keys(expense.split_details)
            const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
            if (payerMembers.length > 0) {
              expense.payer_data = calculateDistribution(expense.amount, payerMembers, expense.payer_data, payerMembers[0], precision)
            }
            if (splitMembers.length > 0) {
              expense.split_details = calculateDistribution(expense.amount, splitMembers, expense.split_details, adjustMember, precision)
            }

            const historySummary = `[記帳建議] ${JSON.stringify(expense, null, 2)}`
            // fire-and-forget：不阻塞回覆流程
            supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary }).then(() => {})

            const exp_short = {
              d: expense.description, a: expense.amount, c: expense.currency,
              dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
            }
            const nonce = Math.random().toString(36).substring(2, 10)
            const photo_ids = expense.photo_ids || []

            let heroSection: any = null
            if (photo_ids.length > 0) {
              const firstId = photo_ids[0]
              const filePath = firstId.includes('/') ? firstId : `expenses/${trip.id}/${firstId}.jpg`
              const { data: { publicUrl } } = supabase.storage.from('travel-images').getPublicUrl(filePath)
              heroSection = { type: "image", url: publicUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" }
            }

            const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
            const liffData = encodeBase64(new TextEncoder().encode(JSON.stringify({ ...exp_short, pi: photo_ids, n: nonce, u: sourceId })))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const liffUrl = `${WEBAPP_URL}/#/liff/edit?tripId=${trip.id}&data=${liffData}`

            // storePendingExpense 與 replyMessage 並行執行，縮短回覆延遲
            await Promise.all([
              storePendingExpense(sourceId, nonce, { exp: exp_short, p: photo_ids, tid: tripId }),
              replyMessage(replyToken, [{
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
                          { type: "text", text: "分帳明細", color: "#aaaaaa", size: "xs" },
                          ...Object.entries(expense.split_details).map(([name, amt]) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: `• ${name}`, size: "xs", color: "#666666" }, { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" }] }))
                        ]}
                      ]}
                    ]
                  },
                  footer: {
                    type: "box", layout: "vertical", spacing: "sm",
                    contents: [
                      { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: "✅ 確認存入", data: JSON.stringify({ act: "save", n: nonce }) } },
                      { type: "box", layout: "horizontal", spacing: "sm", contents: [
                        { type: "button", style: "primary", color: "#5AC8FA", action: { type: "uri", label: "✏️ 編輯", uri: liffUrl } },
                        { type: "button", style: "secondary", action: { type: "postback", label: "❌ 取消", data: JSON.stringify({ act: "cancel", n: nonce }) } }
                      ]},
                      { type: "button", style: "primary", color: "#AF52DE", action: { type: "uri", label: "🌐 查看網頁", uri: webUrl } }
                    ]
                  }
                }
              }], sourceId)
            ])
          } else if (res.type === 'analyze_photo') {
            const photoUrl = res.url as string | undefined
            const question = res.question || '請詳細描述此收據的所有品項與金額'

            if (photoUrl) {
              // URL 已在近期10筆中，直接分析
              await replyMessage(replyToken, [{ type: 'text', text: '🔍 正在重新分析收據照片，請稍候...' }], sourceId)
              try {
                const content = await analyzeReceiptPhoto(photoUrl, question)
                supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content }).then(() => {})
                await pushMessage(sourceId, [{ type: 'text', text: content, quickReply: boundQR }])
              } catch (photoErr) {
                console.error('[ANALYZE_PHOTO_ERROR]', photoErr)
                const msg = isRateLimit(photoErr) ? RATE_LIMIT_MSG : '😵 無法重新分析照片，請稍後再試。'
                await pushMessage(sourceId, [{ type: 'text', text: msg, quickReply: boundQR }])
              }
            } else {
              // URL 不在近期10筆中，全庫搜尋有照片的支出
              await replyMessage(replyToken, [{ type: 'text', text: '🔍 正在查詢符合描述的支出紀錄...' }], sourceId)
              try {
                const { data: allExpenses } = await supabase.from('expenses')
                  .select('description, amount, currency, category, date, photo_urls')
                  .eq('trip_id', tripId)
                  .is('deleted_at', null)
                  .not('is_settlement', 'is', true)
                  .order('date', { ascending: false })

                const withPhotos = (allExpenses ?? []).filter((e: any) => e.photo_urls?.length > 0)

                if (withPhotos.length === 0) {
                  await pushMessage(sourceId, [{ type: 'text', text: '😅 此旅程中找不到任何帶有收據照片的支出紀錄。', quickReply: boundQR }])
                } else {
                  const expenseList = withPhotos.map((e: any) => {
                    const { data: { publicUrl } } = supabase.storage.from('travel-images').getPublicUrl(e.photo_urls[0])
                    return `${e.date} ${e.description} ${e.amount}${e.currency} [${e.category}] [照片: ${publicUrl}]`
                  }).join('\n')

                  const selectPrompt = `以下是旅程中所有附有收據照片的支出記錄：
${expenseList}

使用者問題：${question}

請找出最符合使用者描述的那一筆，回傳 JSON：
若找到 → {"found": true, "url": "完整照片網址", "description": "支出描述"}
若找不到 → {"found": false}`

                  const selectText = await askGemini([{ role: "user", parts: [{ text: selectPrompt }] }])
                  const selectRes = JSON.parse(extractJSON(selectText))

                  if (!selectRes.found) {
                    await pushMessage(sourceId, [{ type: 'text', text: '😅 找不到符合描述的收據照片，請試著描述得更詳細一點，例如加上日期、店名或金額。', quickReply: boundQR }])
                  } else {
                    await pushMessage(sourceId, [{ type: 'text', text: `✅ 找到了！正在分析「${selectRes.description}」的收據照片...` }])
                    try {
                      const content = await analyzeReceiptPhoto(selectRes.url, question)
                      supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content }).then(() => {})
                      await pushMessage(sourceId, [{ type: 'text', text: content, quickReply: boundQR }])
                    } catch (analyzeErr) {
                      console.error('[ANALYZE_PHOTO_AFTER_SEARCH_ERROR]', analyzeErr)
                      const msg = isRateLimit(analyzeErr) ? RATE_LIMIT_MSG : '😵 照片分析失敗，請稍後再試。'
                      await pushMessage(sourceId, [{ type: 'text', text: msg, quickReply: boundQR }])
                    }
                  }
                }
              } catch (searchErr) {
                console.error('[SEARCH_PHOTO_ERROR]', searchErr)
                const msg = isRateLimit(searchErr) ? RATE_LIMIT_MSG : '😵 查詢過程發生錯誤，請稍後再試。'
                await pushMessage(sourceId, [{ type: 'text', text: msg, quickReply: boundQR }])
              }
            }
          } else {
            let safeContent = res.content || ""
            if (safeContent.length > 4900) safeContent = safeContent.substring(0, 4900) + "\n\n...(內容過長已截斷)"
            if (!safeContent) safeContent = 'Yoshi! 🥚 有什麼需要幫忙的嗎？'
            supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: safeContent }).then(() => {})
            await replyMessage(replyToken, [{ type: 'text', text: safeContent, quickReply: boundQR }], sourceId)
          }
        } catch (e) {
          console.error('[AI_ERROR]', e)
          const msg = isRateLimit(e) ? RATE_LIMIT_MSG : '😵 AI 處理時發生錯誤，請稍後再試。'
          await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
        }
        continue
      }

      // 7. 其他，尚未綁定狀態下的聊天
      await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程。', quickReply: getQuickReply(false) }], sourceId)
    }
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[GLOBAL_ERROR]', err)
    return new Response('Error', { status: 500 })
  }
})
