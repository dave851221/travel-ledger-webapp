// ============================================================
// itinerary.ts —— 讀這趟旅程的行程表
//
// 行程寫在網頁的程式碼裡（src/features/itinerary/trips/），build 時輸出成
// `<WEBAPP_URL>/itinerary/<tripId>.json`（vite.config.ts 的 itineraryJson plugin）。
// 這裡去 GitHub Pages 讀那份 JSON —— 改行程只要 push 網頁，不必重新部署 Bot。
//
// 讀到的結果（包括「這趟沒有行程」）在 isolate 裡暫存一段時間，
// 同一則訊息裡的多次工具呼叫、以及接下來幾分鐘的對話都不必再抓一次。
// ============================================================

import { WEBAPP_URL } from "./config.ts"
import type { ItineraryDoc } from "../_shared/tools/types.ts"

const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 3_000
/** 網頁那邊 src/features/itinerary/export.ts 的 ITINERARY_JSON_VERSION */
const SUPPORTED_VERSION = 1

const cache = new Map<string, { doc: ItineraryDoc | null; at: number }>()

export async function loadItinerary(tripId: string): Promise<ItineraryDoc | null> {
  const hit = cache.get(tripId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.doc

  let doc: ItineraryDoc | null = null
  try {
    const res = await fetch(`${WEBAPP_URL}/itinerary/${tripId}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
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
