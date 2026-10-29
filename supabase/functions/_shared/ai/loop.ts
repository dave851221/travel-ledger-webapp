// ============================================================
// _shared/ai/loop.ts —— function calling 迴圈裡與供應商無關的規則
//
// 每一輪給多少時間、哪一輪要強迫收尾、終結函式怎麼挑、工具結果怎麼截斷。
// Gemini 與 Claude 的迴圈都照這一份走，兩邊的行為才不會慢慢分岔。
// ============================================================

import type { ToolCall, ToolLoopResult } from "./types.ts"

/**
 * 單次呼叫的逾時上限。正常的回應在 1–3 秒內，超過 10 秒多半是對面過載，
 * 換下一個模型比繼續等快得多（曾經設 25 秒，模型一慢使用者就等滿 25 秒）。
 */
export const MAX_CALL_TIMEOUT_MS = 10_000
/** 開著上網搜尋的那幾輪：搜尋在對面的伺服器上跑，一輪 10–20 秒很正常 */
export const WEB_SEARCH_CALL_TIMEOUT_MS = 25_000
/** 已經超過 deadline 時，最後一輪仍給這麼久 —— 遲到的回覆也好過完全不回。 */
export const MIN_CALL_TIMEOUT_MS = 5_000
/** 一次工具結果的 JSON 上限。超過就截斷，免得整包 context 被一次查詢灌爆。 */
export const MAX_TOOL_RESPONSE_CHARS = 6000

export interface RoundPlan {
  /** 這一輪只准呼叫終結函式 */
  forceFinish: boolean
  timeoutMs: number
}

/** 最後一輪，或時間已經用完 → 強迫收尾；逾時落在 MIN～maxCallMs 之間。 */
export function planRound(
  round: number,
  maxRounds: number,
  deadlineAt?: number,
  maxCallMs: number = MAX_CALL_TIMEOUT_MS,
): RoundPlan {
  const budget = deadlineAt === undefined ? maxCallMs : deadlineAt - Date.now()
  return {
    forceFinish: round === maxRounds - 1 || (deadlineAt !== undefined && budget <= 0),
    timeoutMs: Math.max(MIN_CALL_TIMEOUT_MS, Math.min(maxCallMs, budget)),
  }
}

/** 工具結果一律是 JSON 物件（Gemini 只收物件）；太大就截斷並標記。 */
export function toFunctionResponseObject(value: unknown): Record<string, unknown> {
  const wrapped = (value !== null && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : { result: value }
  const json = JSON.stringify(wrapped) ?? ''
  if (json.length <= MAX_TOOL_RESPONSE_CHARS) return wrapped
  return { truncated: true, result: json.substring(0, MAX_TOOL_RESPONSE_CHARS) }
}

/**
 * 這一輪有沒有呼叫終結函式；有的話組成結果。
 *
 * 同一輪同時有 propose_* 與 reply 時，propose_* 是主角，
 * reply 的文字不能丟 —— 那通常是「幫你改成 500，確認一下」這種說明。
 */
export function pickTerminal(
  calls: ToolCall[],
  terminalNames: string[],
  replyName: string,
  model: string,
): ToolLoopResult | null {
  const terminals = calls.filter((c) => terminalNames.includes(c.name))
  if (terminals.length === 0) return null
  const primary = terminals.find((c) => c.name !== replyName) ?? terminals[0]
  const spoken = terminals.find((c) => c !== primary && c.name === replyName)
  const extraText = String(spoken?.args?.text ?? '').trim()
  return { kind: 'terminal', call: primary, extraText: extraText || undefined, model }
}

/** 跑一支讀取工具。丟例外時把錯誤訊息回給模型，而不是中斷整個迴圈。 */
export async function executeSafely(
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  call: ToolCall,
): Promise<unknown> {
  try {
    return await execute(call.name, call.args)
  } catch (err) {
    console.error(`[AI] Tool ${call.name} failed:`, err)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
