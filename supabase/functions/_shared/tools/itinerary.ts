// ============================================================
// tools/itinerary.ts —— 行程表的查詢（唯讀）
//
// 整份行程動輒上萬字，每則訊息都塞給模型既慢又貴，所以拆成三種查法：
//   get_itinerary_overview  一天一行的總覽 + 航班、住宿、還沒訂的東西
//   get_itinerary_day       某一天的完整內容（含當晚住宿的備註）
//   search_itinerary        關鍵字找出相關的那幾段（「水明館停車」）
// 輸出一律是精簡的純文字：連結只留名稱，網址省掉 —— 那是最佔 token 的部分，
// 而使用者真的要地圖時網頁的行程頁一點就開。唯一的例外是沒寫地址的住宿（stayMapLine）。
//
// 行程從哪裡來由呼叫端決定（ctx.loadItinerary），這裡只負責格式化。
// ============================================================

import type {
  ItineraryBookingStatus,
  ItineraryDayDoc,
  ItineraryDoc,
  ItineraryItemDoc,
  ItineraryNote,
  ToolContext,
} from "./types.ts"

const KIND_LABELS: Record<string, string> = {
  flight: '航班', train: '鐵路', car: '開車', bus: '巴士', walk: '步行',
  sight: '景點', food: '餐飲', hotel: '住宿', shopping: '購物', activity: '活動', info: '資訊',
}

export const BOOKING_LABELS: Record<ItineraryBookingStatus, string> = {
  paid: '已付清', booked: '已預約', walkin: '現場排隊', todo: '待預訂', pending: '未確認',
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 搜尋最多回這麼多段，再多模型也讀不完 */
const MAX_SEARCH_HITS = 12

/** `[名稱](網址)` → 名稱、`**粗體**` → 粗體 */
export function plainText(rich: string): string {
  return rich.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1')
}

/** 備註攤平成一行一條。warn 是行程頁上的紅字（必看），這裡加個 ⚠️ */
export function noteLines(notes: ItineraryNote[] | undefined, indent = ''): string[] {
  return (notes ?? []).flatMap((note) => {
    if (typeof note === 'string') return [`${indent}· ${plainText(note)}`]
    const mark = note.tone === 'warn' ? '⚠️ ' : ''
    return [`${indent}· ${mark}${plainText(note.text)}`, ...noteLines(note.items, `${indent}  `)]
  })
}

const weekday = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? '' : `（${WEEKDAYS[d.getUTCDay()]}）`
}

const dayNumber = (plan: ItineraryDoc, date: string) => plan.days.findIndex((d) => d.date === date) + 1

function itemLine(item: ItineraryItemDoc): string[] {
  const when = item.time ?? item.slot ?? ''
  const kind = KIND_LABELS[item.kind] ?? item.kind
  const title = plainText(item.title)
  // 名稱已經出現在標題裡的地點就不重複列
  const places = (item.places ?? []).map((p) => p.name).filter((n) => !title.includes(n))
  const extras = [
    places.length > 0 ? `地點：${places.join('、')}` : '',
    item.booking ? `〔${item.booking.label ? `${plainText(item.booking.label)} ` : ''}${BOOKING_LABELS[item.booking.status] ?? item.booking.status}〕` : '',
    item.undecided ? '（未定）' : '',
    item.tag ? `#${item.tag}` : '',
  ].filter(Boolean).join(' ')
  return [`- ${when ? `${when} ` : ''}[${kind}] ${title}${extras ? ` ${extras}` : ''}`, ...noteLines(item.notes, '  ')]
}

function stayLines(plan: ItineraryDoc, stayId: string | undefined): string[] {
  const stay = stayId ? plan.stays?.find((s) => s.id === stayId) : undefined
  if (!stay) return []
  const head = `今晚住宿：${stay.name}${stay.city ? `（${stay.city}）` : ''}｜${stay.checkIn} 入住 → ${stay.checkOut} 退房`
  return [head, ...(stay.address ? [`  · 地址：${stay.address}`] : stayMapLine(stay)), ...noteLines(stay.notes, '  ')]
}

/**
 * 沒寫地址的住宿給一個 Google 地圖搜尋連結 ——「地址給我」時至少有東西可以點。
 * 這是唯一留下來的網址：行程資料裡原本的地圖連結動輒三百字，用名稱組一個短的。
 */
export function stayMapLine(stay: { name: string; address?: string }): string[] {
  if (stay.address) return []
  return [`  · 地圖：https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stay.name)}`]
}

/** 某一天的完整內容 */
export function formatDay(plan: ItineraryDoc, date: string): string | null {
  const day = plan.days.find((d) => d.date === date)
  if (!day) return null
  const flights = (plan.flights ?? []).filter((f) => f.date === date)
  return [
    `📅 ${day.date}${weekday(day.date)} 第 ${dayNumber(plan, date)}/${plan.days.length} 天${day.city ? `｜${day.city}` : ''}｜${day.title}`,
    ...flights.map((f) => `✈️ ${f.label} ${f.number ?? ''} ${f.from ?? ''}${f.depart ? ` ${f.depart} 出發` : ''}${f.to ? ` → ${f.to}` : ''}${f.arrive ? ` ${f.arrive} 抵達` : ''}`.replace(/\s+/g, ' ')),
    ...(day.tips?.length ? ['提醒：', ...noteLines(day.tips, '  ')] : []),
    '行程：',
    ...(day.items.length > 0 ? day.items.flatMap(itemLine) : ['- （這天沒有排行程）']),
    ...stayLines(plan, day.stay),
  ].join('\n')
}

/** 一天一行的總覽，加上航班、住宿、預訂與行前備註 */
export function formatOverview(plan: ItineraryDoc): string {
  const first = plan.days[0]?.date ?? ''
  const last = plan.days[plan.days.length - 1]?.date ?? ''
  const stayName = (id?: string) => plan.stays?.find((s) => s.id === id)?.name
  const pending = (plan.bookings ?? []).filter((b) => b.status === 'todo' || b.status === 'pending')
  return [
    `🗺 ${plan.title}｜${first} – ${last}，共 ${plan.days.length} 天`,
    '每日：',
    ...plan.days.map((d, i) =>
      `- D${i + 1} ${d.date}${weekday(d.date)}${d.city ? ` ${d.city}` : ''}：${d.title}${stayName(d.stay) ? `（住 ${stayName(d.stay)}）` : ''}`),
    ...(plan.flights?.length
      ? ['航班：', ...plan.flights.map((f) => `- ${f.label} ${f.date} ${f.number ?? ''}${f.depart ? ` ${f.depart} 出發` : ''}${f.arrive ? ` ${f.arrive} 抵達` : ''} ${f.from ?? ''}${f.to ? `→${f.to}` : ''}`.replace(/\s+/g, ' ').trim())]
      : []),
    ...(plan.stays?.length
      ? ['住宿：', ...plan.stays.map((s) => `- ${s.checkIn}～${s.checkOut} ${s.name}${s.city ? `（${s.city}）` : ''}`)]
      : []),
    ...(plan.bookings?.length
      ? ['預訂：', ...plan.bookings.map((b) => `- ${b.date}${b.time ? ` ${b.time}` : ''} ${plainText(b.item)}〔${BOOKING_LABELS[b.status] ?? b.status}〕`)]
      : []),
    ...(pending.length ? [`⚠️ 還有 ${pending.length} 項待預訂或未確認`] : []),
    ...(plan.notes?.length ? ['其他備註：', ...noteLines(plan.notes, '  ')] : []),
  ].join('\n')
}

/** 可以被搜尋的一段：開頭標明出處（哪一天、哪間住宿），模型才知道答案在講什麼 */
function searchableSections(plan: ItineraryDoc): string[] {
  // 當天的主題也放進來：「犬山祭那天幾點出門」搜得到那一天的每一項
  const dayHead = (d: ItineraryDayDoc) => `${d.date}${weekday(d.date)} 第 ${dayNumber(plan, d.date)} 天${d.city ? ` ${d.city}` : ''}・${d.title}`
  return [
    ...plan.days.flatMap((d) => [
      ...(d.tips?.length ? [`${dayHead(d)} 的提醒\n${noteLines(d.tips).join('\n')}`] : []),
      ...d.items.map((item) => `${dayHead(d)}\n${itemLine(item).join('\n')}`),
    ]),
    ...(plan.stays ?? []).map((s) => [
      `住宿 ${s.name}${s.nameEn ? ` ${s.nameEn}` : ''}${s.city ? `（${s.city}）` : ''}｜${s.checkIn} 入住 → ${s.checkOut} 退房`,
      ...(s.address ? [`· 地址：${s.address}`] : stayMapLine(s).map((l) => l.trim())),
      ...noteLines(s.notes),
    ].join('\n')),
    ...(plan.flights ?? []).map((f) => [
      `航班 ${f.label} ${f.date} ${f.number ?? ''} ${f.from ?? ''}${f.depart ? ` ${f.depart} 出發` : ''}${f.to ? ` → ${f.to}` : ''}${f.arrive ? ` ${f.arrive} 抵達` : ''}`.replace(/\s+/g, ' '),
      ...noteLines(f.notes),
    ].join('\n')),
    ...(plan.bookings ?? []).map((b) => `預訂 ${b.date}${b.time ? ` ${b.time}` : ''}${b.category ? ` ${b.category}` : ''} ${plainText(b.item)}〔${BOOKING_LABELS[b.status] ?? b.status}〕`),
    ...(plan.checklist?.items.length ? [`行前準備清單\n${plan.checklist.items.map((i) => `· ${plainText(i)}`).join('\n')}`] : []),
    ...(plan.notes?.length ? [`其他備註\n${noteLines(plan.notes).join('\n')}`] : []),
  ]
}

/**
 * 關鍵字搜尋。空白隔開的每個詞各自比對（不分大小寫），命中越多詞的段落排越前面。
 * 「待預訂」「已預約」這類狀態字也搜得到 —— 它們就寫在段落文字裡。
 */
export function searchItinerary(plan: ItineraryDoc, query: string): string[] {
  const terms = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean)
  if (terms.length === 0) return []
  return searchableSections(plan)
    .map((text, order) => {
      const lower = text.toLowerCase()
      return { text, order, score: terms.filter((t) => lower.includes(t)).length }
    })
    .filter((s) => s.score > 0)
    // 命中的詞多的優先；同分照行程順序
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_SEARCH_HITS)
    .map((s) => s.text)
}

/**
 * 放進每則訊息 context 的一行：今天是第幾天、在哪裡、住哪裡。
 * 只有這一行是每次都給的，其餘都要模型自己用工具查。
 */
export function itineraryTodayLine(plan: ItineraryDoc, today: string): string {
  const first = plan.days[0]?.date
  const last = plan.days[plan.days.length - 1]?.date
  if (!first || !last) return '行程表沒有任何一天'
  const range = `${first} – ${last}，共 ${plan.days.length} 天`
  if (today < first) return `${range}；還沒出發`
  if (today > last) return `${range}；行程已結束`
  const day = plan.days.find((d) => d.date === today)
  if (!day) return `${range}；今天不在行程表裡`
  const stay = plan.stays?.find((s) => s.id === day.stay)
  return `${range}；今天第 ${dayNumber(plan, today)} 天${day.city ? `・${day.city}` : ''}・${day.title}${stay ? `・今晚住 ${stay.name}` : ''}`
}

/** 這一天大概在哪裡：路線的第一個點，沒有的話找當天第一個有座標的地點 */
export function dayCoordinates(day: ItineraryDayDoc): { lat: number; lng: number } | null {
  const first = day.route?.[0]
  if (first && Number.isFinite(first[0]) && Number.isFinite(first[1])) return { lat: first[0], lng: first[1] }
  for (const item of day.items) {
    const place = item.places?.find((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    if (place) return { lat: place.lat!, lng: place.lng! }
  }
  return null
}

// ============================================================
// 給 registry 用的 execute
// ============================================================

const NO_ITINERARY = { error: 'This trip has no itinerary. Tell the user there is no itinerary page for this trip.' }

async function load(ctx: ToolContext): Promise<ItineraryDoc | null> {
  return ctx.loadItinerary ? await ctx.loadItinerary() : null
}

export async function getItineraryOverview(ctx: ToolContext): Promise<Record<string, unknown>> {
  const plan = await load(ctx)
  return plan ? { today: ctx.today, text: formatOverview(plan) } : NO_ITINERARY
}

export async function getItineraryDay(date: string | undefined, ctx: ToolContext): Promise<Record<string, unknown>> {
  const plan = await load(ctx)
  if (!plan) return NO_ITINERARY
  const wanted = date ?? ctx.today
  const text = formatDay(plan, wanted)
  if (text) return { text }
  return {
    error: `${wanted} is not in the itinerary`,
    days: plan.days.map((d) => d.date),
  }
}

export async function searchItineraryTool(query: string | undefined, ctx: ToolContext): Promise<Record<string, unknown>> {
  const plan = await load(ctx)
  if (!plan) return NO_ITINERARY
  const hits = searchItinerary(plan, query ?? '')
  return hits.length > 0
    ? { count: hits.length, results: hits }
    : { count: 0, results: [], hint: 'Nothing matched. Try a shorter keyword, or get_itinerary_overview.' }
}
