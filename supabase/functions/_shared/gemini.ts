// ============================================================
// _shared/gemini.ts —— Gemini 的單次呼叫與 function calling 迴圈
//
// 這一層與 LINE 無關，也**不碰 Deno.env**：API key 與 fetch 都由呼叫端注入，
// 所以整支可以在 vitest（Node）下用假 client 測試（見 gemini.test.ts）。
// 未來的 MCP transport 若也要跑 AI 迴圈，用的是同一份。
//
// ⚠️ 三條已查證的 API 限制，違反的話症狀都很難看懂：
//   1. `generateContent` **不能同時**帶 `tools` 與 `responseMimeType: application/json`
//      （Gemini 3 以外直接 400）。所以走工具的路徑一律不用 JSON mode，
//      改用 `toolConfig.functionCallingConfig.mode = 'ANY'` 強迫每一輪都回 function call，
//      最終回覆也是一支函式（`reply`）。
//   2. Gemini 3 系列的 `functionCall` part 會帶 `thoughtSignature`，下一輪必須**原樣**送回，
//      而且簽章綁定模型。所以迴圈裡把模型回的 `candidate.content` 整個原樣 push 進 contents，
//      整個迴圈鎖定同一個模型；中途要換模型就從**原始** contents 重來。
//   3. `functionResponse.response` 必須是 JSON **物件**，陣列或字串要包成 `{ result }`。
//
// 欄位一律 camelCase（`systemInstruction`／`toolConfig`／`functionDeclarations`），
// 那是 proto3 JSON 的正式名稱，新程式碼不要再混用 snake_case。
// ============================================================

import type { GeminiFunctionDeclaration } from "./tools/types.ts"

// ============================================================
// 往來的資料形狀
// ============================================================

/**
 * 一個 part。API 上是「這幾個欄位挑一個」，但沒有判別欄位可以 narrow，
 * 所以宣告成全部選填 —— 讀的時候一律檢查存在。
 *
 * ⚠️ `thoughtSignature` 是 Gemini 3 的思考簽章：不要讀它、不要改它，
 *    原樣送回去就好（限制 2）。
 */
export interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  thoughtSignature?: string
}

export interface GeminiTextPart { text: string }
export interface GeminiInlineDataPart { inlineData: { mimeType: string; data: string } }

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[]
}

export interface GeminiToolConfig {
  functionCallingConfig: {
    /** ANY＝每一輪都必須回 function call；AUTO＝模型自己決定 */
    mode: 'AUTO' | 'ANY' | 'NONE'
    /** 限制這一輪只能叫這幾支。用來強迫收尾。 */
    allowedFunctionNames?: string[]
  }
}

/** 換一個模型再試就有機會成功的錯誤：429、404、5xx、逾時、空回應。 */
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

// ============================================================
// client
// ============================================================

export interface GenerateParams {
  model: string
  contents: GeminiContent[]
  systemInstruction?: string
  tools?: GeminiTool[]
  toolConfig?: GeminiToolConfig
  generationConfig?: Record<string, unknown>
  signal?: AbortSignal
}

/** 單一模型、單次呼叫。模型的退化與重試由呼叫端（askGemini／runToolLoop）決定。 */
export interface GeminiClient {
  generate(params: GenerateParams): Promise<GeminiContent>
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/**
 * 400 的 body 裡出現這些字眼＝送出去的 schema 或簽章有問題，換模型不會變好。
 * 其餘的 400（例如某個舊模型不吃某個設定）仍然值得換下一個模型試試。
 */
const SCHEMA_ERROR_HINT = /thought_?signature|function|tool/i

export function createGeminiClient(opts: {
  apiKey: string
  fetchImpl?: typeof fetch
}): GeminiClient {
  const { apiKey, fetchImpl = fetch } = opts

  return {
    async generate(params: GenerateParams): Promise<GeminiContent> {
      const body: Record<string, unknown> = { contents: params.contents }
      if (params.systemInstruction) {
        body.systemInstruction = { parts: [{ text: params.systemInstruction }] }
      }
      if (params.tools) body.tools = params.tools
      if (params.toolConfig) body.toolConfig = params.toolConfig
      if (params.generationConfig) body.generationConfig = params.generationConfig

      let res: Response
      try {
        res = await fetchImpl(`${API_BASE}/${params.model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: params.signal,
        })
      } catch (err) {
        // 連線失敗與 AbortSignal 逾時都走這裡，兩者都值得換下一個模型
        throw new RetryableError(`fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 400 的原因全部藏在 body 裡，一定要讀出來 ——
      // 以前只記 status，schema 寫錯時看到的是「所有模型都失敗」，完全查不下去。
      if (res.status === 400) {
        const detail = await res.text().catch(() => '')
        console.error(`[AI] ${params.model} rejected the request (400): ${detail.substring(0, 1000)}`)
        if (SCHEMA_ERROR_HINT.test(detail)) {
          throw new FatalError(`Gemini 400 (schema/tool): ${detail.substring(0, 500)}`)
        }
        throw new RetryableError('HTTP 400')
      }
      // 429＝額度用盡；404＝模型已下架；5xx＝對面出問題。都換下一個模型。
      if (res.status === 429 || res.status === 404 || res.status >= 500) {
        throw new RetryableError(`HTTP ${res.status}`)
      }
      if (!res.ok) {
        throw new FatalError(`Gemini API error ${res.status}: ${await res.text().catch(() => '')}`)
      }

      const data = await res.json()
      const candidate = data?.candidates?.[0]
      const content = candidate?.content
      // 安全機制擋下或思考預算用盡都可能回空，換模型比直接失敗好
      if (!content || !Array.isArray(content.parts) || content.parts.length === 0) {
        throw new RetryableError(`empty response (finishReason: ${candidate?.finishReason ?? 'unknown'})`)
      }
      // 原樣回傳（限制 2）：parts 裡的 thoughtSignature 必須一字不差地送回去
      return { ...content, role: content.role ?? 'model' } as GeminiContent
    },
  }
}

// ============================================================
// function calling 迴圈
// ============================================================

/** 單次呼叫的逾時上限。LINE 的 replyToken 只有約一分鐘，不能等太久。 */
export const MAX_CALL_TIMEOUT_MS = 25_000
/** 已經超過 deadline 時，最後一輪仍給這麼久 —— 遲到的回覆也好過完全不回。 */
export const MIN_CALL_TIMEOUT_MS = 5_000
/** 一次 functionResponse 的 JSON 上限。超過就截斷，免得整包 context 被一次查詢灌爆。 */
export const MAX_TOOL_RESPONSE_CHARS = 6000

export interface ToolLoopParams {
  client: GeminiClient
  /** 依序嘗試。**內層迴圈全程用同一個模型**，換模型會從原始 contents 重來。 */
  models: string[]
  contents: GeminiContent[]
  systemInstruction?: string
  declarations: GeminiFunctionDeclaration[]
  /** 這幾支一被呼叫就結束迴圈，由呼叫端決定要做什麼 */
  terminalNames: string[]
  /** 執行一支讀取工具。丟例外時會把錯誤訊息回給模型，不會中斷迴圈。 */
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** 模型完全沒回 functionCall 時，純文字要當成哪一支終結函式（預設 `reply`） */
  replyName?: string
  maxRounds?: number
  /** 絕對時間（epoch ms）。超過就強迫收尾，不再發讀工具的回合。 */
  deadlineAt?: number
  generationConfig?: Record<string, unknown>
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface ToolLoopResult {
  kind: 'terminal'
  call: ToolCall
  /** 同一輪裡除了終結呼叫之外，模型還講了的話（`reply` 與 `propose_*` 同時出現時） */
  extraText?: string
  /** 最後真正回答的是哪一個模型。記 log 用。 */
  model: string
}

/** functionResponse.response 必須是物件（限制 3）；太大就截斷並標記。 */
export function toFunctionResponseObject(value: unknown): Record<string, unknown> {
  const wrapped = (value !== null && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : { result: value }
  const json = JSON.stringify(wrapped) ?? ''
  if (json.length <= MAX_TOOL_RESPONSE_CHARS) return wrapped
  return { truncated: true, result: json.substring(0, MAX_TOOL_RESPONSE_CHARS) }
}

function callsIn(content: GeminiContent): ToolCall[] {
  return (content.parts ?? [])
    .filter((p) => p.functionCall?.name)
    .map((p) => ({
      name: p.functionCall!.name,
      args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
    }))
}

function textIn(content: GeminiContent): string {
  return (content.parts ?? [])
    .map((p) => String(p.text ?? ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * 跑一輪或多輪 function calling，直到模型呼叫某一支終結函式為止。
 *
 * 為什麼不是「一次呼叫拿一個 JSON」：模型要先查得到資料才答得準
 * （「上週的拉麵是哪一筆」得先 list_expenses），而查詢的條件只有模型自己知道。
 *
 * ⚠️ 換模型一定要從**原始** contents 重來（限制 2）：中途累積的 model turn 帶著
 *    前一個模型的 thoughtSignature，送給另一個模型會直接 400。
 */
export async function runToolLoop(params: ToolLoopParams): Promise<ToolLoopResult> {
  const {
    client, models, contents, systemInstruction, declarations, terminalNames,
    execute, replyName = 'reply', maxRounds = 3, deadlineAt, generationConfig,
  } = params

  const tools: GeminiTool[] = [{ functionDeclarations: declarations }]
  let lastError: string | null = null

  for (const model of models) {
    // 每個模型都從原始 contents 開始。淺拷貝就夠 —— 迴圈只會往後 push。
    const working: GeminiContent[] = [...contents]
    try {
      for (let round = 0; round < maxRounds; round++) {
        const budget = deadlineAt === undefined ? MAX_CALL_TIMEOUT_MS : deadlineAt - Date.now()
        // 最後一輪，或時間已經用完 → 只准叫終結函式，強迫收尾
        const forceFinish = round === maxRounds - 1 || (deadlineAt !== undefined && budget <= 0)
        const timeout = Math.max(MIN_CALL_TIMEOUT_MS, Math.min(MAX_CALL_TIMEOUT_MS, budget))

        const content = await client.generate({
          model,
          // 每一輪給一份快照。`working` 之後還會被 push，共用同一個陣列的話
          // 「這一輪送出去的到底是什麼」就再也回溯不了（測試與 log 都需要）。
          contents: [...working],
          systemInstruction,
          tools,
          toolConfig: {
            functionCallingConfig: {
              mode: 'ANY',
              ...(forceFinish ? { allowedFunctionNames: terminalNames } : {}),
            },
          },
          generationConfig,
          signal: AbortSignal.timeout(timeout),
        })
        // 原樣保留（含 thoughtSignature），下一輪必須把它送回去
        working.push(content)

        const calls = callsIn(content)
        if (calls.length === 0) {
          // 安全機制擋下、MAX_TOKENS 用盡，或模型就是想講話而不是叫函式。
          // 有文字就當成 reply，連文字都沒有才算失敗。
          const text = textIn(content)
          if (!text) throw new RetryableError('no function call and no text')
          console.log(`[AI] ${model} replied with plain text instead of a function call`)
          return { kind: 'terminal', call: { name: replyName, args: { text } }, model }
        }

        const terminals = calls.filter((c) => terminalNames.includes(c.name))
        if (terminals.length > 0) {
          // 同一輪同時有 propose_* 與 reply 時，propose_* 是主角，
          // reply 的文字不能丟 —— 那通常是「幫你改成 500，確認一下」這種說明。
          const primary = terminals.find((c) => c.name !== replyName) ?? terminals[0]
          const spoken = terminals.find((c) => c !== primary && c.name === replyName)
          const extraText = String(spoken?.args?.text ?? '').trim()
          return { kind: 'terminal', call: primary, extraText: extraText || undefined, model }
        }

        // 只有讀取工具：依**同順序**執行，組成一個 user turn 的多個 functionResponse
        const responses: GeminiPart[] = []
        for (const call of calls) {
          let result: unknown
          try {
            result = await execute(call.name, call.args)
          } catch (err) {
            console.error(`[AI] Tool ${call.name} failed:`, err)
            result = { error: err instanceof Error ? err.message : String(err) }
          }
          responses.push({
            functionResponse: { name: call.name, response: toFunctionResponseObject(result) },
          })
        }
        working.push({ role: 'user', parts: responses })
      }
      // 強迫收尾那一輪還是沒叫終結函式（模型無視 allowedFunctionNames）。換一個試。
      throw new RetryableError(`no terminal call within ${maxRounds} rounds`)
    } catch (err) {
      if (err instanceof FatalError) throw err
      lastError = err instanceof Error ? err.message : String(err)
      console.warn(`[AI] ${model} failed (${lastError}), trying next model...`)
      continue
    }
  }

  // 與 askGemini 用同一個前綴，呼叫端的 isRateLimit() 才認得出來
  throw new Error(`RATE_LIMIT: All Gemini models are currently rate limited or unavailable. Last error: ${lastError}`)
}
