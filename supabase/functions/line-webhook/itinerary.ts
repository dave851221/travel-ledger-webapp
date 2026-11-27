// ============================================================
// itinerary.ts —— 讀這趟旅程的行程表（實作在 _shared/assistant/itinerary.ts）
// 開放版的旅程可以連 Google 試算表（app.trips.itinerary_sheet），有連就讀試算表。
// ============================================================

import { IS_PUBLIC, WEBAPP_URL } from "./config.ts"
import { createItineraryLoader, tripSheetSource } from "../_shared/assistant/itinerary.ts"
import { supabase } from "./db.ts"

export const loadItinerary = createItineraryLoader(WEBAPP_URL, IS_PUBLIC ? tripSheetSource(supabase) : undefined)
