// ============================================================
// web-chat/auth.ts —— 誰可以操作哪一趟旅程
//
// 舊版：沒有登入，跟網頁其他地方一樣，知道旅程 id 就能進來
//       （通行碼在網頁的 TripPortal 驗，資料庫的 RLS 目前全面開放，見 docs/ROADMAP.md）。
// 開放版（tlb-web-chat）：讀 Authorization 的使用者 JWT → 必須是這趟的成員 →
//       名字用他在這趟的成員名字（不相信前端送的），AI 次數也記在這個帳號。
// ============================================================

import type { SupabaseClient } from "../_shared/deps.ts"
import type { TripRow } from "../_shared/types.ts"
import { IS_PUBLIC } from "./config.ts"

export type AuthResult =
  | { ok: true; trip: TripRow; memberName?: string; userId?: string }
  | { ok: false; status: number; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function authorizeTrip(db: SupabaseClient, req: Request, tripId: unknown): Promise<AuthResult> {
  if (typeof tripId !== 'string' || !UUID_RE.test(tripId)) return { ok: false, status: 400, error: 'invalid_trip' }
  if (IS_PUBLIC) {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) return { ok: false, status: 401, error: 'not_signed_in' }
    // 互不相依，一起查
    const [{ data: { user } }, { data: trip }] = await Promise.all([
      db.auth.getUser(jwt),
      db.from('trips').select('*').eq('id', tripId).maybeSingle(),
    ])
    if (!user) return { ok: false, status: 401, error: 'not_signed_in' }
    if (!trip) return { ok: false, status: 404, error: 'trip_not_found' }
    const { data: member } = await db.from('trip_members').select('member_name')
      .eq('trip_id', tripId).eq('user_id', user.id).maybeSingle()
    if (!member) return { ok: false, status: 403, error: 'not_member' }
    return { ok: true, trip: trip as TripRow, memberName: member.member_name, userId: user.id }
  }
  // select('*') 包含 access_code，但只留在函式裡，不回給前端
  const { data: trip } = await db.from('trips').select('*').eq('id', tripId).maybeSingle()
  if (!trip) return { ok: false, status: 404, error: 'trip_not_found' }
  return { ok: true, trip: trip as TripRow }
}
