// ============================================================
// tlb-itinerary —— 開放版：讀旅程連的 Google 試算表，回行程頁的資料
//
// POST { tripId }            → 讀這趟存的試算表（要登入、是成員）
// POST { tripId, sheet }     → 先試讀一份還沒存的（設定頁貼上連結時檢查用；一樣要是成員）
// 回 { doc } 或 { error: not_shared | no_itinerary | fetch_failed | no_sheet }
// 解析在 _shared/sheetItinerary.ts；試算表要「知道連結的人都能檢視」。
// 部署：supabase functions deploy tlb-itinerary --no-verify-jwt（身分在這裡自己驗）
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient, type SupabaseClient } from "../_shared/deps.ts"
import { fetchSheetItinerary, sheetIdFromUrl } from "../_shared/sheetItinerary.ts"

const db = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  { db: { schema: 'app' } }) as unknown as SupabaseClient

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let body: { tripId?: unknown; sheet?: unknown; token?: unknown; password?: unknown }
  try { body = await req.json() } catch { return json({ error: 'invalid_json' }, 400) }
  const tripId = typeof body.tripId === 'string' ? body.tripId : ''
  if (!UUID_RE.test(tripId)) return json({ error: 'invalid_trip' }, 400)

  // 分享頁（沒登入）：分享連結（與密碼）對了才讀這趟存的那份
  if (typeof body.token === 'string') {
    const [{ data: ok }, { data: shared }] = await Promise.all([
      db.rpc('share_access_ok', { p_trip_id: tripId, p_token: body.token, p_password: typeof body.password === 'string' ? body.password : null }),
      db.from('trips').select('name, start_date, itinerary_sheet').eq('id', tripId).maybeSingle(),
    ])
    if (ok !== true || !shared) return json({ error: 'no_access' }, 403)
    const s = shared as { name: string; start_date: string | null; itinerary_sheet: string | null }
    if (!s.itinerary_sheet) return json({ error: 'no_sheet' }, 200)
    const r = await fetchSheetItinerary(s.itinerary_sheet, s.name, s.start_date ? Number(s.start_date.slice(0, 4)) : new Date().getFullYear())
    return r.ok ? json({ doc: r.doc, sheetId: s.itinerary_sheet }) : json({ error: r.error, sheetId: s.itinerary_sheet }, 200)
  }

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const [{ data: { user } }, { data: trip }] = await Promise.all([
    jwt ? db.auth.getUser(jwt) : Promise.resolve({ data: { user: null } }),
    db.from('trips').select('name, start_date, itinerary_sheet').eq('id', tripId).maybeSingle(),
  ])
  if (!user) return json({ error: 'not_signed_in' }, 401)
  if (!trip) return json({ error: 'trip_not_found' }, 404)
  const { data: member } = await db.from('trip_members').select('user_id').eq('trip_id', tripId).eq('user_id', user.id).maybeSingle()
  if (!member) return json({ error: 'not_member' }, 403)

  const row = trip as { name: string; start_date: string | null; itinerary_sheet: string | null }
  const sheetId = typeof body.sheet === 'string' ? sheetIdFromUrl(body.sheet) : row.itinerary_sheet
  if (!sheetId) return json({ error: 'no_sheet' }, 400)
  const year = row.start_date ? Number(row.start_date.slice(0, 4)) : new Date().getFullYear()
  const r = await fetchSheetItinerary(sheetId, row.name, year)
  return r.ok ? json({ doc: r.doc, sheetId }) : json({ error: r.error, sheetId }, 200)
})
