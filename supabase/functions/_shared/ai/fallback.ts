// ============================================================
// _shared/ai/fallback.ts —— 主要供應商失敗時改用備援
//
// 用法：`withFallback(claude, gemini)`。Claude 逾時、過載、額度用完，
// 或碰到它做不到的工作（語音），就交給 Gemini 免費版，使用者不會因此收不到回覆。
//
// 改用備援時會呼叫 request 的 `onFallback`，呼叫端據此在回覆開頭說一聲
// （「Claude 額度用完，改用免費版」）—— 不說的話使用者只會覺得機器人突然變慢、變笨。
// 做不到的工作（語音）直接交給備援，那是預期中的分工，不算 fallback，不通知。
// ============================================================

import type { AiProvider, AiTask, FallbackReason } from "./types.ts"

/**
 * 額度用完之後，這麼久之內不再去打主要的那一家。
 * 每月上限不會自己恢復，每則訊息都先白打一次只是多等、多一行錯誤 log。
 * 管理員調高上限後，最晚這麼久就會自動用回來。
 */
export const QUOTA_COOLDOWN_MS = 10 * 60_000

export function withFallback(primary: AiProvider, backup?: AiProvider): AiProvider {
  if (!backup) return primary

  // 同一個 isolate 裡的請求共用（Edge Function 的 isolate 會重複使用一段時間）
  let primaryBlockedUntil = 0

  const attempt = async <T>(
    task: AiTask,
    onFallback: ((reason: FallbackReason) => void) | undefined,
    run: (p: AiProvider) => Promise<T>,
  ): Promise<T> => {
    if (!primary.supports(task)) return run(backup)
    if (Date.now() < primaryBlockedUntil) {
      onFallback?.('quota')
      return run(backup)
    }
    try {
      return await run(primary)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const reason: FallbackReason = message.startsWith('AI_QUOTA:') ? 'quota' : 'error'
      if (reason === 'quota') primaryBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS
      console.warn(`[AI] ${primary.name} failed (${message.substring(0, 200)}), falling back to ${backup.name}`)
      onFallback?.(reason)
      // 備援也失敗時丟的是備援的錯誤 —— 使用者看到的是最後一次嘗試的結果
      return run(backup)
    }
  }

  return {
    // 只是說明有備援，不代表這次用了它（真的改用時會另外留 `falling back to` 那一行）
    name: `${primary.name} (backup: ${backup.name})`,
    supports: (task) => primary.supports(task) || backup.supports(task),
    generate: (req) => attempt(req.task, req.onFallback, (p) => p.generate(req)),
    runToolLoop: (req) => attempt(req.task, req.onFallback, (p) => p.runToolLoop(req)),
  }
}
