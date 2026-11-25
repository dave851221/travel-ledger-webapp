// ============================================================
// itinerary.ts —— 讀這趟旅程的行程表（實作在 _shared/assistant/itinerary.ts）
// ============================================================

import { WEBAPP_URL } from "./config.ts"
import { createItineraryLoader } from "../_shared/assistant/itinerary.ts"

export const loadItinerary = createItineraryLoader(WEBAPP_URL)
