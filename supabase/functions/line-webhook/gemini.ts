// ============================================================
// gemini.ts —— 呼叫 Gemini 的一切
//
// 模型清單與退化順序、結構化輸出的 schema、系統指令，
// 以及三條使用路徑：文字／收據 OCR（askGemini）、
// 重新閱讀收據（analyzeReceiptPhoto）、語音轉文字（transcribeAudio）。
//
// import config.ts（API key）與 line-api.ts（下載語音內容）。
// ============================================================

import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { GEMINI_API_KEY } from "./config.ts"
import { downloadLineContent } from "./line-api.ts"
import { extractJSON } from "../_shared/validate.ts"

/**
 * 給 AI 的成員別名提示。
 *
 * 以前這段直接把「代杰／阿杰／Jay／小杰」寫死在 prompt 裡，
 * 對其他旅程來說那是一個不存在的人名，只會變成噪音。
 * 改成用這趟旅程實際的成員舉例。
 */
export function memberAliasHint(members: string[]): string {
  if (!members || members.length === 0) return ''
  const sample = members[0]
  return `\n【成員名稱】只能使用：${members.join('、')}
使用者可能用暱稱或簡稱（例如把「${sample}」說成別的叫法），請對應回上面清單裡的正式名稱；
對應不出來時就用 chat 反問，不要自己造一個名字。\n`
}

/** 下載收據照片並轉成 Gemini 需要的 inlineData */
export async function fetchPhotoPart(photoUrl: string): Promise<any | null> {
  try {
    const res = await fetch(photoUrl)
    if (!res.ok) {
      console.warn(`[REANALYZE] Failed to fetch photo: ${res.status}`)
      return null
    }
    const buf = await res.arrayBuffer()
    return { inlineData: { mimeType: 'image/jpeg', data: encodeBase64(new Uint8Array(buf)) } }
  } catch (err) {
    console.warn('[REANALYZE] photo fetch error:', err)
    return null
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
export const AMOUNT_LIST_SCHEMA = {
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

export const EXPENSE_DATA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    description: { type: 'STRING', description: '品項或商店名稱。外文請保留原文並在括號附繁體中文' },
    amount: { type: 'NUMBER', description: '總金額' },
    currency: { type: 'STRING', description: 'ISO 幣別代碼，例如 TWD / JPY / USD。只在 currency_source 不是 none 時才有意義' },
    // 幣別由程式決定而不是靠 prompt 記性（T3）：模型只需誠實回報「這個幣別是哪裡來的」，
    // 真正要填哪一個由 resolveCurrencyByRule() 依規則決定。
    currency_source: {
      type: 'STRING',
      enum: ['stated', 'preference', 'none'],
      description: 'stated＝使用者這句話（或收據上）明確出現幣別字眼或符號；preference＝記帳偏好指定；none＝都沒有',
    },
    date: { type: 'STRING', description: 'YYYY-MM-DD' },
    category: { type: 'STRING', description: '從分類清單中挑一個' },
    payer_data: AMOUNT_LIST_SCHEMA,
    split_details: AMOUNT_LIST_SCHEMA,
  },
  required: ['description', 'amount', 'currency', 'currency_source', 'date', 'category', 'payer_data', 'split_details'],
}

/** 文字對話：可能是記帳、聊天／查詢，或請系統重新分析某張收據 */
export const TEXT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['expense', 'chat', 'analyze_photo'] },
    data: EXPENSE_DATA_SCHEMA,
    content: { type: 'STRING', description: 'type 為 chat 時的回覆內容' },
    // 只回編號，不要網址：要模型逐字抄回長網址，它常抄成上一輪對話裡的另一張（T4）
    expense_ref: {
      type: 'STRING',
      description: 'analyze_photo 時填近期支出的編號，例如 #3；不在清單裡就留空字串',
    },
    question: { type: 'STRING', description: 'type 為 analyze_photo 時使用者的問題' },
    corrects_draft: {
      type: 'STRING',
      description: '若這句話是在修正某張尚未確認的記帳草稿，填該草稿的 nonce；否則留空字串',
    },
  },
  required: ['type'],
}

/** 收據 OCR：認得出來就回 expense，不是收據就回 not_receipt */
export const OCR_RESPONSE_SCHEMA = {
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
export const YOSHI_SYSTEM_INSTRUCTION = `你是旅遊記帳小幫手「耀西」，瑪利歐系列的角色，講話親切、偶爾穿插「Yoshi!」叫聲。
你的工作是把使用者的自然語言轉成記帳資料，或回答關於這趟旅程花費的問題。

不可違反的規則：
1. payer_data 與 split_details 的 key **只能**是使用者訊息中提供的「成員清單」裡的字串，一字不差。
   使用者用暱稱、諧音或縮寫時，可以合理推測對應到清單裡最接近的成員，並改用清單上的正式名稱。
   若沒把握對應到誰，寧可回傳 chat 詢問，**絕對不可以**自創或音譯出清單外的名字。
2. 金額盡量不帶小數，但 payer_data 與 split_details 的各自總和都必須完全等於 amount。
   🚫 **嚴禁換算匯率。** 使用者說「3000 日幣」就填 amount: 3000、currency: "JPY"，
   不可以自行換成旅程的主幣別。換算由系統在統計時處理。
   訊息裡**沒有出現幣別字眼**（日幣／円／¥／台幣／NT／美金／$ 之類）時，
   currency_source 填 "none"，currency 填旅程的**記帳預設幣別**（不是結算主幣別）。
3. 旅程已封存時，一律不可回傳 expense，改用 chat 說明無法記帳。
4. 歷史支出僅供查詢參考，不要把既有的支出重複記一次。
5. 查詢類的回答用條列式、簡短，適合在手機上閱讀。
6. 🚫 你**沒有**刪除或修改「已經存檔」的支出的能力。
   絕對不可以說「已經幫你刪除了」「我已經改好了」這類話 —— 那是假的。
   使用者想刪除或修改既有紀錄時，請回覆：請輸入「刪除支出」或「編輯支出」，
   系統會列出近期紀錄讓他點選。
   （你能做的只有：提出新的記帳建議、修正尚未存檔的草稿、以及查詢。）
7. 🚫 **金額類的問題不要自己做算術。** 訊息裡的【全趟彙總】是伺服器用 Decimal 算好的
   精確數字（總額、每人已付／應付／淨額、各分類、筆數、日期範圍），直接引用即可。
   【近期支出】只有最近 10 筆，把它們加起來當成總額一定是錯的。
   彙總裡已經有逐日合計與「金額最大的幾筆」，日期類與排名類的問題也直接引用。
   真的沒被涵蓋到的（例如被標為「省略」的那幾天）就照實說算不出來，請他到網頁看，不要硬湊。
8. analyze_photo 的 expense_ref 只填近期支出清單上的編號（例如 "#3"），不要填網址或店名。
   使用者說「剛剛」「最新」又沒指名店名時，選清單裡日期最近且有 📷 的那一筆。
   問的那筆不在清單上就把 expense_ref 留空字串，系統會自己去全庫找。`

// For text tasks: start with the thinking model (better reasoning)
export const GEMINI_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite', // 500 RPD free tier
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
]

// For OCR (vision + JSON mode): gemini-2.0-flash is more reliable than thinking models.
// Thinking models (gemini-2.5-flash) tend to output minimal valid JSON ("not_receipt")
// even for real receipts when JSON mode is enforced.
export const GEMINI_OCR_MODELS = [
  'gemini-3.1-flash-lite', // 500 RPD free tier
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
]

export interface AskGeminiOptions {
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

export async function askGemini(contents: any[], options: AskGeminiOptions = {}) {
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
 * 重新閱讀某一筆支出的收據並回答問題。
 *
 * ⚠️ 一筆支出可能有多張收據照片（長帳單拍兩張），以前只分析 `photo_urls[0]`，
 *    第二張上的品項使用者永遠問不到 —— 現在全部一起送進去（T4）。
 *    prompt 開頭標明「這幾張是同一筆支出的收據」，模型才不會當成不相干的圖各自作答。
 */
export async function analyzeReceiptPhoto(
  photoUrls: string[],
  question: string,
  expenseLabel: string,
): Promise<string> {
  const parts: any[] = []
  for (const url of photoUrls) {
    const part = await fetchPhotoPart(url)
    if (part) parts.push(part)
  }
  if (parts.length === 0) throw new Error('Failed to fetch any receipt photo')

  const analyzePrompt = `以下 ${parts.length} 張是同一筆支出「${expenseLabel}」的收據${parts.length > 1 ? '（同一筆的不同頁／不同張，請合併判讀）' : ''}。
請詳細分析並以繁體中文回答問題。若收據為外文（日文、韓文等），請逐項翻譯。
使用者的問題：${question}
回傳 JSON: {"type":"chat","content":"詳細的繁體中文回答，條列式呈現品項"}`
  const analysisText = await askGemini([{
    role: "user",
    parts: [{ text: analyzePrompt }, ...parts],
  }], { useJsonMode: false, models: GEMINI_OCR_MODELS })
  try {
    const analysisRes = JSON.parse(extractJSON(analysisText))
    return analysisRes.content || analysisText
  } catch {
    return analysisText.substring(0, 4900)
  }
}

/**
 * LINE 語音訊息的格式固定是 m4a（AAC）。
 * Gemini 的 inlineData 吃得下，不需要自己轉檔。
 */
export const AUDIO_MIME = 'audio/m4a'
/** 語音訊息通常只有幾秒鐘；超過這個大小多半是出了什麼問題，不要浪費額度 */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

/**
 * 把語音訊息轉成文字（M15）。
 *
 * ⚠️ 刻意「先轉文字、再走原本的文字流程」，而不是把音檔直接丟給記帳的 schema：
 *    這樣快捷指令（「今日支出」）、草稿修正（「剛剛那筆改 500」）、
 *    取消、編輯清單……全部都能用語音講，而不是只有記帳。
 *    代價是多一次 Gemini 呼叫。
 */
export async function transcribeAudio(messageId: string): Promise<string> {
  const res = await downloadLineContent(messageId)
  if (!res.ok) throw new Error(`Failed to download audio from LINE: ${res.status}`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error('AUDIO_TOO_LARGE')

  const prompt = `請把這段語音**逐字**轉成繁體中文文字。
只輸出聽到的內容本身，不要加上任何說明、引號或前後綴。
聽不清楚、沒有人聲或只有雜音時，輸出空字串。`

  const text = await askGemini([{
    role: 'user',
    parts: [
      { text: prompt },
      { inlineData: { mimeType: AUDIO_MIME, data: encodeBase64(new Uint8Array(buf)) } },
    ],
  }], { useJsonMode: false, models: GEMINI_OCR_MODELS, temperature: 0 })

  // 模型偶爾會自己加引號包住整句
  return text.trim().replace(/^["'「『]+|["'」』]+$/g, '').trim()
}
