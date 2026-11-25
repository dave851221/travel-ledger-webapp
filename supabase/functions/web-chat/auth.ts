// ============================================================
// web-chat/auth.ts —— 誰可以操作哪一趟旅程
//
// 現在的版本沒有登入：跟網頁其他地方一樣，知道旅程 id 就能進來
// （通行碼在網頁的 TripPortal 驗，資料庫的 RLS 目前全面開放，見 docs/ROADMAP.md）。
// 這支函式因此不比網頁直接寫資料庫更寬鬆 —— 它能做的事（記帳、改、刪）網頁本來就能做。
//
// 🔁 開放版（LINE／Google 登入）沿用時**只要換掉這一支**：
//    讀 Authorization 的使用者 JWT（supabase.auth.getUser）→ 查他是不是這趟旅程的成員 →
//    回傳旅程與他在旅程裡的名字（memberName 改由這裡決定，不再相信前端送的）。
// ============================================================

import type { SupabaseClient } from "../_shared/deps.ts"
import type { TripRow } from "../_shared/types.ts"

export type AuthResult =
  | { ok: true; trip: TripRow; memberName?: string }
  | { ok: false; status: number; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function authorizeTrip(db: SupabaseClient, _req: Request, tripId: unknown): Promise<AuthResult> {
  if (typeof tripId !== 'string' || !UUID_RE.test(tripId)) return { ok: false, status: 400, error: 'invalid_trip' }
  // select('*') 包含 access_code，但只留在函式裡，不回給前端
  const { data: trip } = await db.from('trips').select('*').eq('id', tripId).maybeSingle()
  if (!trip) return { ok: false, status: 404, error: 'trip_not_found' }
  return { ok: true, trip: trip as TripRow }
}
