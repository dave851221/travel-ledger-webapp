// ============================================================
// tools/weather.ts —— 天氣預報（Open-Meteo，免費、不需要 key）
//
// 天氣是旅途中最常問的事，走 web_search 一次要 US$0.01 再加一大包搜尋結果，
// 這裡直接打免費的預報 API，只回幾個數字。
//
// 地點：有給 place 就先 geocode；沒給就用行程表上那一天的路線座標。
// 預報只到 16 天後，更遠的日期回錯誤讓模型自己說明。
// ============================================================

import { dayCoordinates } from "./itinerary.ts"
import type { ToolContext } from "./types.ts"

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const TIMEOUT_MS = 5_000

/** WMO weather code → 中文 */
const WEATHER_CODES: Record<number, string> = {
  0: '晴', 1: '大致晴朗', 2: '多雲', 3: '陰',
  45: '霧', 48: '霧凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '較強的毛毛雨', 56: '凍毛毛雨', 57: '凍毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '凍雨', 67: '強凍雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '陣雨', 81: '較強的陣雨', 82: '豪大陣雨', 85: '陣雪', 86: '強陣雪',
  95: '雷雨', 96: '雷雨伴隨冰雹', 99: '強雷雨伴隨冰雹',
}

/** geocode 時用旅程時區縮小國家範圍，「高山」才不會跑到別的國家 */
const TIMEZONE_COUNTRIES: Record<string, string> = {
  'Asia/Tokyo': 'JP', 'Asia/Taipei': 'TW', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK', 'Asia/Macau': 'MO', 'Asia/Bangkok': 'TH', 'Asia/Singapore': 'SG',
  'Asia/Ho_Chi_Minh': 'VN', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Manila': 'PH',
}

export const describeWeatherCode = (code: number): string => WEATHER_CODES[code] ?? `代碼 ${code}`

/** IANA 時區 → ISO 國碼。認不得的時區回 undefined（geocode 與上網搜尋就不限定國家） */
export const countryForTimezone = (timezone: string): string | undefined => TIMEZONE_COUNTRIES[timezone]

interface Point { lat: number; lng: number; label: string }

async function getJson(ctx: ToolContext, url: string): Promise<Record<string, unknown>> {
  const doFetch = ctx.fetch ?? fetch
  const res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(String(body.reason ?? `HTTP ${res.status}`))
  return body
}

async function geocode(place: string, country: string | undefined, ctx: ToolContext): Promise<Point | null> {
  const search = async (withCountry: boolean) => {
    const params = new URLSearchParams({ name: place, count: '1', language: 'zh', format: 'json' })
    if (withCountry && country) params.set('countryCode', country)
    const body = await getJson(ctx, `${GEOCODE_URL}?${params}`)
    const hit = (body.results as { latitude: number; longitude: number; name: string; admin1?: string }[] | undefined)?.[0]
    return hit ? { lat: hit.latitude, lng: hit.longitude, label: [hit.name, hit.admin1].filter(Boolean).join('，') } : null
  }
  // 先限定在旅程的國家，找不到再放寬（使用者可能問的是轉機地點）
  return (country ? await search(true) : null) ?? await search(false)
}

/** 一天切成早上、下午、晚上，各取最高的降雨機率 —— 「下午會下雨嗎」比整天的數字有用 */
function periodRain(times: string[], probs: (number | null)[], date: string): Record<string, number | null> {
  const periods = { morning: [6, 12], afternoon: [12, 18], evening: [18, 24] } as const
  const out: Record<string, number | null> = {}
  for (const [name, [from, to]] of Object.entries(periods)) {
    const values = times
      .map((t, i) => ({ t, p: probs[i] }))
      .filter(({ t }) => t.startsWith(date) && Number(t.substring(11, 13)) >= from && Number(t.substring(11, 13)) < to)
      .map(({ p }) => p)
      .filter((p): p is number => typeof p === 'number')
    out[name] = values.length > 0 ? Math.max(...values) : null
  }
  return out
}

export async function getWeather(
  args: { date?: string | null; place?: string | null },
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : ctx.today
  const plan = ctx.loadItinerary ? await ctx.loadItinerary() : null
  const timezone = ctx.trip.timezone ?? plan?.timeZone ?? undefined

  let point: Point | null = null
  if (args.place) {
    point = await geocode(args.place, timezone ? TIMEZONE_COUNTRIES[timezone] : undefined, ctx)
    if (!point) return { error: `Could not find a place called "${args.place}". Ask the user, or try the English name.` }
  } else {
    const day = plan?.days.find((d) => d.date === date)
    const coords = day ? dayCoordinates(day) : null
    if (coords) point = { ...coords, label: day?.city ?? day?.title ?? '' }
    else if (day?.city) point = await geocode(day.city, timezone ? TIMEZONE_COUNTRIES[timezone] : undefined, ctx)
    if (!point) return { error: 'No location for that date in the itinerary. Ask the user which city, then call again with place.' }
  }

  const params = new URLSearchParams({
    latitude: String(point.lat),
    longitude: String(point.lng),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
    hourly: 'precipitation_probability',
    timezone: 'auto',
    start_date: date,
    end_date: date,
  })
  let body: Record<string, unknown>
  try {
    body = await getJson(ctx, `${FORECAST_URL}?${params}`)
  } catch (err) {
    // 最常見的是日期超出預報範圍（16 天後、或太久以前）
    return { error: `Forecast unavailable for ${date}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const daily = body.daily as Record<string, (number | null)[]> | undefined
  const hourly = body.hourly as { time?: string[]; precipitation_probability?: (number | null)[] } | undefined
  if (!daily?.weather_code?.length) return { error: `No forecast for ${date}` }

  const code = Number(daily.weather_code[0])
  return {
    place: point.label,
    date,
    weather: describeWeatherCode(code),
    temp_max_c: daily.temperature_2m_max?.[0] ?? null,
    temp_min_c: daily.temperature_2m_min?.[0] ?? null,
    rain_probability_max: daily.precipitation_probability_max?.[0] ?? null,
    rain_probability_by_period: periodRain(hourly?.time ?? [], hourly?.precipitation_probability ?? [], date),
    precipitation_mm: daily.precipitation_sum?.[0] ?? null,
    wind_max_kmh: daily.wind_speed_10m_max?.[0] ?? null,
    source: 'Open-Meteo',
  }
}
