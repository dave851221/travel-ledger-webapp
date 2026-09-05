// ============================================================
// util.ts —— 與 LINE、DB 都無關的小工具
//
// 時區推測、背景工作、綁定狀態的時效判斷。
// 這裡刻意不 import db.ts 或 line-api.ts —— 全部是輸入輸出的計算。
// ============================================================

import { PENDING_BIND_TTL_MS } from "./config.ts"

/**
 * 讓非同步工作在回應送出後仍跑得完。
 *
 * Supabase Edge Runtime 會在 Response 回傳後隨時中止函式，
 * 過去那些 `.then(() => {})` 的「射後不理」寫法因此可能整個消失 ——
 * 對話歷史掉了只是可惜，`saved` 紀錄掉了會讓「取消上一筆」撤到更早的一筆。
 * 真正依賴結果的（例如 saved）請直接 await，其餘交給這裡。
 */
export function runInBackground(work: PromiseLike<unknown>): void {
  const runtime = (globalThis as any).EdgeRuntime
  const promise = Promise.resolve(work).catch((err) => console.error('[BG_TASK]', err))
  if (runtime && typeof runtime.waitUntil === 'function') {
    runtime.waitUntil(promise)
  }
}

export const CURRENCY_TIMEZONE: Record<string, string> = {
  TWD: 'Asia/Taipei',   JPY: 'Asia/Tokyo',        KRW: 'Asia/Seoul',
  HKD: 'Asia/Hong_Kong', SGD: 'Asia/Singapore',   MYR: 'Asia/Kuala_Lumpur',
  THB: 'Asia/Bangkok',  VND: 'Asia/Ho_Chi_Minh',  IDR: 'Asia/Jakarta',
  PHP: 'Asia/Manila',   CNY: 'Asia/Shanghai',
  AUD: 'Australia/Sydney', NZD: 'Pacific/Auckland',
  GBP: 'Europe/London', EUR: 'Europe/Paris',       CHF: 'Europe/Zurich',
  USD: 'America/New_York', CAD: 'America/Toronto',
}

/**
 * 這趟旅程的「今天」該用哪個時區。
 *
 * 優先讀 `trips.timezone`（網頁的設定頁可選，M4）。幣別本來就不等於所在地：
 * 主幣別是「結算時折算成哪一種錢」，跟人在哪裡沒有關係 ——
 * 主幣 TWD 的日本旅程在日本時間 23:30 記帳，用台北時間會記到前一天去（情境 F4）。
 *
 * 沒設定時才退回舊的猜法（先主幣別、再 rates 裡的其他幣別），行為與以前相同。
 */
export function getTripTimezone(trip: any): string {
  const explicit = String(trip?.timezone ?? '').trim()
  // 只接受 Intl 認得的字串：欄位是自由文字，存了錯的值會讓 DateTimeFormat 直接丟例外
  if (explicit && isValidTimezone(explicit)) return explicit
  if (explicit) console.warn(`[TZ] Ignoring invalid trip timezone: ${explicit}`)

  const candidates = [trip?.base_currency, ...Object.keys(trip?.rates || {})]
  for (const cur of candidates) {
    if (CURRENCY_TIMEZONE[cur]) return CURRENCY_TIMEZONE[cur]
  }
  return 'UTC'
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function getTodayString(timezone = 'Asia/Taipei'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
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
