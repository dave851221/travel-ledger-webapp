// ============================================================
// tools/places.ts —— 查真實存在的地點（Google Places API (New) + Routes API）
//
// 模型推薦店家、景點時自己附的地圖連結常常是錯的：編出來的短網址指到別的地方，
// 搜尋連結只搜到「台中」。所以推薦行程表以外的地點，一律先用這支查過，
// 只附它回傳的 googleMapsUri（Google 地圖上那個地點本身的頁面）。
//
// 遠近也不能讓模型用猜的（它曾把 3 公里外的店說成「離 ROOMIN 不遠」）：
// 每次查詢都有一個中心點（near，或當天行程的地點），結果附上直線距離與
// 步行／大眾運輸／開車的實際分鐘數（Routes API 的 route matrix）。
// 給了 near 就是「某某附近」—— 只在半徑內找（locationRestriction），範圍外的根本不會出現。
//
// 要錢：rating 屬於 Text Search Enterprise，每月前 1,000 次免費，之後約 US$0.035／次；
// 中心點的 geocode 是 Text Search Pro（5,000 次免費）；route matrix 每個起訖組合算一次（10,000 次免費）。
// 用量上限設在 Google Cloud Console 的 API 配額，程式裡沒有另外管。
// 沒設 key 時（ctx.placesApiKey 為空）LINE 不公開這支工具，見 line-webhook/ai.ts。
// ============================================================

import { dayCoordinates } from "./itinerary.ts"
import type { ItineraryDayDoc, ItineraryDoc, ToolContext } from "./types.ts"
import { countryForTimezone } from "./weather.ts"

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText'
const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix'
const TIMEOUT_MS = 6_000
const MAX_RESULTS = 5
/**
 * 「附近」預設找直線 1 公里內。實測台中市區直線 1.5 公里要走 24–27 分鐘（街道會繞），
 * 1 公里大約 15–20 分鐘，比較接近大家說的「附近」。
 */
const DEFAULT_RADIUS_M = 1_000
const MIN_RADIUS_M = 300
const MAX_RADIUS_M = 10_000
/** 沒說「附近」時（指名查某一家）只偏好中心點周圍，不限制 */
const BIAS_RADIUS_M = 5_000

const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.rating',
  'places.userRatingCount',
  'places.location',
].join(',')
const GEOCODE_FIELD_MASK = 'places.displayName,places.location'

interface LatLng { latitude: number; longitude: number }
interface Center { lat: number; lng: number; label: string }

interface PlaceHit {
  displayName?: { text?: string }
  formattedAddress?: string
  googleMapsUri?: string
  businessStatus?: string
  rating?: number
  userRatingCount?: number
  location?: LatLng
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

/** 兩點的直線距離（公尺） */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => d * Math.PI / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)))
}

async function postJson(
  ctx: ToolContext, url: string, fieldMask: string, body: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const doFetch = ctx.fetch ?? fetch
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': ctx.placesApiKey!, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) }
}

// 同一則訊息常常一次查好幾家，near 都一樣 —— isolate 內記住，不要每家都 geocode 一次
const centerCache = new Map<string, Center | null>()
const CENTER_CACHE_MAX = 100

async function geocode(text: string, region: string | undefined, bias: { lat: number; lng: number } | null, ctx: ToolContext): Promise<Center | null> {
  const key = `${text}|${region ?? ''}|${bias ? `${bias.lat},${bias.lng}` : ''}`
  if (centerCache.has(key)) return centerCache.get(key)!
  const body: Record<string, unknown> = { textQuery: text, languageCode: 'zh-TW', pageSize: 1 }
  if (region) body.regionCode = region
  if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 30_000 } }
  let center: Center | null = null
  try {
    const { ok, status, json } = await postJson(ctx, SEARCH_URL, GEOCODE_FIELD_MASK, body)
    // API 錯誤不記進快取，下一次再試
    if (!ok) {
      console.warn(`[PLACES] geocode failed: HTTP ${status}`)
      return null
    }
    const hit = (json as { places?: PlaceHit[] }).places?.[0]
    if (hit?.location) center = { lat: hit.location.latitude, lng: hit.location.longitude, label: hit.displayName?.text ?? text }
  } catch (err) {
    console.warn('[PLACES] geocode failed:', err)
    return null
  }
  if (centerCache.size >= CENTER_CACHE_MAX) centerCache.delete(centerCache.keys().next().value!)
  centerCache.set(key, center)
  return center
}

/**
 * 以哪裡為中心算遠近：
 * 1. 給了 near：先找行程表上同名的地點（有座標直接用，沒有就 geocode 它的搜尋字），再不然 geocode near 本身
 * 2. 沒給：那一天行程的座標，再不然 geocode 那一天第一個地點
 */
async function resolveCenter(
  near: string | undefined, day: ItineraryDayDoc | undefined, plan: ItineraryDoc | null,
  region: string | undefined, ctx: ToolContext,
): Promise<Center | null> {
  const dayCoords = day ? dayCoordinates(day) : null
  const days = [...(day ? [day] : []), ...(plan?.days ?? [])]
  if (near) {
    const needle = near.toLowerCase()
    const place = days.flatMap((d) => d.items.flatMap((i) => i.places ?? []))
      .find((p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()))
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) return { lat: place.lat!, lng: place.lng!, label: place.name }
    if (place) {
      const hit = await geocode(place.query ?? place.name, region, dayCoords, ctx)
      if (hit) return { ...hit, label: place.name }
    }
    return geocode(near, region, dayCoords, ctx)
  }
  if (dayCoords) return { ...dayCoords, label: day?.city ?? day?.title ?? '' }
  const first = day?.items.flatMap((i) => i.places ?? [])[0]
  if (first) {
    const hit = await geocode(first.query ?? first.name, region, null, ctx)
    if (hit) return { ...hit, label: first.name }
  }
  return null
}

const MODES = { walk: 'WALK', transit: 'TRANSIT', drive: 'DRIVE' } as const
type ModeKey = keyof typeof MODES

/** 中心點到每個結果的步行／大眾運輸／開車分鐘數。失敗的模式就留空，不擋整個查詢 */
async function travelMinutes(center: Center, targets: LatLng[], ctx: ToolContext): Promise<Partial<Record<ModeKey, number>>[]> {
  const out: Partial<Record<ModeKey, number>>[] = targets.map(() => ({}))
  if (targets.length === 0) return out
  await Promise.all((Object.keys(MODES) as ModeKey[]).map(async (mode) => {
    try {
      const { ok, status, json } = await postJson(ctx, MATRIX_URL, 'originIndex,destinationIndex,duration,condition', {
        origins: [{ waypoint: { location: { latLng: { latitude: center.lat, longitude: center.lng } } } }],
        destinations: targets.map((latLng) => ({ waypoint: { location: { latLng } } })),
        travelMode: MODES[mode],
      })
      if (!ok || !Array.isArray(json)) {
        console.warn(`[PLACES] route matrix ${mode} failed: HTTP ${status}`)
        return
      }
      for (const el of json as { destinationIndex?: number; duration?: string; condition?: string }[]) {
        const seconds = Number.parseInt(el.duration ?? '', 10)
        if (el.condition !== 'ROUTE_EXISTS' || !Number.isFinite(seconds)) continue
        out[el.destinationIndex ?? 0][mode] = Math.max(1, Math.round(seconds / 60))
      }
    } catch (err) {
      console.warn(`[PLACES] route matrix ${mode} failed:`, err)
    }
  }))
  return out
}

/** 以中心點為圓心、radius 公尺的外接矩形（locationRestriction 只收矩形） */
function boundingBox(center: Center, radius: number) {
  const dLat = radius / 111_320
  const dLng = radius / (111_320 * Math.cos(center.lat * Math.PI / 180))
  return {
    rectangle: {
      low: { latitude: center.lat - dLat, longitude: center.lng - dLng },
      high: { latitude: center.lat + dLat, longitude: center.lng + dLng },
    },
  }
}

export async function searchPlaces(
  args: { query?: string | null; near?: string | null; radius_m?: number | null; date?: string | null },
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const query = args.query?.trim()
  if (!query) return { error: 'query is required' }
  if (!ctx.placesApiKey) return { error: 'Place search is not configured. Do not attach map links for places outside the itinerary.' }

  const plan = ctx.loadItinerary ? await ctx.loadItinerary() : null
  const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : ctx.today
  const day = plan?.days.find((d) => d.date === date)
  const timezone = ctx.trip.timezone ?? plan?.timeZone ?? undefined
  const region = timezone ? countryForTimezone(timezone) : undefined
  const near = args.near?.trim() || undefined

  const center = await resolveCenter(near, day, plan, region, ctx)
  if (near && !center) return { error: `Could not locate "${near}". Ask the user where exactly, do not guess.` }
  const radius = near ? Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Number(args.radius_m) || DEFAULT_RADIUS_M)) : null

  const body: Record<string, unknown> = { textQuery: query, languageCode: 'zh-TW', pageSize: near ? 10 : MAX_RESULTS }
  if (region) body.regionCode = region
  if (center && radius) body.locationRestriction = boundingBox(center, radius)
  else if (center) body.locationBias = { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: BIAS_RADIUS_M } }

  let res: { ok: boolean; status: number; json: unknown }
  try {
    res = await postJson(ctx, SEARCH_URL, FIELD_MASK, body)
  } catch (err) {
    return { error: `Place search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const json = res.json as { places?: PlaceHit[]; error?: { message?: string } }
  if (!res.ok) {
    console.error('[PLACES]', res.status, json.error?.message ?? '')
    return { error: `Place search failed (HTTP ${res.status}). Do not attach map links.` }
  }

  const hits = (json.places ?? []).filter((p) => p.displayName?.text && p.googleMapsUri)
  // 歇業的直接濾掉：模型看得到就會說「某某已歇業，就不推了」，使用者不想聽這句
  const open = hits
    .filter((p) => !(p.businessStatus && CLOSED_STATUS[p.businessStatus]))
    .map((p) => ({
      hit: p,
      distance: center && p.location ? distanceMeters(center, { lat: p.location.latitude, lng: p.location.longitude }) : null,
    }))
    // 矩形的四個角超出半徑，這裡再用圓切一次
    .filter(({ distance }) => radius === null || distance === null || distance <= radius)
    .slice(0, MAX_RESULTS)

  if (open.length === 0) {
    if (hits.length > 0 && hits.every((p) => p.businessStatus && CLOSED_STATUS[p.businessStatus])) {
      // 全部都歇業：使用者指名問這一家時才需要知道（不然會以為查不到）
      return {
        query, places: [],
        closed: hits.map((p) => `${p.displayName!.text!}（${CLOSED_STATUS[p.businessStatus!]}）`),
        note: 'Closed. Mention it only if the user asked about this specific place; when recommending, leave it out without saying anything.',
      }
    }
    return {
      query, places: [],
      ...(center && radius ? { from: center.label, radius_m: radius } : {}),
      note: radius
        ? `Nothing within ${radius} m of ${center!.label}. Say so; do not recommend places farther away unless the user agrees.`
        : 'Nothing found. Do not recommend or link this place.',
    }
  }

  const minutes = center
    ? await travelMinutes(center, open.map(({ hit }) => hit.location!).filter(Boolean), ctx)
    : []
  let withLocation = 0
  const places = open.map(({ hit, distance }) => {
    const times = hit.location ? minutes[withLocation++] ?? {} : {}
    return {
      name: hit.displayName!.text!,
      address: hit.formattedAddress ?? null,
      maps_url: shortMapsUrl(hit.googleMapsUri!),
      rating: hit.rating ?? null,
      rating_count: hit.userRatingCount ?? null,
      ...(distance !== null ? { distance_m: distance } : {}),
      ...(times.walk !== undefined ? { walk_min: times.walk } : {}),
      ...(times.transit !== undefined ? { transit_min: times.transit } : {}),
      ...(times.drive !== undefined ? { drive_min: times.drive } : {}),
    }
  })
  return {
    query,
    ...(center ? { from: center.label } : {}),
    ...(radius ? { radius_m: radius } : {}),
    places,
  }
}
