// ============================================================
// _shared/sheetItinerary.ts —— Google 試算表寫的行程 → 行程頁的資料（ItineraryDoc）
//
// David 2026-11-27：開放版讓使用者自己用 Google 試算表排行程（模板見 docs/ITINERARY_SHEET.md），
// 旅程設定貼上試算表連結，行程頁與旅行喵喵都讀得到。
//
// 試算表要「知道連結的人都能檢視」，用 gviz 的 CSV 匯出讀三個分頁（名稱固定）：
//   行程      日期｜時間｜類型｜行程｜地點｜備註｜連結｜預訂
//   住宿      入住日期｜退房日期｜住宿名稱｜地址｜連結｜備註
//   行前準備  要準備的東西
// 欄位依標題找（順序可以換、可以多加欄），日期只要寫在每天第一列，下面空白就是同一天。
// 這支檔案只有純函式＋fetch（由呼叫端給），vitest 直接測（sheetItinerary.test.ts）。
// ============================================================

import type { ItineraryBookingStatus, ItineraryDayDoc, ItineraryDoc, ItineraryItemDoc, ItineraryNote, ItineraryPlace } from "./tools/types.ts"

export const SHEET_TABS = { main: '行程', stays: '住宿', checklist: '行前準備' } as const

/** 試算表網址 → id；直接貼 id 也可以 */
export function sheetIdFromUrl(input: string): string | null {
  const s = input.trim()
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s)
  if (m) return m[1]
  return /^[A-Za-z0-9_-]{30,}$/.test(s) ? s : null
}

/** 標準 CSV（雙引號跳脫、欄位內可換行） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 各種寫法的日期 → YYYY-MM-DD；只有月日時用 year 補 */
export function normalizeSheetDate(raw: string, year: number): string | null {
  const s = raw.trim().replace(/\s*[（(].*?[）)]\s*$/, '').replace(/\s*(週|星期|禮拜)[一二三四五六日天]$/, '')
  if (!s) return null
  let y = year, m: number, d: number
  let r: RegExpExecArray | null
  if ((r = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3] }
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) { m = +r[1]; d = +r[2]; y = +r[3] }
  else if ((r = /^(\d{1,2})[/.\-月](\d{1,2})日?$/.exec(s))) { m = +r[1]; d = +r[2] }
  else return null
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

/** "9:00:00"、"下午 2:30"、"09:00-11:00"、"早上" → { time } 或 { slot } */
export function normalizeSheetTime(raw: string): { time?: string; slot?: string } {
  const s = raw.trim()
  if (!s) return {}
  const one = (t: string): string | null => {
    const r = /^(上午|下午|中午|晚上|AM|PM|am|pm)?\s*(\d{1,2})[:：](\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/.exec(t.trim())
    if (!r) return null
    let h = +r[2]
    const mer = (r[1] || r[4] || '').toLowerCase()
    if ((mer === '下午' || mer === '晚上' || mer === 'pm') && h < 12) h += 12
    if ((mer === '上午' || mer === 'am') && h === 12) h = 0
    if (h > 23 || +r[3] > 59) return null
    return `${pad(h)}:${r[3]}`
  }
  const parts = s.split(/\s*[-–~～至到]\s*/)
  if (parts.length === 2) {
    const a = one(parts[0]), b = one(parts[1])
    if (a && b) return { time: `${a}–${b}` }
  }
  const t = one(s)
  return t ? { time: t } : { slot: s }
}

const KIND_WORDS: [RegExp, string][] = [
  [/當天|標題|主題/, 'day'],
  [/航班|飛機|班機/, 'flight'],
  [/走路|步行/, 'walk'],
  [/開車|租車|自駕|計程車/, 'car'],
  [/巴士|公車|客運/, 'bus'],
  [/交通|電車|火車|新幹線|地鐵|捷運|高鐵|船/, 'train'],
  [/住宿|飯店|旅館|民宿|入住|退房/, 'hotel'],
  [/美食|餐|吃|咖啡|甜點|早餐|午餐|晚餐/, 'food'],
  [/購物|逛街|買/, 'shopping'],
  [/活動|體驗|樂園|表演/, 'activity'],
  [/景點|觀光|參觀|神社|寺|公園/, 'sight'],
]
const kindOf = (raw: string): string => {
  for (const [re, kind] of KIND_WORDS) if (re.test(raw)) return kind
  return 'info'
}

const BOOKING_WORDS: [RegExp, ItineraryBookingStatus][] = [
  [/付|paid/i, 'paid'],
  [/已預|已訂|預約好|booked/i, 'booked'],
  [/現場|排隊|walk/i, 'walkin'],
  [/待|還沒|要訂|todo/i, 'todo'],
  [/未確認|不確定|pending|\?|？/i, 'pending'],
]
const bookingOf = (raw: string): ItineraryBookingStatus | null => {
  if (!raw.trim()) return null
  for (const [re, st] of BOOKING_WORDS) if (re.test(raw)) return st
  return null
}

const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim())

/** 備註：每一行一條；「!」或「！」開頭是紅色提醒 */
const notesOf = (raw: string): ItineraryNote[] =>
  raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l =>
    /^[!！]/.test(l) ? { text: l.replace(/^[!！]\s*/, ''), tone: 'warn' as const } : l)

/** 標題列 → 欄位位置（依名稱找，找不到就 -1） */
function columns(header: string[], names: Record<string, RegExp>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, re] of Object.entries(names)) out[key] = header.findIndex(h => re.test(h.trim()))
  return out
}
const at = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')

/** 找標題列：前 5 列裡第一個包含 must 的 */
function splitHeader(rows: string[][], must: RegExp): { header: string[]; body: string[][] } | null {
  const i = rows.slice(0, 5).findIndex(r => r.some(c => must.test(c.trim())))
  return i < 0 ? null : { header: rows[i], body: rows.slice(i + 1) }
}

export interface SheetTables {
  main: string[][]
  stays?: string[][]
  checklist?: string[][]
}

/**
 * 三個分頁的表格 → ItineraryDoc。
 * title：旅程名稱；year：只寫月日時補的年份（旅程開始日的年份，沒有就今年）。
 * 行程分頁讀不出任何一天時回 null。
 */
export function buildSheetItinerary(tables: SheetTables, title: string, year: number): ItineraryDoc | null {
  const main = splitHeader(tables.main, /^(行程|內容|項目)$/)
  if (!main) return null
  const col = columns(main.header, {
    date: /^日期/, time: /^時間/, kind: /^類型|^分類/, title: /^(行程|內容|項目)$/,
    place: /^地點/, notes: /^備註|^說明/, link: /^連結|^網址/, booking: /^預訂|^訂位|^預約/,
  })

  const days: ItineraryDayDoc[] = []
  const flights: NonNullable<ItineraryDoc['flights']> = []
  let current = null as ItineraryDayDoc | null
  for (const row of main.body) {
    const dateRaw = at(row, col.date)
    const date = dateRaw ? normalizeSheetDate(dateRaw, year) : null
    if (date && date !== current?.date) {
      current = days.find(d => d.date === date) ?? null
      if (!current) {
        current = { date, title: '', items: [] }
        days.push(current)
      }
    }
    const text = at(row, col.title)
    if (!current || !text) continue
    const kindRaw = at(row, col.kind)
    const kind = kindOf(kindRaw)
    const placeRaw = at(row, col.place)
    if (kind === 'day') {
      current.title = text
      if (placeRaw) current.city = placeRaw
      const tips = notesOf(at(row, col.notes))
      if (tips.length) current.tips = [...(current.tips ?? []), ...tips]
      continue
    }
    const link = at(row, col.link)
    const places: ItineraryPlace[] = placeRaw
      ? placeRaw.split(/[、,，\n]/).map(p => p.trim()).filter(Boolean).map(name => ({ name }))
      : []
    const item: ItineraryItemDoc = { kind, title: text, ...normalizeSheetTime(at(row, col.time)) }
    if (link && isUrl(link)) {
      if (places.length === 1) places[0] = { ...places[0], href: link }
      else item.title = `[${text.replace(/[[\]]/g, '')}](${link})`
    }
    if (places.length) item.places = places
    const notes = notesOf(at(row, col.notes))
    if (notes.length) item.notes = notes
    const status = bookingOf(at(row, col.booking))
    if (status) item.booking = { status }
    current.items.push(item)
    if (kind === 'flight') {
      const [depart, arrive] = (item.time ?? '').split('–')
      flights.push({ label: text, date: current.date, ...(depart ? { depart } : {}), ...(arrive ? { arrive } : {}) })
    }
  }
  if (days.length === 0) return null
  days.sort((a, b) => a.date.localeCompare(b.date))
  days.forEach((d, i) => { if (!d.title) d.title = d.city ? `Day ${i + 1}・${d.city}` : `Day ${i + 1}` })

  const doc: ItineraryDoc = { version: 1, title, days }
  if (flights.length) doc.flights = flights

  const staysTable = tables.stays ? splitHeader(tables.stays, /住宿名稱|^名稱/) : null
  if (staysTable) {
    const sc = columns(staysTable.header, {
      checkIn: /入住/, checkOut: /退房/, name: /住宿名稱|^名稱/, address: /^地址/, link: /^連結|^網址/, notes: /^備註/,
    })
    const stays = staysTable.body.flatMap((row) => {
      const name = at(row, sc.name)
      const checkIn = normalizeSheetDate(at(row, sc.checkIn), year)
      const checkOut = normalizeSheetDate(at(row, sc.checkOut), year)
      if (!name || !checkIn || !checkOut) return []
      const link = at(row, sc.link)
      const notes = notesOf(at(row, sc.notes))
      return [{
        id: '', name, checkIn, checkOut,
        ...(at(row, sc.address) ? { address: at(row, sc.address) } : {}),
        ...(link && isUrl(link) ? { href: link } : {}),
        ...(notes.length ? { notes } : {}),
      }]
    })
    stays.forEach((s, i) => { s.id = `stay${i + 1}` })
    if (stays.length) {
      doc.stays = stays
      // 每一天的「今晚住宿」：入住日 ≤ 那天 < 退房日
      for (const d of days) {
        const s = stays.find(s => s.checkIn <= d.date && d.date < s.checkOut)
        if (s) d.stay = s.id
      }
    }
  }

  const items = (tables.checklist ?? []).slice(1).map(r => (r[0] ?? '').trim()).filter(Boolean)
  if (items.length) doc.checklist = { items }

  return doc
}

/** gviz 的 CSV 匯出網址（分頁用名稱指定） */
export const sheetCsvUrl = (sheetId: string, tab: string) =>
  `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`

export type SheetFetchResult =
  | { ok: true; doc: ItineraryDoc }
  | { ok: false; error: 'not_shared' | 'no_itinerary' | 'fetch_failed' }

/** 讀整份試算表（三個分頁同時讀；住宿、行前準備沒有也沒關係） */
export async function fetchSheetItinerary(
  sheetId: string, title: string, year: number, doFetch: typeof fetch = fetch,
): Promise<SheetFetchResult> {
  const get = async (tab: string): Promise<string[][] | 'private' | null> => {
    try {
      const res = await doFetch(sheetCsvUrl(sheetId, tab), { redirect: 'follow', signal: AbortSignal.timeout(6000) })
      const type = res.headers.get('content-type') || ''
      // 沒有公開分享時 Google 回登入頁（HTML）或 401／403
      if (res.status === 401 || res.status === 403 || type.includes('text/html')) return 'private'
      if (!res.ok) return null
      return parseCsv(await res.text())
    } catch {
      return null
    }
  }
  const [main, stays, checklist] = await Promise.all([get(SHEET_TABS.main), get(SHEET_TABS.stays), get(SHEET_TABS.checklist)])
  if (main === 'private') return { ok: false, error: 'not_shared' }
  if (!main) return { ok: false, error: 'fetch_failed' }
  // gviz 找不到同名分頁時會回第一個分頁：住宿、行前準備要確認標題對得上，buildSheetItinerary 會檢查
  const doc = buildSheetItinerary({
    main,
    stays: Array.isArray(stays) ? stays : undefined,
    checklist: Array.isArray(checklist) && /準備|清單|攜帶|東西/.test((checklist[0]?.[0] ?? '')) ? checklist : undefined,
  }, title, year)
  return doc ? { ok: true, doc } : { ok: false, error: 'no_itinerary' }
}
