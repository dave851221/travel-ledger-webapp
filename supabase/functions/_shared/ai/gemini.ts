// ============================================================
// _shared/ai/gemini.ts —— Google Gemini 的單次呼叫、function calling 迴圈與 AiProvider
//
// 這一層與 LINE 無關，也**不碰 Deno.env**：API key 與 fetch 都由呼叫端注入，
// 所以整支可以在 vitest（Node）下用假 client 測試（見 gemini.test.ts）。
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

import { executeSafely, pickTerminal, planRound, toFunctionResponseObject } from "./loop.ts"
import {
  type AiMessage,
  type AiProvider,
  type AiTask,
  allModelsFailedError,
  FatalError,
  type FunctionDeclaration,
  type GenerateRequest,
  isMediaPart,
  type JsonSchema,
  RetryableError,
  type ToolCall,
  type ToolLoopRequest,
  type ToolLoopResult,
} from "./types.ts"

export { toFunctionResponseObject }
export { allModelsFailedError, FatalError, RetryableError } from "./types.ts"

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

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiTool {
  functionDeclarations: FunctionDeclaration[]
}

export interface GeminiToolConfig {
  functionCallingConfig: {
    /** ANY＝每一輪都必須回 function call；AUTO＝模型自己決定 */
    mode: 'AUTO' | 'ANY' | 'NONE'
    /** 限制這一輪只能叫這幾支。用來強迫收尾。 */
    allowedFunctionNames?: string[]
  }
}

/** 與供應商無關的訊息 → Gemini 的 contents */
export function toGeminiContents(messages: AiMessage[]): GeminiContent[] {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.parts.map((p) => isMediaPart(p) ? { inlineData: p.media } : { text: p.text }),
  }))
}

/**
 * responseSchema 的 `type` 用 proto 的大寫列舉（OBJECT／STRING…）。
 * 共用的 schema 一律小寫（function declaration 那邊也是小寫），送出前在這裡轉。
 */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema, type: schema.type.toUpperCase() }
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
    )
  }
  if (schema.items) out.items = toGeminiSchema(schema.items)
  return out
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

/** 單一模型、單次呼叫。模型的退化與重試由呼叫端（provider／runGeminiToolLoop）決定。 */
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

export interface GeminiToolLoopParams {
  client: GeminiClient
  /** 依序嘗試。**內層迴圈全程用同一個模型**，換模型會從原始 contents 重來。 */
  models: string[]
  contents: GeminiContent[]
  systemInstruction?: string
  declarations: FunctionDeclaration[]
  terminalNames: string[]
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
  replyName?: string
  maxRounds?: number
  deadlineAt?: number
  generationConfig?: Record<string, unknown>
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
export async function runGeminiToolLoop(params: GeminiToolLoopParams): Promise<ToolLoopResult> {
  const {
    client, models, contents, systemInstruction, declarations, terminalNames,
    execute, replyName = 'reply', maxRounds = 3, deadlineAt, generationConfig,
  } = params

  const tools: GeminiTool[] = [{ functionDeclarations: declarations }]
  const failures: string[] = []

  for (const model of models) {
    // 每個模型都從原始 contents 開始。淺拷貝就夠 —— 迴圈只會往後 push。
    const working: GeminiContent[] = [...contents]
    try {
      for (let round = 0; round < maxRounds; round++) {
        const { forceFinish, timeoutMs } = planRound(round, maxRounds, deadlineAt)
        const startedAt = Date.now()

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
          signal: AbortSignal.timeout(timeoutMs),
        })
        console.log(`[AI] gemini ${model} r${round + 1} ${Date.now() - startedAt}ms`)
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

        const terminal = pickTerminal(calls, terminalNames, replyName, model)
        if (terminal) return terminal

        // 只有讀取工具：依**同順序**執行，組成一個 user turn 的多個 functionResponse
        const responses: GeminiPart[] = []
        for (const call of calls) {
          // 查詢工具也留一行：出問題時光看日誌就知道模型查了什麼、查到第幾輪。
          // 終結函式在呼叫端記，這裡只補上中間這幾步。
          console.log(`[AI] ${model} r${round + 1} → ${call.name} ${JSON.stringify(call.args ?? {}).substring(0, 200)}`)
          const result = await executeSafely(execute, call)
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
      const reason = err instanceof Error ? err.message : String(err)
      failures.push(reason)
      console.warn(`[AI] ${model} failed (${reason}), trying next model...`)
      continue
    }
  }

  // 與 generate 共用同一個判斷，呼叫端才能分辨「額度用完」與「暫時忙碌」
  throw allModelsFailedError(failures)
}

// ============================================================
// AiProvider
// ============================================================

/**
 * 單次 JSON mode 呼叫的逾時。OCR 與轉錄都比文字慢，但也不能無限等下去 ——
 * 模型過載時寧可早點換下一個（曾經設 25 秒，一慢就是整整 25 秒沒有回應）。
 */
const ASK_TIMEOUT_MS = 15_000

export interface GeminiModels {
  /** 純文字（聊天、記帳、從清單裡挑一筆） */
  text: string[]
  /** 圖片與音訊都走這一組 */
  vision: string[]
}

export function createGeminiProvider(opts: {
  client: GeminiClient
  models: GeminiModels
}): AiProvider {
  const { client, models } = opts
  const modelsFor = (task: AiTask) => task === 'text' ? models.text : models.vision

  return {
    name: 'gemini',
    supports: () => true,

    async generate(req: GenerateRequest): Promise<string> {
      const generationConfig: Record<string, unknown> = {}
      if (req.json) generationConfig.responseMimeType = 'application/json'
      // 結構化輸出：由 API 保證格式，比在 prompt 裡描述 JSON 範例可靠得多。
      // ⚠️ 這條路徑**不能**同時帶 tools —— 兩者併用 Gemini 3 以外一律 400。
      if (req.json && req.schema) generationConfig.responseSchema = toGeminiSchema(req.schema)
      if (req.temperature !== undefined) generationConfig.temperature = req.temperature

      const contents = toGeminiContents(req.messages)
      const failures: string[] = []

      for (const model of modelsFor(req.task)) {
        console.log(`[AI] Calling Gemini model: ${model}`)
        const startedAt = Date.now()
        try {
          const content = await client.generate({
            model, contents, systemInstruction: req.system, generationConfig,
            signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
          })
          const text = content.parts.map((part) => String(part.text ?? '')).filter(Boolean).join('')
          if (!text) {
            // 有 parts 卻沒有文字（例如只回了 thought）。換模型比直接失敗好。
            failures.push('empty text')
            console.warn(`[AI] ${model} returned no text, trying next model...`)
            continue
          }
          console.log(`[AI] gemini ${model} ${req.task} ${Date.now() - startedAt}ms`)
          return text
        } catch (err) {
          // schema 寫錯之類的問題換模型也沒用，直接往外丟
          if (err instanceof FatalError) throw err
          const reason = err instanceof RetryableError ? err.message : String(err)
          failures.push(reason)
          console.warn(`[AI] ${model} failed (${reason}), trying next model...`)
        }
      }

      throw allModelsFailedError(failures)
    },

    runToolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
      return runGeminiToolLoop({
        client,
        models: modelsFor(req.task),
        contents: toGeminiContents(req.messages),
        systemInstruction: req.system,
        declarations: req.declarations,
        terminalNames: req.terminalNames,
        execute: req.execute,
        replyName: req.replyName,
        maxRounds: req.maxRounds,
        deadlineAt: req.deadlineAt,
        generationConfig: req.temperature !== undefined ? { temperature: req.temperature } : undefined,
      })
    },
  }
}
