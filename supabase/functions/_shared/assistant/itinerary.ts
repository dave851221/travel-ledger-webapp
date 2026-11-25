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

const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 3_000
/** 網頁那邊 src/features/itinerary/export.ts 的 ITINERARY_JSON_VERSION */
const SUPPORTED_VERSION = 1

const cache = new Map<string, { doc: ItineraryDoc | null; at: number }>()

/** 建一個讀行程表的函式（webappUrl 由呼叫端從環境變數給）。快取在 isolate 裡，各函式各一份 */
export function createItineraryLoader(webappUrl: string): (tripId: string) => Promise<ItineraryDoc | null> {
  return (tripId) => loadItineraryFrom(webappUrl, tripId)
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
