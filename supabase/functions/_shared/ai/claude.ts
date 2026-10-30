// ============================================================
// _shared/ai/claude.ts —— Anthropic Claude 的 AiProvider
//
// 與 gemini.ts 對等：一次性的 generate（OCR、挑選、重讀收據）與 function calling 迴圈。
// client 由呼叫端注入（line-webhook/ai.ts 用 API key 建一個），測試塞假的。
//
// 與 Gemini 不同、寫的時候要注意的地方：
//   1. **沒有音訊輸入**。`supports('audio')` 回 false，fallback.ts 會把語音直接交給 Gemini。
//   2. Haiku 5.5 **不接受**非預設的 temperature／top_p／top_k（400），一律不送。
//   3. 圖片的 media_type 必須與實際內容一致，否則 400 —— 從 base64 開頭判斷，不信呼叫端給的。
//   4. 迴圈用 `tool_choice: any` 強迫每一輪都呼叫函式（對應 Gemini 的 mode: ANY），
//      模型這時會跳過思考直接呼叫，速度也比較快。Claude 沒有 allowedFunctionNames，
//      最後一輪改用一句話要求它直接收尾，沒照做就當失敗。
//   5. 模型回的 content 要原樣當成 assistant turn 送回去（可能夾著 thinking block）。
//   6. system 自己帶 cache_control：跨訊息能重複利用的只有 system + tools 這一段。
//   7. 上網搜尋（web_search）要在 Console 開放，沒開的話整個請求 400 ——
//      偵測到就關掉搜尋重打，不要讓每則訊息都掉到備援。
// ============================================================

import { Anthropic } from "../deps.ts"
import {
  executeAll,
  pickTerminal,
  planRound,
  toFunctionResponseObject,
  WEB_SEARCH_CALL_TIMEOUT_MS,
} from "./loop.ts"
import {
  type AiMessage,
  type AiProvider,
  type AiTask,
  FatalError,
  type GenerateRequest,
  isMediaPart,
  type JsonSchema,
  RetryableError,
  type ToolCall,
  type ToolLoopRequest,
  type ToolLoopResult,
} from "./types.ts"

/** 只用到 `messages.create`。正式環境是 `new Anthropic({ apiKey })`，測試塞假的。 */
export interface ClaudeClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>
  }
}

export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5'

/** 一次性呼叫（OCR）的逾時。付費的 API 正常 2–5 秒，超過這個多半是出事了，交給備援。 */
const GENERATE_TIMEOUT_MS = 15_000
/** 思考也算在 max_tokens 裡，留夠空間，免得 JSON 寫到一半被截斷 */
const MAX_TOKENS = 4096

type Effort = 'low' | 'medium' | 'high'

// ============================================================
// 格式轉換
// ============================================================

/** 從 base64 開頭判斷圖片格式（限制 3）。認不出來才相信呼叫端給的。 */
export function sniffImageType(data: string, hinted: string): Anthropic.Base64ImageSource['media_type'] {
  if (data.startsWith('/9j/')) return 'image/jpeg'
  if (data.startsWith('iVBORw0KGgo')) return 'image/png'
  if (data.startsWith('R0lGOD')) return 'image/gif'
  if (data.startsWith('UklGR')) return 'image/webp'
  const known = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
  return (known as readonly string[]).includes(hinted)
    ? hinted as Anthropic.Base64ImageSource['media_type']
    : 'image/jpeg'
}

/** 與供應商無關的訊息 → Claude 的 messages。空字串的 text block 會被 API 拒絕，先濾掉。 */
export function toClaudeMessages(messages: AiMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.parts.flatMap((p): Anthropic.ContentBlockParam[] => {
      if (!isMediaPart(p)) return p.text ? [{ type: 'text', text: p.text }] : []
      if (!p.media.mimeType.startsWith('image/')) {
        throw new FatalError(`Claude cannot read ${p.media.mimeType} input`)
      }
      return [{
        type: 'image',
        source: { type: 'base64', media_type: sniffImageType(p.media.data, p.media.mimeType), data: p.media.data },
      }]
    }),
  }))
}

/**
 * 結構化輸出要求每個 object 都寫明 `additionalProperties: false`。
 * 共用的 schema 刻意不帶這個欄位（Gemini 不支援），送出前在這裡補上。
 */
export function toClaudeSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema }
  if (schema.type === 'object') out.additionalProperties = false
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toClaudeSchema(v)]),
    )
  }
  if (schema.items) out.items = toClaudeSchema(schema.items)
  return out
}

const textOf = (message: Anthropic.Message): string =>
  message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()

// ============================================================
// 錯誤分類
// ============================================================

/**
 * 付費 API 的錯誤翻成與 Gemini 同一套語意：
 *   429／5xx／529 過載／連線失敗／逾時 → RetryableError（交給備援或請使用者稍後再試）
 *   402、或 400 且提到額度／儲值 → `AI_QUOTA:`（每月花費上限或餘額用完）
 *   401／403 → FatalError（key 錯了或被停用，換模型也沒用）
 *   其他 400 → FatalError，body 印出來（多半是送出去的格式有問題）
 */
export function classifyClaudeError(err: unknown): Error {
  if (err instanceof Anthropic.APIConnectionError) {
    return new RetryableError(`fetch failed: ${err.message}`)
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0
    const detail = String(err.message ?? '')
    if (status === 429 || status >= 500) return new RetryableError(`HTTP ${status}`)
    if (status === 402 || (status === 400 && /credit|billing|spend|usage limit/i.test(detail))) {
      return new FatalError(`AI_QUOTA: Claude usage limit reached: ${detail.substring(0, 300)}`)
    }
    console.error(`[AI] Claude rejected the request (${status}): ${detail.substring(0, 1000)}`)
    return new FatalError(`Claude API error ${status}: ${detail.substring(0, 500)}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

const isTimeout = (err: Error) => /timed? ?out|abort/i.test(err.message)

// ============================================================
// AiProvider
// ============================================================

export function createClaudeProvider(opts: {
  client: ClaudeClient
  model?: string
  /** 思考強度。記帳不需要深思，low 換速度 */
  effort?: Effort
}): AiProvider {
  const { client, model = DEFAULT_CLAUDE_MODEL, effort = 'low' } = opts

  /**
   * 送出一次請求。429／5xx 這種瞬間的錯誤自己補打一次（SDK 的自動重試關掉了 ——
   * 它連逾時也會重試，等待時間直接翻倍，那不如早點交給備援）。
   */
  const send = async (
    body: Anthropic.MessageCreateParamsNonStreaming,
    timeoutMs: number,
    label: string,
  ): Promise<Anthropic.Message> => {
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now()
      try {
        const res = await client.messages.create(body, { timeout: timeoutMs, maxRetries: 0 })
        const u = res.usage
        // 花費與速度都看這一行：in／out 是計費的 token 數，cache_r 是打到快取的部分
        console.log(`[AI] claude ${model} ${label} ${Date.now() - startedAt}ms`
          + ` in=${u.input_tokens} cache_r=${u.cache_read_input_tokens ?? 0}`
          + ` cache_w=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens} stop=${res.stop_reason}`)
        return res
      } catch (raw) {
        const err = classifyClaudeError(raw)
        if (attempt === 0 && err instanceof RetryableError && !isTimeout(err)) {
          console.warn(`[AI] claude ${label} ${err.message}, retrying once...`)
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        throw err
      }
    }
  }

  /** 對使用者來說 Claude 只有一個模型，失敗就是「忙碌」，不會有 Gemini 那種「免費額度」 */
  const asUserFacing = (err: unknown): Error => {
    if (err instanceof FatalError) return err
    const reason = err instanceof Error ? err.message : String(err)
    return new Error(`AI_BUSY: Claude failed: ${reason}`)
  }

  const supports = (task: AiTask) => task !== 'audio'

  /**
   * Console 沒開放 web search 時設為 true，之後不再帶這支工具（限制 7）。
   * provider 在模組載入時建一次，所以等於跟著 isolate 走：重新部署或 isolate 回收後會再試一次。
   */
  let webSearchDisabled = false

  return {
    name: 'claude',
    supports,

    async generate(req: GenerateRequest): Promise<string> {
      if (!supports(req.task)) throw new FatalError(`Claude does not support ${req.task}`)
      try {
        const res = await send({
          model,
          max_tokens: MAX_TOKENS,
          ...(req.system ? { system: req.system } : {}),
          messages: toClaudeMessages(req.messages),
          output_config: {
            effort,
            ...(req.json && req.schema
              ? { format: { type: 'json_schema' as const, schema: toClaudeSchema(req.schema) } }
              : {}),
          },
        }, GENERATE_TIMEOUT_MS, req.task)
        const text = textOf(res)
        // 拒答（stop_reason: refusal）或思考把 max_tokens 用光都會沒有文字
        if (!text) throw new RetryableError(`empty response (stop_reason: ${res.stop_reason})`)
        return text
      } catch (err) {
        throw asUserFacing(err)
      }
    },

    async runToolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
      const { terminalNames, execute, replyName = 'reply', maxRounds = 3, deadlineAt } = req
      const tools: Anthropic.ToolUnion[] = req.declarations.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: d.parameters as Anthropic.Tool.InputSchema,
      }))
      const messages = toClaudeMessages(req.messages)
      // 限制 6：system 自己設一個快取斷點。整段 prefix 的那個斷點跨訊息打不到
      // （每則訊息的旅程 context 都不一樣），system + tools 這一段才是每次都相同的
      const system: Anthropic.TextBlockParam[] | undefined = req.system
        ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
        : undefined
      let searchesLeft = webSearchDisabled ? 0 : req.webSearch?.maxUses ?? 0

      try {
        for (let round = 0; round < maxRounds; round++) {
          const searching = searchesLeft > 0
          const { forceFinish, timeoutMs } = planRound(
            round, maxRounds, deadlineAt, searching ? WEB_SEARCH_CALL_TIMEOUT_MS : undefined,
          )
          if (forceFinish) {
            appendText(messages, `（系統：時間有限，這一輪請直接呼叫 ${terminalNames.join('／')} 其中一支收尾，不要再查詢。）`)
          }
          const roundTools = searching && !forceFinish
            ? [...tools, webSearchTool(searchesLeft, req.webSearch?.location)]
            : tools

          let res: Anthropic.Message
          try {
            res = await send({
              model,
              max_tokens: MAX_TOKENS,
              ...(system ? { system } : {}),
              messages: [...messages],
              tools: roundTools,
              // 限制 4：每一輪都必須呼叫函式，最終回覆也是一支函式（reply）
              tool_choice: { type: 'any' },
              output_config: { effort },
              // 同一則訊息的第二輪會帶著第一輪整段 prefix，打到快取只收 1 成的價錢
              cache_control: { type: 'ephemeral' },
            }, timeoutMs, `r${round + 1}`)
          } catch (err) {
            // 限制 7：Console 沒開放 web search 時整個請求 400。關掉它重打這一輪，
            // 而不是讓每則訊息都失敗、掉到備援
            if (searching && err instanceof FatalError && /web.?search/i.test(err.message)) {
              console.error('[AI] Web search rejected, disabling it until the function restarts:', err.message)
              webSearchDisabled = true
              searchesLeft = 0
              round--
              continue
            }
            throw err
          }
          // 限制 5：原樣送回（搜尋結果的 block 也在裡面，下一輪模型才看得到）
          messages.push({ role: 'assistant', content: res.content })

          const searched = res.usage.server_tool_use?.web_search_requests ?? 0
          if (searched > 0) {
            searchesLeft = Math.max(0, searchesLeft - searched)
            console.log(`[AI] ${model} r${round + 1} web_search ×${searched}`)
          }
          // 搜尋還沒跑完，對面先暫停了：原樣再送一次就會接著做（不能補 user 訊息）
          if (res.stop_reason === 'pause_turn') continue

          const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          const calls: ToolCall[] = uses.map((b) => ({ name: b.name, args: (b.input ?? {}) as Record<string, unknown> }))

          if (calls.length === 0) {
            const text = textOf(res)
            if (!text) throw new RetryableError(`no tool call and no text (stop_reason: ${res.stop_reason})`)
            console.log(`[AI] ${model} replied with plain text instead of a tool call`)
            return { kind: 'terminal', call: { name: replyName, args: { text } }, model }
          }

          const terminal = pickTerminal(calls, terminalNames, replyName, model)
          if (terminal) return terminal

          // 只有讀取工具：每一個 tool_use 都要有對應的 tool_result，放在同一個 user turn
          // 同時執行（executeAll），結果照 tool_use 的順序排
          for (const call of calls) {
            console.log(`[AI] ${model} r${round + 1} → ${call.name} ${JSON.stringify(call.args).substring(0, 200)}`)
          }
          const outputs = await executeAll(execute, calls)
          const results: Anthropic.ToolResultBlockParam[] = calls.map((_call, i) => ({
            type: 'tool_result',
            tool_use_id: uses[i].id,
            content: JSON.stringify(toFunctionResponseObject(outputs[i])),
          }))
          messages.push({ role: 'user', content: results })
        }
        throw new RetryableError(`no terminal call within ${maxRounds} rounds`)
      } catch (err) {
        throw asUserFacing(err)
      }
    },
  }
}

/**
 * Anthropic 的 server tool：搜尋在對面的伺服器上跑，結果直接進模型的 context。
 * Haiku 只能用沒有 dynamic filtering 的 20250305 版。
 */
function webSearchTool(maxUses: number, location?: { city?: string; country?: string; timezone?: string }): Anthropic.WebSearchTool20250305 {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: maxUses,
    ...(location && (location.city || location.country || location.timezone)
      ? { user_location: { type: 'approximate', ...location } }
      : {}),
  }
}

/** 在最後一則 user turn 的尾端補一段文字（tool_result 之後可以接 text） */
function appendText(messages: Anthropic.MessageParam[], text: string): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') {
    messages.push({ role: 'user', content: [{ type: 'text', text }] })
    return
  }
  const blocks: Anthropic.ContentBlockParam[] = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : [...last.content]
  blocks.push({ type: 'text', text })
  last.content = blocks
}
