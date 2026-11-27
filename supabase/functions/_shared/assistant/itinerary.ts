// ============================================================
// _shared/assistant/itinerary.ts —— 讀這趟旅程的行程表（LINE、網頁聊天共用）
//
// 行程寫在網頁的程式碼裡（src/features/itinerary/trips/），build 時輸出成
// `<WEBAPP_URL>/itinerary/<tripId>.json`（vite.config.ts 的 itineraryJson plugin）。
// 這裡去 GitHub Pages 讀那份 JSON —— 改行程只要 push 網頁，不必重新部署函式。
//
// 讀到的結果（包括「這趟沒有行程」）在 isolate 裡暫存一段時間。
// ============================================================

import type { ItineraryDoc } from "../tools/types.ts"
import { fetchSheetItinerary } from "../sheetItinerary.ts"
import type { SupabaseClient } from "../deps.ts"

/** 開放版：這趟有沒有連 Google 試算表（有就讀試算表，不讀網頁的 JSON） */
export type SheetSource = (tripId: string) => Promise<{ sheetId: string; title: string; year: number } | null>

/** 試算表改了要很快看得到，快取短一點 */
const SHEET_CACHE_TTL_MS = 2 * 60 * 1000

const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 3_000
/** 網頁那邊 src/features/itinerary/export.ts 的 ITINERARY_JSON_VERSION */
const SUPPORTED_VERSION = 1

const cache = new Map<string, { doc: ItineraryDoc | null; at: number }>()

/** 建一個讀行程表的函式（webappUrl 由呼叫端從環境變數給）。快取在 isolate 裡，各函式各一份 */
export function createItineraryLoader(webappUrl: string, sheetSource?: SheetSource): (tripId: string) => Promise<ItineraryDoc | null> {
  return async (tripId) => {
    if (sheetSource) {
      const sheet = await sheetSource(tripId).catch(() => null)
      if (sheet) return loadFromSheet(tripId, sheet)
    }
    return loadItineraryFrom(webappUrl, tripId)
  }
}

async function loadFromSheet(tripId: string, s: { sheetId: string; title: string; year: number }): Promise<ItineraryDoc | null> {
  const key = `sheet:${s.sheetId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < SHEET_CACHE_TTL_MS) return hit.doc
  const r = await fetchSheetItinerary(s.sheetId, s.title, s.year)
  if (!r.ok) {
    console.warn(`[ITINERARY] sheet for ${tripId}: ${r.error}`)
    if (r.error === 'fetch_failed') return null
  }
  const doc = r.ok ? r.doc : null
  cache.set(key, { doc, at: Date.now() })
  return doc
}

async function loadItineraryFrom(webappUrl: string, tripId: string): Promise<ItineraryDoc | null> {
  const hit = cache.get(tripId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.doc

  let doc: ItineraryDoc | null = null
  try {
    const res = await fetch(`${webappUrl}/itinerary/${tripId}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.ok) {
      const json = await res.json() as ItineraryDoc
      if (json?.version === SUPPORTED_VERSION && Array.isArray(json.days)) doc = json
      else console.warn(`[ITINERARY] Unsupported itinerary format for ${tripId} (version ${json?.version})`)
    } else if (res.status !== 404) {
      // 404 是正常的（這趟沒有行程頁）；其他錯誤不要快取，下一則訊息再試
      console.warn(`[ITINERARY] Fetch failed for ${tripId}: HTTP ${res.status}`)
      return null
    }
  } catch (err) {
    console.warn(`[ITINERARY] Fetch failed for ${tripId}:`, err)
    return null
  }
  cache.set(tripId, { doc, at: Date.now() })
  return doc
}

/** 開放版：從 app.trips 讀試算表 id（db 要指向 app schema） */
export function tripSheetSource(db: SupabaseClient): SheetSource {
  return async (tripId) => {
    const { data } = await db.from('trips').select('name, start_date, itinerary_sheet').eq('id', tripId).maybeSingle()
    const row = data as { name: string; start_date: string | null; itinerary_sheet: string | null } | null
    if (!row?.itinerary_sheet) return null
    const year = row.start_date ? Number(row.start_date.slice(0, 4)) : new Date().getFullYear()
    return { sheetId: row.itinerary_sheet, title: row.name, year }
  }
}
