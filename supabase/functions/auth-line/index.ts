// ============================================================
// auth-line —— 開放版（旅行小本本）的 LINE 登入
//
// Supabase 沒有內建 LINE 登入，所以這支函式自己做：
//   1. 確認 LINE 身分：
//      · 網頁：OAuth 回來的 code 由這裡用 channel secret 換成 ID token，交給 LINE verify（含 nonce）
//      · LIFF：liff.getAccessToken() → LINE verify 確認是發給這個 channel、沒過期 → /v2/profile 拿 userId
//      前端送來的 ID token 一律不收（有效期內可以重放，見 logic.ts）
//   2. 用 LINE 的 userId 找 app.line_identities，沒有就建一個 Supabase 使用者
//   3. 用 admin.generateLink 產一個一次性的 token_hash 回給前端，
//      前端 supabase.auth.verifyOtp({ token_hash, type: 'email' }) 換成正式 session
//
// 另一個動作 link：已經用 Google 登入的人，把 LINE 也連到同一個帳號（同樣只收 code 或 access token）。
//
// 規則（docs/SECURITY.md）：不 log 任何 token、名字；錯誤只回固定代碼。
// 部署：supabase functions deploy auth-line --no-verify-jwt（登入前還沒有 JWT）
// 需要的 secrets：LINE_LOGIN_CHANNEL_ID、LINE_LOGIN_CHANNEL_SECRET、APP_ALLOWED_ORIGINS（逗號分隔）
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient, type SupabaseClient } from "../_shared/deps.ts"
import { accessTokenIsOurs, lineLoginEmail, parseAuthLineRequest, type AuthLineRequest } from "./logic.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const CHANNEL_ID = Deno.env.get('LINE_LOGIN_CHANNEL_ID') || ''
const CHANNEL_SECRET = Deno.env.get('LINE_LOGIN_CHANNEL_SECRET') || ''
const ALLOWED_ORIGINS = (Deno.env.get('APP_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  db: { schema: 'app' },
  auth: { persistSession: false, autoRefreshToken: false },
}) as unknown as SupabaseClient

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || ''
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  // 只允許自己的網站呼叫；不在名單上就完全不給 Allow-Origin
  // （給 'null' 反而會放行 sandbox iframe、file: 頁面送出的 Origin: null）
  if (origin && ALLOWED_ORIGINS.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } })
}

interface LineProfile { sub: string; name?: string }

/** 網頁登入：OAuth 回來的 code 換成 ID token */
async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  const res = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: CHANNEL_ID, client_secret: CHANNEL_SECRET,
    }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return typeof data?.id_token === 'string' ? data.id_token : null
}

/** 交給 LINE 驗 ID token：簽章、發給誰（client_id）、過期、nonce 都由 LINE 檢查 */
async function verifyIdToken(idToken: string, nonce?: string): Promise<LineProfile | null> {
  const params = new URLSearchParams({ id_token: idToken, client_id: CHANNEL_ID })
  if (nonce) params.set('nonce', nonce)
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  if (!res.ok) return null
  const data = await res.json()
  if (typeof data?.sub !== 'string' || !data.sub) return null
  return { sub: data.sub, name: typeof data.name === 'string' ? data.name : undefined }
}

/** LIFF：驗 access token 是發給我們這個 channel 的，再查 profile 拿 userId */
async function verifyAccessToken(accessToken: string): Promise<LineProfile | null> {
  const verify = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`)
  if (!verify.ok || !accessTokenIsOurs(await verify.json(), CHANNEL_ID)) return null
  const profile = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!profile.ok) return null
  const data = await profile.json()
  if (typeof data?.userId !== 'string' || !data.userId) return null
  return { sub: data.userId, name: typeof data.displayName === 'string' ? data.displayName : undefined }
}

/** 找出這個 LINE 帳號對應的使用者；第一次登入就建一個 */
async function findOrCreateUser(profile: LineProfile): Promise<{ userId: string; email: string } | null> {
  const email = lineLoginEmail(profile.sub)
  const { data: existing } = await db.from('line_identities').select('user_id').eq('line_user_id', profile.sub).maybeSingle()
  if (existing?.user_id) {
    await db.from('line_identities').update({ last_login_at: new Date().toISOString(), display_name: profile.name ?? null })
      .eq('line_user_id', profile.sub)
    const { data: u } = await db.auth.admin.getUserById(existing.user_id)
    // 用 Google 建的帳號後來連上 LINE：用它自己的 email 產登入 token
    return { userId: existing.user_id, email: u?.user?.email || email }
  }

  let userId: string | null = null
  const { data: created } = await db.auth.admin.createUser({
    email, email_confirm: true,
    user_metadata: { provider: 'line', name: profile.name ?? null },
  })
  if (created?.user) {
    userId = created.user.id
  } else {
    // 已經有這個 email 的使用者（上次建好使用者但對應表沒寫進去、或兩個請求同時建立）：
    // generateLink 會回傳那個使用者，接著補寫對應表，不要讓這個 LINE 帳號永遠登入不了
    const { data: link } = await db.auth.admin.generateLink({ type: 'magiclink', email })
    userId = link?.user?.id ?? null
  }
  if (!userId) return null

  // 已存在就不動（同時建立的另一個請求寫進去了），由上面的 email 對到同一個使用者
  const { error: insErr } = await db.from('line_identities').upsert({
    line_user_id: profile.sub, user_id: userId, display_name: profile.name ?? null,
  }, { onConflict: 'line_user_id', ignoreDuplicates: true })
  if (insErr) return null

  // 再讀一次，以資料庫為準（另一個請求可能先把這個 LINE 對到別的使用者）
  const { data: row } = await db.from('line_identities').select('user_id').eq('line_user_id', profile.sub).maybeSingle()
  if (!row?.user_id) return null
  if (row.user_id !== userId) {
    const { data: u } = await db.auth.admin.getUserById(row.user_id)
    return { userId: row.user_id, email: u?.user?.email || email }
  }
  return { userId, email }
}

/** 已登入的人把 LINE 連到自己的帳號 */
async function linkToCurrentUser(req: Request, profile: LineProfile): Promise<{ ok: boolean; error?: string }> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return { ok: false, error: 'not_signed_in' }
  const { data: { user } } = await db.auth.getUser(jwt)
  if (!user) return { ok: false, error: 'not_signed_in' }
  const { data: existing } = await db.from('line_identities').select('user_id').eq('line_user_id', profile.sub).maybeSingle()
  if (existing && existing.user_id !== user.id) return { ok: false, error: 'line_already_linked' }
  if (!existing) {
    const { error } = await db.from('line_identities').insert({
      line_user_id: profile.sub, user_id: user.id, display_name: profile.name ?? null,
    })
    if (error) return { ok: false, error: 'link_failed' }
  }
  return { ok: true }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405)
  if (!CHANNEL_ID || !CHANNEL_SECRET) {
    console.error('[AUTH_LINE] LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET not set')
    return json(req, { error: 'not_configured' }, 500)
  }

  let body: AuthLineRequest
  try {
    const parsed = parseAuthLineRequest(await req.json())
    if (!parsed) return json(req, { error: 'invalid_request' }, 400)
    body = parsed
  } catch {
    return json(req, { error: 'invalid_json' }, 400)
  }

  let profile: LineProfile | null = null
  if (body.accessToken) {
    profile = await verifyAccessToken(body.accessToken)
  } else if (body.code && body.redirectUri && body.nonce) {
    const idToken = await exchangeCode(body.code, body.redirectUri)
    profile = idToken ? await verifyIdToken(idToken, body.nonce) : null
  }
  if (!profile) return json(req, { error: 'line_rejected' }, 401)

  if (body.action === 'link') {
    const r = await linkToCurrentUser(req, profile)
    return r.ok ? json(req, { ok: true }) : json(req, { error: r.error }, r.error === 'not_signed_in' ? 401 : 409)
  }

  const user = await findOrCreateUser(profile)
  if (!user) return json(req, { error: 'retry' }, 503)

  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: user.email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) {
    console.error('[AUTH_LINE] generateLink failed', error?.status ?? '')
    return json(req, { error: 'retry' }, 503)
  }
  console.log('[AUTH_LINE] signed in')
  return json(req, { tokenHash, displayName: profile.name ?? null })
})
