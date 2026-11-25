// ============================================================
// _shared/assistant/time.ts —— 旅程的時區與「今天」（LINE、網頁聊天共用）
//
// 原本在 line-webhook/util.ts，那裡原樣轉出。
// ============================================================

/** getTripTimezone 只讀得到這幾個欄位 */
export interface TimezoneSource {
  timezone?: string | null
  base_currency?: string | null
  rates?: Record<string, number> | null
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
export function getTripTimezone(trip: TimezoneSource | null | undefined): string {
  const explicit = String(trip?.timezone ?? '').trim()
  // 只接受 Intl 認得的字串：欄位是自由文字，存了錯的值會讓 DateTimeFormat 直接丟例外
  if (explicit && isValidTimezone(explicit)) return explicit
  if (explicit) console.warn(`[TZ] Ignoring invalid trip timezone: ${explicit}`)

  const candidates = [trip?.base_currency, ...Object.keys(trip?.rates || {})]
  for (const cur of candidates) {
    if (cur && CURRENCY_TIMEZONE[cur]) return CURRENCY_TIMEZONE[cur]
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


/**
 * 這趟旅程的「今天」。
 *
 * 每個要判斷日期的地方都是 `getTodayString(getTripTimezone(trip))` 這兩層，
 * 少寫一層就會退回 Asia/Taipei，日本旅程的深夜記帳會記到前一天（F4）。
 */
export function tripToday(trip: TimezoneSource | null | undefined): string {
  return getTodayString(getTripTimezone(trip))
}
