// ============================================================
// tools/places.ts —— 查真實存在的地點（Google Places API (New) Text Search）
//
// 模型推薦店家、景點時自己附的地圖連結常常是錯的：編出來的短網址指到別的地方，
// 搜尋連結只搜到「台中」。所以推薦行程表以外的地點，一律先用這支查過，
// 只附它回傳的 googleMapsUri（Google 地圖上那個地點本身的頁面）。
//
// 要錢：rating 屬於 Text Search Enterprise，每月前 1,000 次免費，之後約 US$0.035／次。
// 用量上限設在 Google Cloud Console 的 API 配額，程式裡沒有另外管。
// 沒設 key 時（ctx.placesApiKey 為空）LINE 不公開這支工具，見 line-webhook/ai.ts。
// ============================================================

import { dayCoordinates } from "./itinerary.ts"
import type { ToolContext } from "./types.ts"
import { countryForTimezone } from "./weather.ts"

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText'
const TIMEOUT_MS = 6_000
const MAX_RESULTS = 5
/** 有行程座標時，以那一天的位置為中心偏好 30 公里內的結果（偏好，不是限制） */
const BIAS_RADIUS_M = 30_000

const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.rating',
  'places.userRatingCount',
].join(',')

interface PlaceHit {
  displayName?: { text?: string }
  formattedAddress?: string
  googleMapsUri?: string
  businessStatus?: string
  rating?: number
  userRatingCount?: number
}

/**
 * googleMapsUri 後面帶一段很長的追蹤參數（`&g_mp=Cidnb29n…`，約 70 字），
 * 在 LINE 上整串顯示出來很難看；拿掉只剩 `?cid=…` 一樣打得開同一個地點。
 */
export function shortMapsUrl(uri: string): string {
  try {
    const url = new URL(uri)
    url.searchParams.delete('g_mp')
    return url.toString()
  } catch {
    return uri
  }
}

const CLOSED_STATUS: Record<string, string> = {
  CLOSED_TEMPORARILY: '暫停營業',
  CLOSED_PERMANENTLY: '已歇業',
}

export async function searchPlaces(
  args: { query?: string | null; date?: string | null },
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const query = args.query?.trim()
  if (!query) return { error: 'query is required' }
  if (!ctx.placesApiKey) return { error: 'Place search is not configured. Do not attach map links for places outside the itinerary.' }

  const plan = ctx.loadItinerary ? await ctx.loadItinerary() : null
  const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : ctx.today
  const day = plan?.days.find((d) => d.date === date)
  const coords = day ? dayCoordinates(day) : null
  const timezone = ctx.trip.timezone ?? plan?.timeZone ?? undefined
  const region = timezone ? countryForTimezone(timezone) : undefined

  const body: Record<string, unknown> = { textQuery: query, languageCode: 'zh-TW', pageSize: MAX_RESULTS }
  if (region) body.regionCode = region
  if (coords) {
    body.locationBias = { circle: { center: { latitude: coords.lat, longitude: coords.lng }, radius: BIAS_RADIUS_M } }
  }

  const doFetch = ctx.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': ctx.placesApiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    return { error: `Place search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const json = await res.json().catch(() => ({})) as { places?: PlaceHit[]; error?: { message?: string } }
  if (!res.ok) {
    console.error('[PLACES]', res.status, json.error?.message ?? '')
    return { error: `Place search failed (HTTP ${res.status}). Do not attach map links.` }
  }

  const hits = (json.places ?? []).filter((p) => p.displayName?.text && p.googleMapsUri)
  // 歇業的直接濾掉：模型看得到就會說「某某已歇業，就不推了」，使用者不想聽這句
  const open = hits.filter((p) => !(p.businessStatus && CLOSED_STATUS[p.businessStatus]))
  const places = open.map((p) => ({
    name: p.displayName!.text!,
    address: p.formattedAddress ?? null,
    maps_url: shortMapsUrl(p.googleMapsUri!),
    rating: p.rating ?? null,
    rating_count: p.userRatingCount ?? null,
  }))
  if (places.length > 0) return { query, places }
  if (hits.length > 0) {
    // 全部都歇業：使用者指名問這一家時才需要知道（不然會以為查不到）
    return {
      query, places: [],
      closed: hits.map((p) => `${p.displayName!.text!}（${CLOSED_STATUS[p.businessStatus!]}）`),
      note: 'Closed. Mention it only if the user asked about this specific place; when recommending, leave it out without saying anything.',
    }
  }
  return { query, places: [], note: 'Nothing found. Do not recommend or link this place.' }
}
