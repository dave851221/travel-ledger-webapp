// ============================================================
// tlb-photos —— 開放版（旅行小本本）的照片：放在 Cloudflare R2 的私有 bucket
//
// David 2026-11-27：照片搬出 Supabase Storage，讓 Supabase 維持免費方案。
// 網頁不直接碰 R2（金鑰只在這裡），一律經過這支：
//   POST ?action=upload&tripId=…&kind=chat|expense   body 是圖片本身（≤ 10 MB）
//        → 是成員、沒超過照片張數上限才存（app.add_trip_photo 先占位置），回 { path }
//   POST { action: 'sign', paths }        → { urls: { [path]: 簽名網址 } }（12 小時，只簽自己是成員的旅程）
//   POST { action: 'remove', paths }      → 刪掉（只刪自己是成員的旅程裡的）
//   POST { action: 'remove_trip', tripId } → 整趟刪光（只有 owner；刪旅程、刪帳號之前呼叫）
// 部署：supabase functions deploy tlb-photos --no-verify-jwt（身分在這裡自己驗）
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient, type SupabaseClient } from "../_shared/deps.ts"
import { createR2Store, createSupabaseStore, r2ConfigFromEnv, type PhotoStore } from "../_shared/photoStore.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const db = createClient(SUPABASE_URL, SERVICE_KEY, { db: { schema: 'app' } }) as unknown as SupabaseClient

// 沒設 R2 金鑰（本機）時退回私有 bucket app-images，行為一樣
const r2 = r2ConfigFromEnv(k => Deno.env.get(k))
const store: PhotoStore = r2 ? createR2Store(r2, db) : createSupabaseStore(db, 'app-images', false)

const SIGN_TTL = 12 * 60 * 60
const MAX_BYTES = 10 * 1024 * 1024
const MAX_PATHS = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PATH_RE = /^expenses\/([0-9a-f-]{36})\/[A-Za-z0-9._-]{1,120}$/
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif' }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const tripOf = (path: string): string | null => PATH_RE.exec(path)?.[1] ?? null

async function userOf(req: Request): Promise<string | null> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  const { data: { user } } = await db.auth.getUser(jwt)
  return user?.id ?? null
}

/** 這個帳號在哪幾趟旅程是成員（只查問到的那幾趟）；值是角色 */
async function rolesIn(userId: string, tripIds: string[]): Promise<Map<string, string>> {
  if (tripIds.length === 0) return new Map()
  const { data } = await db.from('trip_members').select('trip_id, role').eq('user_id', userId).in('trip_id', tripIds)
  return new Map(((data ?? []) as { trip_id: string; role: string }[]).map(r => [r.trip_id, r.role]))
}

/** 只留格式正確、而且是自己旅程裡的路徑 */
async function allowedPaths(userId: string, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw)) return []
  const paths = [...new Set(raw.filter((p): p is string => typeof p === 'string' && !!tripOf(p)))].slice(0, MAX_PATHS)
  const roles = await rolesIn(userId, [...new Set(paths.map(p => tripOf(p)!))])
  return paths.filter(p => roles.has(tripOf(p)!))
}

async function upload(req: Request, userId: string, url: URL): Promise<Response> {
  const tripId = url.searchParams.get('tripId') || ''
  if (!UUID_RE.test(tripId)) return json({ error: 'invalid_trip' }, 400)
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase()
  const ext = TYPES[type]
  if (!ext) return json({ error: 'invalid_type' }, 400)
  const roles = await rolesIn(userId, [tripId])
  if (!roles.has(tripId)) return json({ error: 'not_member' }, 403)
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.byteLength === 0) return json({ error: 'empty' }, 400)
  if (body.byteLength > MAX_BYTES) return json({ error: 'too_large' }, 413)

  const prefix = url.searchParams.get('kind') === 'chat' ? 'chat_' : ''
  const path = `expenses/${tripId}/${prefix}${crypto.randomUUID()}.${ext}`
  const { error } = await db.rpc('add_trip_photo', { p_trip_id: tripId, p_path: path, p_user: userId })
  if (error) {
    if (String(error.message).includes('photo_limit')) return json({ error: 'photo_limit' }, 409)
    console.error('[PHOTOS] reserve failed', error.message)
    return json({ error: 'internal_error' }, 500)
  }
  try {
    await store.upload(path, body, type, userId)
  } catch (e) {
    console.error('[PHOTOS] upload failed', e)
    await db.from('trip_photos').delete().eq('path', path)
    return json({ error: 'upload_failed' }, 502)
  }
  // 退回 Storage 時檔案本身就會被 count_photos 算到，占位的那列拿掉才不會算兩次
  if (!r2) await db.from('trip_photos').delete().eq('path', path)
  return json({ path })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const userId = await userOf(req)
  if (!userId) return json({ error: 'not_signed_in' }, 401)

  const url = new URL(req.url)
  try {
    if (url.searchParams.get('action') === 'upload') return await upload(req, userId, url)

    let body: { action?: string; paths?: unknown; tripId?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid_json' }, 400)
    }
    switch (body.action) {
      case 'sign': {
        const paths = await allowedPaths(userId, body.paths)
        const entries = await Promise.all(paths.map(async p => [p, await store.viewUrl(p, SIGN_TTL)] as const))
        return json({ urls: Object.fromEntries(entries.filter(([, u]) => u)), ttl: SIGN_TTL })
      }
      case 'remove': {
        const paths = await allowedPaths(userId, body.paths)
        await store.remove(paths)
        return json({ removed: paths.length })
      }
      case 'remove_trip': {
        const tripId = typeof body.tripId === 'string' ? body.tripId : ''
        if (!UUID_RE.test(tripId)) return json({ error: 'invalid_trip' }, 400)
        const roles = await rolesIn(userId, [tripId])
        if (roles.get(tripId) !== 'owner') return json({ error: 'not_owner' }, 403)
        await store.removeTrip(tripId)
        return json({ ok: true })
      }
      default:
        return json({ error: 'unknown_action' }, 400)
    }
  } catch (e) {
    console.error('[PHOTOS] failed', e)
    return json({ error: 'internal_error' }, 500)
  }
})
