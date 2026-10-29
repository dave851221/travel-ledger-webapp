// ============================================================
// _shared/ai/types.ts —— 與 AI 供應商無關的介面
//
// handlers 只認得這裡的 `AiProvider`：一次性的 `generate`（OCR、轉錄、挑選）
// 與 function calling 的 `runToolLoop`（LINE 文字路徑）。
// 各家怎麼把它翻成自己的 API 寫在同一層的各自檔案裡：
//   gemini.ts   Google Gemini（免費額度）
//   claude.ts   Anthropic Claude
//   fallback.ts 主要的失敗時改用備援
//
// ⚠️ 這一層**不碰 Deno.env、不建 client**：key 與 client 由呼叫端注入，
//    所以整個資料夾都能在 vitest 下用假 client 測試。
// ============================================================

import type { FunctionDeclaration, JsonSchema } from "../tools/types.ts"

export type { FunctionDeclaration, JsonSchema }

// ============================================================
// 訊息
// ============================================================

export interface AiTextPart { text: string }

/** 圖片或音檔，base64 編碼。`mimeType` 只是提示，各家可能自己再判斷一次。 */
export interface AiMediaPart { media: { mimeType: string; data: string } }

export type AiPart = AiTextPart | AiMediaPart

export interface AiMessage {
  role: 'user' | 'assistant'
  parts: AiPart[]
}

export const isMediaPart = (part: AiPart): part is AiMediaPart => 'media' in part

/**
 * 這次呼叫要處理什麼。各家依此挑模型（例如 Gemini 的視覺模型清單），
 * 也藉此知道自己做不做得到（Claude 沒有音訊輸入）。
 */
export type AiTask = 'text' | 'vision' | 'audio'

// ============================================================
// 一次性呼叫
// ============================================================

export interface GenerateRequest {
  task: AiTask
  messages: AiMessage[]
  /** 不隨對話變動的規則（人設、輸出約束） */
  system?: string
  /** 要求回 JSON。給了 schema 就由 API 保證格式 */
  json?: boolean
  schema?: JsonSchema
  /** 只有支援的供應商會採用（Claude Haiku 5.5 不接受非預設值，會忽略） */
  temperature?: number
  /** 主要的供應商失敗、這次改由備援回答時呼叫（見 fallback.ts）。呼叫端藉此告訴使用者。 */
  onFallback?: (reason: FallbackReason) => void
}

/** quota＝主要的那家額度用完（AI_QUOTA:）；error＝其他失敗（逾時、過載、格式錯誤） */
export type FallbackReason = 'quota' | 'error'

/**
 * 讓模型自己上網搜尋。只有 Claude 支援（Anthropic 的 server tool，一次搜尋另外計費），
 * 其他供應商直接忽略這個選項 —— 所以 prompt 不能假設它一定在。
 */
export interface WebSearchOptions {
  /** 一則訊息最多搜尋幾次（整個迴圈合計） */
  maxUses: number
  /** 大概的所在地，搜尋「附近的餐廳」時用得到 */
  location?: { city?: string; country?: string; timezone?: string }
}

// ============================================================
// function calling 迴圈
// ============================================================

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface ToolLoopRequest {
  task: 'text' | 'vision'
  messages: AiMessage[]
  system?: string
  declarations: FunctionDeclaration[]
  /** 這幾支一被呼叫就結束迴圈，由呼叫端決定要做什麼 */
  terminalNames: string[]
  /** 執行一支讀取工具。丟例外時會把錯誤訊息回給模型，不會中斷迴圈。 */
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** 模型完全沒呼叫函式時，純文字要當成哪一支終結函式（預設 `reply`） */
  replyName?: string
  maxRounds?: number
  /** 絕對時間（epoch ms）。超過就強迫收尾，不再發讀工具的回合。 */
  deadlineAt?: number
  temperature?: number
  webSearch?: WebSearchOptions
  onFallback?: (reason: FallbackReason) => void
}

export interface ToolLoopResult {
  kind: 'terminal'
  call: ToolCall
  /** 同一輪裡除了終結呼叫之外，模型還講了的話（`reply` 與 `propose_*` 同時出現時） */
  extraText?: string
  /** 最後真正回答的是哪一個模型。記 log 用。 */
  model: string
}

// ============================================================
// 供應商
// ============================================================

export interface AiProvider {
  /** 記 log 用，例如 `gemini`、`claude` */
  readonly name: string
  /** 做不做得到這類工作。`fallback.ts` 靠它決定要不要直接交給備援。 */
  supports(task: AiTask): boolean
  /** 回傳模型的文字（要求 JSON 時就是 JSON 字串） */
  generate(req: GenerateRequest): Promise<string>
  runToolLoop(req: ToolLoopRequest): Promise<ToolLoopResult>
}

// ============================================================
// 錯誤
//
// 對使用者顯示的訊息靠 message 的前綴分辨（line-webhook/config.ts 的 aiUnavailableMessage）：
//   RATE_LIMIT:  免費額度用完，要隔天才會恢復
//   AI_QUOTA:    付費的花費上限或儲值用完，要到後台處理
//   AI_BUSY:     暫時忙碌或逾時，過幾分鐘再試
// ============================================================

/** 換一個模型（或換一家）再試就有機會成功的錯誤：429、5xx、逾時、空回應。 */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryableError'
  }
}

/** 換模型也沒用的錯誤（schema 寫錯、金鑰不對）。直接往外丟，不要吞。 */
export class FatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FatalError'
  }
}

/**
 * 所有模型都失敗時要丟的錯誤。
 *
 * 只有**每個**模型都回 429（免費額度用完）才是 `RATE_LIMIT:`，那種情況要隔天才會恢復。
 * 逾時、503 過載、空回應一律是 `AI_BUSY:` —— 對面暫時忙不過來，過幾分鐘再試就好。
 * 以前不分青紅皂白都丟 RATE_LIMIT，伺服器過載時使用者會被叫去「隔天再試」。
 */
export const allModelsFailedError = (failures: string[], provider = 'Gemini'): Error => {
  const last = failures[failures.length - 1] ?? 'no model was tried'
  const quota = failures.length > 0 && failures.every((f) => f === 'HTTP 429')
  return quota
    ? new Error(`RATE_LIMIT: Every ${provider} model is out of free quota. Last error: ${last}`)
    : new Error(`AI_BUSY: All ${provider} models failed or timed out. Last error: ${last}`)
}
