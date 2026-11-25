// ============================================================
// util.ts —— 與 LINE、DB 都無關的小工具
//
// 時區推測、背景工作、綁定狀態的時效判斷。
// 這裡刻意不 import db.ts 或 line-api.ts —— 全部是輸入輸出的計算。
// ============================================================

import { PENDING_BIND_TTL_MS } from "./config.ts"
import type { EdgeRuntimeGlobal } from "./types.ts"

// 時區與「今天」與網頁聊天共用（_shared/assistant/time.ts），這裡原樣轉出
export { CURRENCY_TIMEZONE, getTodayString, getTripTimezone, isValidTimezone } from "../_shared/assistant/time.ts"
export type { TimezoneSource } from "../_shared/assistant/time.ts"

/**
 * 讓非同步工作在回應送出後仍跑得完。
 *
 * Supabase Edge Runtime 會在 Response 回傳後隨時中止函式，
 * 過去那些 `.then(() => {})` 的「射後不理」寫法因此可能整個消失 ——
 * 對話歷史掉了只是可惜，`saved` 紀錄掉了會讓「取消上一筆」撤到更早的一筆。
 * 真正依賴結果的（例如 saved）請直接 await，其餘交給這裡。
 */
export function runInBackground(work: PromiseLike<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeGlobal }).EdgeRuntime
  const promise = Promise.resolve(work).catch((err) => console.error('[BG_TASK]', err))
  if (runtime && typeof runtime.waitUntil === 'function') {
    runtime.waitUntil(promise)
  }
}

// 旅程密碼為選填：access_code 為 NULL 或全空白時代表免密碼，綁定不需驗證
export function requiresAccessCode(code: string | null | undefined): boolean {
  return !!(code && code.trim())
}

/**
 * 這個 pending 綁定是不是已經過期了。
 * `pending_at` 為 null 代表是舊資料（欄位加上去之前寫的），一律視為過期 ——
 * 那些狀態本來就已經卡在那裡很久了。
 */
export function isPendingExpired(pendingAt: string | null | undefined): boolean {
  if (!pendingAt) return true
  const started = new Date(pendingAt).getTime()
  if (Number.isNaN(started)) return true
  return Date.now() - started > PENDING_BIND_TTL_MS
}
