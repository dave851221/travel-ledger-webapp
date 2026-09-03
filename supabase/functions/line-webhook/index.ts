import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"
import { encodeBase64, decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { Decimal } from "../_shared/deps.ts"
import { calculateDistribution, calculateSettlements, DEFAULT_PRECISION } from "../_shared/finance.ts"

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') || ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const WEBAPP_URL = Deno.env.get('WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp'


// 收據照片的 bucket。路徑慣例 expenses/{tripId}/{檔名}，
// supabase/scripts/delete_trip.sql 依賴這個前綴清理照片，勿隨意更名。
const RECEIPTS_BUCKET = 'travel-images'

const RATE_LIMIT_MSG = '⚠️ AI 服務暫時達到免費使用量上限，請隔天再試。'
const isRateLimit = (e: any) => String(e?.message).startsWith('RATE_LIMIT:')

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function getQuickReply(bound: boolean, showGroupToggle = false, mentionRequired = true) {
  if (!bound) {
    return {
      items: [
        { type: "action", action: { type: "message", label: "❓ 使用說明", text: "使用說明" } },
      ]
    }
  }
  const items: any[] = [
    { type: "action", action: { type: "message", label: "📅 今日支出", text: "今日支出" } },
    { type: "action", action: { type: "message", label: "📊 本月支出", text: "本月支出" } },
    { type: "action", action: { type: "message", label: "💰 結算", text: "結算" } },
    { type: "action", action: { type: "message", label: "🗺️ 旅程總覽", text: "旅程總覽" } },
    { type: "action", action: { type: "message", label: "🗑 刪除支出", text: "刪除支出" } },
    { type: "action", action: { type: "message", label: "❓ 使用說明", text: "使用說明" } },
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

// 收集 expense 中提到但不在旅程成員清單內的名字，回傳去重後的陣列

/**
 * 給 AI 的成員別名提示。
 *
 * 以前這段直接把「代杰／阿杰／Jay／小杰」寫死在 prompt 裡，
 * 對其他旅程來說那是一個不存在的人名，只會變成噪音。
 * 改成用這趟旅程實際的成員舉例。
 */
function memberAliasHint(members: string[]): string {
  if (!members || members.length === 0) return ''
  const sample = members[0]
  return `\n【成員名稱】只能使用：${members.join('、')}
使用者可能用暱稱或簡稱（例如把「${sample}」說成別的叫法），請對應回上面清單裡的正式名稱；
對應不出來時就用 chat 反問，不要自己造一個名字。\n`
}

/**
 * 把 AI 回傳的金額欄位統一成 { 成員: 金額 }。
 *
 * 接受兩種形式：
 *   - [{ member, amount }]  ← response_schema 產生的陣列
 *   - { 成員: 金額 }         ← 舊版草稿與沒有 schema 的模型可能仍回這種
 */
function toAmountMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (Array.isArray(value)) {
    for (const entry of value) {
      const member = String((entry as any)?.member ?? '').trim()
      if (!member) continue
      out[member] = (out[member] ?? 0) + (Number((entry as any)?.amount) || 0)
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = Number(v) || 0
    }
  }
  return out
}

/** 就地把 expense 的金額欄位正規化成 map */
function normalizeExpenseAmountMaps(expense: any): void {
  if (!expense) return
  expense.payer_data = toAmountMap(expense.payer_data)
  expense.split_details = toAmountMap(expense.split_details ?? expense.split_data)
}

/** 餵給 AI 的對話輪數。太多會稀釋掉當下這句話的份量。 */
const CHAT_HISTORY_TURNS = 8

/**
 * 把歷史紀錄壓成適合當對話輪次的內容。
 *
 * 存進 line_chat_history 的 model 訊息是 `[記帳建議] {整包 JSON}`。
 * 直接把那串 JSON 當成模型自己說過的話餵回去，它很容易改去修那筆舊草稿
 * 而不是回應使用者當下這句話 —— 尤其在有 response_schema 約束的情況下。
 * 壓成一行摘要，既保留「剛剛那筆改 500」需要的指代對象，又不會蓋過新訊息。
 */
function summarizeHistoryEntry(role: string, content: string): string {
  if (role !== 'model' || !content.startsWith('[記帳建議]')) {
    return content.length > 300 ? content.slice(0, 300) + '…' : content
  }
  try {
    const draft = JSON.parse(content.slice('[記帳建議]'.length).trim())
    const parts = [draft.description, draft.amount, draft.currency].filter(Boolean).join(' ')
    return `（我先前提出的記帳建議：${parts}）`
  } catch {
    return '（我先前提出過一筆記帳建議）'
  }
}

/** 把字串正規化後比較：忽略大小寫、全半形空白與常見標點 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\u3000._-]/g, '')
    .trim()
}

/**
 * 把 AI 給的名字對應回成員清單裡的正式名稱。
 *
 * 依序嘗試：完全相同 → 正規化後相同 → 其中一方是另一方的子字串
 * （涵蓋「小明」對「王小明」、「Amy」對「amy」這類情況）。
 * 仍然對不上就回傳 null，讓呼叫端去問使用者，而不是硬猜。
 */
function resolveMember(name: string, members: string[]): string | null {
  if (!name) return null
  if (members.includes(name)) return name

  const target = normalizeName(name)
  if (!target) return null

  const exact = members.find(m => normalizeName(m) === target)
  if (exact) return exact

  const partial = members.filter(m => {
    const n = normalizeName(m)
    return n.includes(target) || target.includes(n)
  })
  // 只有唯一解才算數，兩個以上一樣像就代表有歧義，寧可去問
  return partial.length === 1 ? partial[0] : null
}

/**
 * 把 expense 裡的成員 key 盡量對應回正式名稱。
 * 回傳對應後的物件，以及真的對不上的名字。
 */
function resolveExpenseMembers(
  expense: any,
  members: string[],
): { unresolved: string[] } {
  const unresolved: string[] = []

  for (const field of ['payer_data', 'split_details', 'split_data']) {
    const data = expense?.[field]
    if (!data || typeof data !== 'object') continue

    const remapped: Record<string, number> = {}
    for (const [rawName, value] of Object.entries(data)) {
      const resolved = resolveMember(rawName, members)
      if (resolved) {
        // 同一位成員被指到兩次時金額相加，不要互相覆蓋
        remapped[resolved] = (remapped[resolved] ?? 0) + (Number(value) || 0)
      } else {
        unresolved.push(rawName)
      }
    }
    expense[field] = remapped
  }

  return { unresolved: [...new Set(unresolved)] }
}

/** ISO 4217 常見幣別，用來擋掉 AI 幻想出來的代碼 */
const KNOWN_CURRENCIES = new Set([
  'TWD', 'JPY', 'USD', 'EUR', 'KRW', 'CNY', 'HKD', 'GBP', 'AUD', 'CAD',
  'SGD', 'THB', 'MYR', 'PHP', 'VND', 'IDR', 'NZD', 'CHF', 'MOP', 'INR',
])

/**
 * 驗證幣別。
 *
 * 之前完全不檢查：AI 回傳的字串直接寫進資料庫，未知幣別會被當成 2 位小數，
 * 結算時匯率當 1，金額就默默失真了。
 * 旅程 rates 裡有的最優先，其次是 ISO 白名單，都不符就退回旅程主幣別。
 */
function normalizeCurrency(
  currency: unknown,
  trip: { rates?: Record<string, number>; base_currency: string; default_currency?: string },
): { currency: string; warning: string | null; reject: string | null } {
  const raw = String(currency ?? '').trim().toUpperCase()
  const fallback = trip.default_currency || trip.base_currency
  const available = Object.keys(trip.rates ?? {})

  if (!raw) return { currency: fallback, warning: null, reject: null }

  // 旅程有設匯率 → 正常放行
  if (trip.rates && Object.prototype.hasOwnProperty.call(trip.rates, raw)) {
    return { currency: raw, warning: null, reject: null }
  }

  // 是合法幣別，但這趟旅程沒有它的匯率。
  // 不能就這樣存進去：統計會以 1:1 換算，金額直接失真且事後難以察覺。
  if (KNOWN_CURRENCIES.has(raw)) {
    return {
      currency: raw,
      warning: null,
      reject: `🙅 這趟旅程沒有設定 ${raw} 的匯率，先存起來的話統計會算錯。\n\n`
        + `目前可用的幣別：${available.join('、') || '（尚未設定）'}\n\n`
        + `請改用上面其中一種，或先到網頁的「設定 → 匯率精度」加入 ${raw} 的匯率。`,
    }
  }

  // 根本不是幣別代碼 —— 多半是 AI 看錯，退回旅程預設並告知
  return {
    currency: fallback,
    warning: `⚠️ 無法辨識幣別「${raw}」，已改用 ${fallback}。`,
    reject: null,
  }
}

/**
 * 驗證日期。
 *
 * 之前也是直接寫進資料庫，沒有格式或範圍檢查 ——
 * AI 算錯年份就會出現 2019 或 2031 年的支出。
 * 格式錯或超出今天前後一年就退回今天。
 */
function normalizeDate(date: unknown, today: string): { date: string; warning: string | null } {
  const raw = String(date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { date: today, warning: raw ? `⚠️ 日期格式無法辨識，已改用今天 ${today}。` : null }
  }

  const parsed = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    return { date: today, warning: `⚠️ 日期無效，已改用今天 ${today}。` }
  }

  const todayMs = new Date(`${today}T00:00:00Z`).getTime()
  const ONE_YEAR = 365 * 24 * 60 * 60 * 1000
  if (Math.abs(parsed.getTime() - todayMs) > ONE_YEAR) {
    return { date: today, warning: `⚠️ 日期 ${raw} 距離今天超過一年，已改用今天 ${today}。` }
  }

  return { date: raw, warning: null }
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
• 可輸入「設定:預設由我付款，所有人均分金額。」
(可記錄最後一筆設定，設定後 AI 會參考您的習慣進行解析)

💰 快速記帳相關功能：
• 基礎：可直接說「晚餐 1200」
• 收據分析：直接上傳照片
• 指定付款：說「小明付了Uber 300」
• 複雜分帳：說「拉麵 3000 日幣，小明先付，大家平分」
• 修正記帳：說「剛剛那筆改 500」
• 撤銷記帳：輸入「取消上一筆」或「刪除上一筆」
• 刪除任一筆：輸入「刪除支出」，會列出近期紀錄讓你點選

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

// 旅程密碼為選填：access_code 為 NULL 或全空白時代表免密碼，綁定不需驗證
function requiresAccessCode(code: string | null | undefined): boolean {
  return !!(code && code.trim())
}

function buildBindSuccessText(tripName: string, members: string[], tripId: string): string {
  return `✅ 綁定成功：\n${tripName}\n\n目前成員：\n${(members || []).join('、')}\n\n旅程網頁：\n${WEBAPP_URL}/#/trip/${tripId}/dashboard\n\n現在您可以直接「打字或上傳收據」請我記帳，或輸入個人喜好「設定: 預設付款人是我，大家平分」囉！`
}

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !LINE_CHANNEL_SECRET) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  // decodeBase64 回傳 Uint8Array<ArrayBufferLike>，新版 TS lib 不再視為 BufferSource
  const sigBytes = decodeBase64(signature) as unknown as BufferSource
  return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body))
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
  }], { useJsonMode: false, models: GEMINI_OCR_MODELS })
  try {
    const analysisRes = JSON.parse(extractJSON(analysisText))
    return analysisRes.content || analysisText
  } catch {
    return analysisText.substring(0, 4900)
  }
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

// ============================================================
// 結構化輸出
//
// 以前是在 prompt 裡手寫 JSON 範例，靠 extractJSON 撈括號硬救格式錯誤。
// 交給 response_schema 之後，格式由 API 保證，prompt 只需專注在「內容」。
// ============================================================

// Gemini 的 response_schema 不支援 additionalProperties，
// 所以「成員 → 金額」不能寫成動態 key 的物件，只能用陣列表達。
// 解析後由 toAmountMap() 轉回程式內部慣用的 { 成員: 金額 }。
const AMOUNT_LIST_SCHEMA = {
  type: 'ARRAY',
  description: '每位成員分到的金額',
  items: {
    type: 'OBJECT',
    properties: {
      member: { type: 'STRING', description: '成員名稱，必須一字不差地來自成員清單' },
      amount: { type: 'NUMBER' },
    },
    required: ['member', 'amount'],
  },
}

const EXPENSE_DATA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    description: { type: 'STRING', description: '品項或商店名稱。外文請保留原文並在括號附繁體中文' },
    amount: { type: 'NUMBER', description: '總金額' },
    currency: { type: 'STRING', description: 'ISO 幣別代碼，例如 TWD / JPY / USD' },
    date: { type: 'STRING', description: 'YYYY-MM-DD' },
    category: { type: 'STRING', description: '從分類清單中挑一個' },
    payer_data: AMOUNT_LIST_SCHEMA,
    split_details: AMOUNT_LIST_SCHEMA,
  },
  required: ['description', 'amount', 'currency', 'date', 'category', 'payer_data', 'split_details'],
}

/** 文字對話：可能是記帳、聊天／查詢，或請系統重新分析某張收據 */
const TEXT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['expense', 'chat', 'analyze_photo'] },
    data: EXPENSE_DATA_SCHEMA,
    content: { type: 'STRING', description: 'type 為 chat 時的回覆內容' },
    url: { type: 'STRING', description: 'type 為 analyze_photo 時的收據照片網址' },
    question: { type: 'STRING', description: 'type 為 analyze_photo 時使用者的問題' },
  },
  required: ['type'],
}

/** 收據 OCR：認得出來就回 expense，不是收據就回 not_receipt */
const OCR_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['expense', 'not_receipt'] },
    data: EXPENSE_DATA_SCHEMA,
  },
  required: ['type'],
}

/**
 * 不隨對話變動的規則。放進 system_instruction 與每次的旅程 context 分開，
 * 模型比較不會在長對話中把人設或格式規則忘掉。
 */
const YOSHI_SYSTEM_INSTRUCTION = `你是旅遊記帳小幫手「耀西」，瑪利歐系列的角色，講話親切、偶爾穿插「Yoshi!」叫聲。
你的工作是把使用者的自然語言轉成記帳資料，或回答關於這趟旅程花費的問題。

不可違反的規則：
1. payer_data 與 split_details 的 key **只能**是使用者訊息中提供的「成員清單」裡的字串，一字不差。
   使用者用暱稱、諧音或縮寫時，可以合理推測對應到清單裡最接近的成員，並改用清單上的正式名稱。
   若沒把握對應到誰，寧可回傳 chat 詢問，**絕對不可以**自創或音譯出清單外的名字。
2. 金額盡量不帶小數，但 payer_data 與 split_details 的各自總和都必須完全等於 amount。
3. 旅程已封存時，一律不可回傳 expense，改用 chat 說明無法記帳。
4. 歷史支出僅供查詢參考，不要把既有的支出重複記一次。
5. 查詢類的回答用條列式、簡短，適合在手機上閱讀。`

// For text tasks: start with the thinking model (better reasoning)
const GEMINI_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite', // 500 RPD free tier
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
]

// For OCR (vision + JSON mode): gemini-2.0-flash is more reliable than thinking models.
// Thinking models (gemini-2.5-flash) tend to output minimal valid JSON ("not_receipt")
// even for real receipts when JSON mode is enforced.
const GEMINI_OCR_MODELS = [
  'gemini-3.1-flash-lite', // 500 RPD free tier
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
]

interface AskGeminiOptions {
  /** 要求回傳 JSON。搭配 schema 時模型會被結構化輸出約束住 */
  useJsonMode?: boolean
  models?: string[]
  /** 不隨對話變動的規則（人設、輸出約束），與每次的旅程 context 分開 */
  systemInstruction?: string
  /** 回應的 JSON schema。給了就不必在 prompt 裡手寫格式範例 */
  responseSchema?: Record<string, unknown>
  /** 記帳要穩定，聊天可以活潑一點 */
  temperature?: number
}

async function askGemini(contents: any[], options: AskGeminiOptions = {}) {
  const {
    useJsonMode = true,
    models = GEMINI_FALLBACK_MODELS,
    systemInstruction,
    responseSchema,
    temperature,
  } = options

  const generationConfig: Record<string, unknown> = {}
  if (useJsonMode) generationConfig.response_mime_type = 'application/json'
  // 結構化輸出：由 API 保證格式，比在 prompt 裡描述 JSON 範例可靠得多
  if (useJsonMode && responseSchema) generationConfig.response_schema = responseSchema
  if (temperature !== undefined) generationConfig.temperature = temperature

  const body: Record<string, unknown> = { contents, generationConfig }
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] }
  }

  let lastError: string | null = null

  for (const model of models) {
    console.log(`[AI] Calling Gemini model: ${model}`)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      // 連線失敗／逾時也換下一個模型，不要整個放棄
      lastError = `fetch failed: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[AI] ${model} ${lastError}, trying next model...`)
      continue
    }

    if (response.status === 429) {
      lastError = 'rate limited'
      console.warn(`[AI] Rate limited on ${model}, trying next model...`)
      continue
    }
    if (response.status === 404 || response.status === 400) {
      // 404：模型已下架。400：這個模型不支援送出的設定（例如舊模型不吃 response_schema）
      lastError = `HTTP ${response.status}`
      console.warn(`[AI] ${model} rejected the request (${response.status}), trying next model...`)
      continue
    }
    if (response.status >= 500) {
      lastError = `HTTP ${response.status}`
      console.warn(`[AI] ${model} server error ${response.status}, trying next model...`)
      continue
    }
    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini API error ${response.status}: ${errText}`)
    }

    const data = await response.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      // 安全機制擋下或思考預算用盡都可能回空，換模型比直接失敗好
      lastError = `empty response (finishReason: ${data?.candidates?.[0]?.finishReason ?? 'unknown'})`
      console.warn(`[AI] ${model} returned ${lastError}, trying next model...`)
      continue
    }
    return text
  }

  throw new Error(`RATE_LIMIT: All Gemini models are currently rate limited or unavailable. Last error: ${lastError}`)
}

/**
 * 取得發言者的 LINE 顯示名稱。
 *
 * group 與 room 走不同的 endpoint —— 原本只處理 group，
 * 導致多人聊天室的發言者永遠是「未知」，還被當成身分餵進 prompt。
 */
async function getChatMemberName(
  sourceType: 'group' | 'room',
  chatId: string,
  userId: string,
): Promise<string> {
  try {
    const endpoint = sourceType === 'group'
      ? `https://api.line.me/v2/bot/group/${chatId}/member/${userId}`
      : `https://api.line.me/v2/bot/room/${chatId}/member/${userId}`
    const response = await fetch(
      endpoint,
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

      // 群組／聊天室共用同一份綁定與偏好（刻意的設計，讓大家都能記同一本帳），
      // 但每次互動仍要看得出是誰做的。
      const speakerUserId: string | null = event.source.userId ?? null
      let memberName = "未知";
      // postback 也要查：存檔確認訊息是在 postback 分支送出的，
      // 少了這個就會顯示「由 未知 記錄」。
      const needsMemberName =
        (event.type === 'message' && (event.message?.type === 'text' || event.message?.type === 'image'))
        || event.type === 'postback';
      if ((sourceType === "group" || sourceType === "room") && needsMemberName && speakerUserId) {
        const chatId = event.source.groupId || event.source.roomId
        const fetchedName = await getChatMemberName(sourceType, chatId, speakerUserId);
        memberName = fetchedName || `User_${speakerUserId.substring(0, 8)}`;
      }
      // 一對一聊天不需要打 API，發言者就是對話本身
      const speakerLabel = isGroup ? memberName : null

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

        // 從「刪除支出」清單點選的刪除
        if (postbackData.act === 'del') {
          const expenseId = postbackData.eid
          if (!expenseId) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這筆支出。' }], sourceId)
            continue
          }
          const { data: target } = await supabase.from('expenses')
            .select('description, deleted_at').eq('id', expenseId).maybeSingle()

          if (!target) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 這筆支出已不存在。' }], sourceId)
            continue
          }
          if (target.deleted_at) {
            await replyMessage(replyToken, [{
              type: 'text', text: `ℹ️ 「${target.description}」先前已經刪除了。`, quickReply: boundQR,
            }], sourceId)
            continue
          }

          const { error } = await supabase.from('expenses')
            .update({ deleted_at: new Date().toISOString() }).eq('id', expenseId)
          if (error) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 刪除失敗，請至網頁操作。' }], sourceId)
          } else {
            const by = speakerLabel ? `（由 ${speakerLabel} 刪除）` : ''
            await replyMessage(replyToken, [{
              type: 'text',
              text: `🗑 已刪除：${target.description}${by}\n\n24 小時內可到網頁的垃圾桶還原。`,
              quickReply: boundQR,
            }], sourceId)
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

          if (!trip) {
            // 旅程可能已被刪除（見 docs/DB_MAINTENANCE.md），此時舊卡片的按鈕不該讓整個函式崩掉
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId);
            continue;
          }
          if (trip.is_archived) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 此旅程已封存，無法新增支出。' }], sourceId);
            continue;
          }

          const precision = (trip.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
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
              content: JSON.stringify({
                expense_id: savedExpense.id,
                description: expense.description,
                by: speakerLabel,
              }),
              speaker_user_id: speakerUserId, speaker_name: speakerLabel,
            }).then(() => {})
          }

          // 存入後附帶撤銷快速按鈕，讓使用者可即時反悔
          const undoItems = savedExpense?.id
            ? [{ type: "action", action: { type: "postback", label: "↩️ 撤銷", data: JSON.stringify({ act: "undo", eid: savedExpense.id, d: expense.description }) } }]
            : []
          // 群組裡標明是誰記的，一對一就不必贅述
          const savedBy = speakerLabel ? `\n（由 ${speakerLabel} 記錄）` : ''
          await replyMessage(replyToken, [{
            type: 'text', text: `✅ 已存入：${expense.description}${savedBy}`,
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
            await supabase.storage.from(RECEIPTS_BUCKET).remove(urls)
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

          if (trip?.is_archived) {
            console.log(`[PHOTO] Trip ${tripId} is archived, ignoring photo from ${sourceId}`)
            continue
          }

          const imageBuffer = await lineRes.arrayBuffer()

          console.log(`[STORAGE] Uploading to: ${filePath}`)
          const { error: uploadErr } = await supabase.storage.from(RECEIPTS_BUCKET).upload(filePath, imageBuffer, {
            contentType: 'image/jpeg', upsert: true
          })
          if (uploadErr) throw uploadErr

          const { data: { publicUrl } } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(filePath)
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
   - 🚫 payer_data 及 split_details 的 key **絕對只能**寫「成員清單」中已列出的字串，一字不差。
     若使用者用了暱稱、口誤、諧音或縮寫，可以合理推測對應到清單裡最接近的成員，並使用清單上的正式名稱。
     但若沒把握、找不到夠接近的對應，請寧可走「成員第一位 / 全員均分」的預設邏輯，**絕對不可以**自創、音譯、或把不存在的名字寫進 JSON。
   - 墊付邏輯的優先權(payer_data):
     1. 旅程預設付款人（若有設定）
     2. 使用者設定內所提及的預設付款人
     3. 根據上述的「使用者名稱」，判斷是否可對應到某一名成員，即該成員擔任付款人。(對應關係可能會在使用者設定中提及，但請注意務必要用「成員清單」內定義的名字)
     4. 由成員中第一位擔任付款人
   - 金額分攤邏輯的優先權(split_details):
     1. 旅程預設分攤成員（若有設定）
     2. 使用者設定所提及的分攤方式
     3. 全員均分
6. 回傳格式由系統的 response schema 約束，type 請填 "expense"。
   payer_data 與 split_details 都是陣列，每個元素是 { "member": "成員名稱", "amount": 金額 }。
7. 如果這看起來完全不像收據（例如：人物照、風景照、截圖等），請回傳 type: "not_receipt"，
   無需任何說明或讚美，系統會自動清除照片。
8. **重要限制**：若封存狀態為「已封存」，一律回傳 type: "not_receipt"，系統會另行告知使用者旅程已封存。
`

          const aiResponse = await askGemini([
            { role: "user", parts: [
              { text: ocrPrompt },
              { inlineData: { mimeType: "image/jpeg", data: base64Image } }
            ]}
          ], { models: GEMINI_OCR_MODELS, responseSchema: OCR_RESPONSE_SCHEMA, temperature: 0.2 })

          let res: any
          try {
            res = JSON.parse(extractJSON(aiResponse))
          } catch {
            console.error('[OCR] Non-JSON response:', aiResponse.substring(0, 200))
            await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
            await replyMessage(replyToken, [{ type: 'text', text: '😅 收據辨識格式異常，請重新傳送照片。' }], sourceId)
            continue
          }
          if (res.type === 'expense') {
            const expense = res.data

            normalizeExpenseAmountMaps(expense)

            // 成員名稱：先嘗試對應回正式名稱（暱稱、大小寫、部分符合都能救回來），
            // 真的對不上才放棄。以前是一律直接拒絕，使用者只能自己猜要怎麼講。
            const { unresolved } = resolveExpenseMembers(expense, trip.members)
            if (unresolved.length > 0) {
              console.warn(`[OCR] Unresolvable members: ${unresolved.join(', ')}`)
              await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
              await replyMessage(replyToken, [{
                type: 'text',
                text: `😅 我在這張收據的分帳中找不到下列成員：${unresolved.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n請確認名字是否正確，或在文字訊息中明確指定要用哪些成員，再重新傳送照片。`,
                quickReply: boundQR
              }], sourceId)
              continue
            }

            // 幣別與日期的把關。以前這兩個欄位是 AI 講什麼就寫什麼，
            // 幻想出來的幣別會讓金額在統計時默默失真，錯誤的年份則會讓支出跑到別的月份去。
            const ocrCurrency = normalizeCurrency(expense.currency, trip)
            if (ocrCurrency.reject) {
              // 沒有匯率就存下去，統計會以 1:1 換算而失真，寧可先問清楚
              await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
              await replyMessage(replyToken, [{
                type: 'text', text: ocrCurrency.reject, quickReply: boundQR,
              }], sourceId)
              continue
            }
            expense.currency = ocrCurrency.currency
            const ocrDate = normalizeDate(expense.date, today)
            expense.date = ocrDate.date
            const ocrWarnings = [ocrCurrency.warning, ocrDate.warning].filter(Boolean) as string[]

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

            // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西
            const ocrWarningMsg = ocrWarnings.length > 0
              ? [{ type: 'text' as const, text: ocrWarnings.join('\n') }]
              : []

            await replyMessage(replyToken, [...ocrWarningMsg, {
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
            await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
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
      const UNDO_KEYWORDS = ['取消上一筆', '撤銷上一筆', '刪除上一筆', '刪掉上一筆', '移除上一筆']
      const DELETE_LIST_KEYWORDS = ['刪除支出', '刪除紀錄', '刪除記錄', '管理支出', '刪除哪一筆']
      const isUndoKeyword = UNDO_KEYWORDS.includes(userText)
      const isDeleteListKeyword = DELETE_LIST_KEYWORDS.includes(userText)
      const isToggleKeyword = userText === '模式:全回應模式' || userText === '模式:提及模式'
      const isManagement = userText.startsWith('設定') || userText === '斷開' || userText === '切換旅程' || QUICK_CMD_KEYWORDS.includes(userText) || isUndoKeyword || isDeleteListKeyword || isToggleKeyword

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

      // 0a. 明確想看使用說明 → 完整介紹
      const HELP_KEYWORDS = ['使用說明', '說明', '教學', '怎麼用', '怎麼使用', '如何使用', 'help', 'HELP', 'Help', '功能']
      if (HELP_KEYWORDS.includes(cleanText)) {
        await replyMessage(replyToken, [{ type: 'text', text: BOT_SELF_INTRODUCTION, quickReply: isBound ? boundQR : getQuickReply(false) }], sourceId)
        continue
      }

      // 0b. 只是被叫到（純提及或只打「耀西」）→ 一句話 + 按鈕就好。
      //     大多數時候使用者只是想看有哪些按鈕可以按，不是要讀整篇說明。
      if (cleanText === '' || cleanText === '耀西') {
        const shortMsg = isBound
          ? 'Yoshi! 🥚 需要什麼？直接打「晚餐 300」就能記帳，或用下面的按鈕。'
          : 'Yoshi! 🥚 請先輸入「ID:旅程代碼」來連結旅程。'
        await replyMessage(replyToken, [{
          type: 'text',
          text: shortMsg,
          quickReply: isBound ? boundQR : getQuickReply(false),
        }], sourceId)
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
            const { data: targetTrip } = await supabase.from('trips').select('access_code, name, members').eq('id', mapping.trip_id).maybeSingle()
            if (targetTrip && !requiresAccessCode(targetTrip.access_code)) {
              // 免密碼旅程：略過驗證步驟，直接完成綁定
              await supabase.from('line_user_states').update({ current_trip_id: mapping.trip_id, pending_trip_id: null }).eq('line_user_id', sourceId)
              await replyMessage(replyToken, [{
                type: 'text',
                text: buildBindSuccessText(targetTrip.name, targetTrip.members, mapping.trip_id),
                quickReply: boundQR
              }], sourceId)
            } else {
              const msg = userState?.current_trip_id
                ? '🔄 已找到旅程！請輸入新旅程密碼（原旅程連結將解除）。'
                : '🔍 已找到旅程！請輸入密碼驗證。'
              await supabase.from('line_user_states').update({ pending_trip_id: mapping.trip_id, current_trip_id: null }).eq('line_user_id', sourceId)
              await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
            }
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
          : '⚙️ 您尚未設定個人偏好。\n\n輸入「設定: 預設由我付款，大家均分」來設定。'
        await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
        continue
      }

      // 4. 設定偏好
      if (isBound && (cleanText.startsWith('設定:') || cleanText.startsWith('設定：'))) {
        const config = cleanText.substring(3).trim()
        if (!config) {
          await replyMessage(replyToken, [{ type: 'text', text: '⚙️ 設定內容不能為空，請輸入偏好內容，例如：\n「設定: 預設由我付款，大家均分」' }], sourceId)
          continue
        }
        await supabase.from('line_user_states').update({ default_config: config }).eq('line_user_id', sourceId)
        await replyMessage(replyToken, [{ type: 'text', text: `⚙️ 已更新您的偏好，之後記帳時會參考此設定。` }], sourceId)
        continue
      }

      // 5. 密碼驗證
      if (isBinding) {
        const { data: trip } = await supabase.from('trips').select('access_code, name, members').eq('id', userState.pending_trip_id).maybeSingle()
        // 免密碼旅程（例如等待輸入期間密碼被移除）也直接放行
        if (trip && (!requiresAccessCode(trip.access_code) || trip.access_code === cleanText)) {
          await supabase.from('line_user_states').update({ current_trip_id: userState.pending_trip_id, pending_trip_id: null }).eq('line_user_id', sourceId)
          await replyMessage(replyToken, [{
            type: 'text',
            text: buildBindSuccessText(trip.name, trip.members, userState.pending_trip_id),
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

        // 列出近期支出讓使用者點選刪除。
        // 比「撤銷上一筆」好用：可以刪任何一筆，而不只是最後一筆。
        if (DELETE_LIST_KEYWORDS.includes(cleanText)) {
          const { data: recent } = await supabase.from('expenses')
            .select('id, description, amount, currency, date')
            .eq('trip_id', tripId)
            .is('deleted_at', null)
            .order('date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(8)

          if (!recent || recent.length === 0) {
            await replyMessage(replyToken, [{
              type: 'text', text: '目前沒有可刪除的支出紀錄。', quickReply: boundQR,
            }], sourceId)
            continue
          }

          // 每一列：左邊是描述與金額，右邊固定一顆小按鈕。
          // 按鈕文字刻意固定為「🗑 刪除」—— 把描述放進按鈕會讓按鈕寬度爆掉。
          const rows: any[] = []
          recent.forEach((e: any, idx: number) => {
            if (idx > 0) rows.push({ type: 'separator', margin: 'md' })
            rows.push({
              type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', alignItems: 'center',
              contents: [
                {
                  type: 'box', layout: 'vertical', flex: 5, contents: [
                    { type: 'text', text: String(e.description), size: 'sm', weight: 'bold', wrap: true },
                    { type: 'text', text: `${e.date} · ${e.amount} ${e.currency}`, size: 'xxs', color: '#aaaaaa', margin: 'xs' },
                  ],
                },
                {
                  type: 'button', flex: 2, style: 'secondary', height: 'sm',
                  action: { type: 'postback', label: '🗑 刪除', data: JSON.stringify({ act: 'del', eid: e.id }) },
                },
              ],
            })
          })

          await replyMessage(replyToken, [{
            type: 'flex', altText: '選擇要刪除的支出',
            contents: {
              type: 'bubble', size: 'mega',
              body: {
                type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: '🗑 選擇要刪除的支出', weight: 'bold', size: 'md' },
                  { type: 'text', text: `最近 ${recent.length} 筆 · 刪除後 24 小時內可於網頁還原`, size: 'xxs', color: '#aaaaaa', margin: 'xs', wrap: true },
                  { type: 'separator', margin: 'lg' },
                  ...rows,
                ],
              },
            },
          }], sourceId)
          continue
        }

        // 撤銷上一筆（文字指令）
        const isUndoText = UNDO_KEYWORDS.includes(cleanText)
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
              // 群組內任何人都能撤銷任何人的紀錄（刻意保留），但要講清楚撤掉的是誰記的那筆
              const originalBy = saved.by && saved.by !== speakerLabel ? `（原由 ${saved.by} 記錄）` : ''
              await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${saved.description}${originalBy}`, quickReply: boundQR }], sourceId)
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
          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
          const { data: allExp } = await supabase.from('expenses')
            .select('amount, currency, payer_data, split_data')
            .eq('trip_id', tripId).is('deleted_at', null)
          const rates = trip.rates || {}
          const baseCurrency = trip.base_currency
          const grandTotal: Record<string, Decimal> = {}
          trip.members.forEach((m: string) => { grandTotal[m] = new Decimal(0) })
          // 所有紀錄（含結清）都要計入餘額，用來計算誰該給誰多少錢
          ;(allExp || []).forEach((e: any) => {
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
            await replyMessage(replyToken, [{ type: 'text', text: `💰 結算試算建議（折合 ${baseCurrency}）\n\n${lines.join('\n')}\n\n🌐 詳細：${WEBAPP_URL}/#/trip/${tripId}/dashboard`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '旅程總覽') {
          const { data: trip } = await supabase.from('trips').select('name, members, base_currency, is_archived').eq('id', tripId).single()
          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
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
          // 排除 pending/saved 內部記錄，只取對話歷史。
          // ⚠️ 必須用 descending 取「最近的 N 筆」，之後再反轉回時間順序。
          //    寫成 ascending + limit 會永遠拿到史上最舊的那幾筆，
          //    對話窗口不會前進，AI 會一直停留在很久以前的內容。
          supabase.from('line_chat_history').select('role, content').eq('line_user_id', sourceId).in('role', ['user', 'model']).order('created_at', { ascending: false }).limit(CHAT_HISTORY_TURNS)
        ])
        // fire-and-forget：不阻塞主流程
        supabase.from('line_chat_history').insert({
          line_user_id: sourceId, role: 'user', content: cleanText,
          speaker_user_id: speakerUserId, speaker_name: speakerLabel,
        }).then(() => {})

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
            const { data: { publicUrl } } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(e.photo_urls[0])
            return `${base} [收據照片: ${publicUrl}]`
          }
          return base
        }).join('\n')

        // 只放「這次對話的當下狀態」。人設與不可變規則已在 YOSHI_SYSTEM_INSTRUCTION，
        // 輸出格式則交給 TEXT_RESPONSE_SCHEMA，不必再用文字描述一次。
        const tripContext = `【旅程】${trip.name}｜成員：${trip.members.join('、')}｜分類：${trip.categories.join('、')}（預設：${trip.default_category || '無'}）
【幣別】${JSON.stringify(trip.rates)}，主幣：${trip.base_currency}，預設：${trip.default_currency || '無'}
【今日】${today}｜${trip.is_archived ? '⚠️ 已封存（唯讀，禁止記帳）' : '進行中'}
【使用者設定】${userState.default_config || '無'}｜傳訊者：${memberName}
【旅程預設付款人】${trip.default_payer?.length ? trip.default_payer.join('、') : '無'}｜預設分攤：${trip.default_split_members?.length ? trip.default_split_members.join('、') : '全員'}

【判斷優先權】
- payer_data（墊付）：①旅程預設付款人 ②使用者設定 ③傳訊者對應的成員 ④成員第一位
- split_details（分攤）：①旅程預設分攤 ②使用者設定 ③全員均分
- 幣別：使用者明講 > 使用者設定 > 旅程預設幣別
${memberAliasHint(trip.members)}
【近期支出（最近10筆，僅供查詢參考）】
${expensesSummary || '（尚無支出）'}

【回應方式】
- 想記一筆新支出 → type: expense
- 想修正上一則「記帳建議」→ type: expense，帶上修正後的內容
- 詢問某筆有收據照片的支出細節（品項明細、外文翻譯等）→ type: analyze_photo，
  url 填近期支出中對應的照片網址（找不到就填空字串，系統會自動全庫搜尋），question 填使用者的問題
- 其他聊天或查詢 → type: chat`

        // 反轉回時間順序，並丟掉結尾沒有得到回覆的 user 訊息。
        // 留著的話，合併同角色輪次時它會跟「當下這句話」黏成同一輪，
        // 模型就分不清該回應哪一句了。
        const orderedHistory = [...(history ?? [])].reverse()
        while (orderedHistory.length > 0 && orderedHistory[orderedHistory.length - 1].role === 'user') {
          orderedHistory.pop()
        }

        // 真正的多輪對話。以前是把歷史壓成 "U: ... / Y: ..." 塞進單一 prompt，
        // 模型較難分辨哪些是自己說過的話。
        const rawConversation: any[] = [
          { role: 'user', parts: [{ text: tripContext }] },
          { role: 'model', parts: [{ text: '{"type":"chat","content":"了解，我已掌握這趟旅程的設定。"}' }] },
          // 查詢是新到舊，這裡反轉回舊到新才符合對話順序
          ...orderedHistory.map((h: any) => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: summarizeHistoryEntry(h.role, h.content) }],
          })),
          { role: 'user', parts: [{ text: cleanText }] },
        ]

        // Gemini 的 contents 預期 user / model 交替。歷史裡可能出現連續兩則 model
        // （例如拍照產生的草稿沒有對應的使用者文字），先合併起來避免格式異常。
        const conversation = rawConversation.reduce((acc: any[], turn: any) => {
          const prev = acc[acc.length - 1]
          if (prev && prev.role === turn.role) {
            prev.parts.push(...turn.parts)
          } else {
            acc.push({ role: turn.role, parts: [...turn.parts] })
          }
          return acc
        }, [])

        try {
          const aiResponse = await askGemini(conversation, {
            systemInstruction: YOSHI_SYSTEM_INSTRUCTION,
            responseSchema: TEXT_RESPONSE_SCHEMA,
            temperature: 0.4,
          })
          const res = JSON.parse(extractJSON(aiResponse))
          if (res.type === 'expense') {
            const expense = res.data

            normalizeExpenseAmountMaps(expense)

            // 同上：先試著把暱稱對應回正式名稱
            const { unresolved: unknownMembers } = resolveExpenseMembers(expense, trip.members)
            if (unknownMembers.length > 0) {
              console.warn(`[TEXT] Unknown members detected: ${unknownMembers.join(', ')}`)
              await replyMessage(replyToken, [{
                type: 'text',
                text: `😅 我從您的描述中辨識到不存在的成員：${unknownMembers.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n可能是名字打錯或漏字了，請改用正確的成員名稱再說一次。`,
                quickReply: boundQR
              }], sourceId)
              continue
            }

            // 幣別與日期的把關，與 OCR 路徑相同
            const textCurrency = normalizeCurrency(expense.currency, trip)
            if (textCurrency.reject) {
              await replyMessage(replyToken, [{
                type: 'text', text: textCurrency.reject, quickReply: boundQR,
              }], sourceId)
              continue
            }
            expense.currency = textCurrency.currency
            const textDate = normalizeDate(expense.date, today)
            expense.date = textDate.date
            const textWarnings = [textCurrency.warning, textDate.warning].filter(Boolean) as string[]

            const precision = (trip.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
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
              const { data: { publicUrl } } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(filePath)
              heroSection = { type: "image", url: publicUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" }
            }

            const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
            const liffData = encodeBase64(new TextEncoder().encode(JSON.stringify({ ...exp_short, pi: photo_ids, n: nonce, u: sourceId })))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const liffUrl = `${WEBAPP_URL}/#/liff/edit?tripId=${trip.id}&data=${liffData}`

            // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西
            const textWarningMsg = textWarnings.length > 0
              ? [{ type: 'text' as const, text: textWarnings.join('\n') }]
              : []

            // storePendingExpense 與 replyMessage 並行執行，縮短回覆延遲
            await Promise.all([
              storePendingExpense(sourceId, nonce, { exp: exp_short, p: photo_ids, tid: tripId }),
              replyMessage(replyToken, [...textWarningMsg, {
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
                await pushMessage(sourceId, [{ type: 'text', text: '😵 無法重新分析照片，請稍後再試。', quickReply: boundQR }])
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
                    const { data: { publicUrl } } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(e.photo_urls[0])
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
                      await pushMessage(sourceId, [{ type: 'text', text: '😵 照片分析失敗，請稍後再試。', quickReply: boundQR }])
                    }
                  }
                }
              } catch (searchErr) {
                console.error('[SEARCH_PHOTO_ERROR]', searchErr)
                await pushMessage(sourceId, [{ type: 'text', text: '😵 查詢過程發生錯誤，請稍後再試。', quickReply: boundQR }])
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
