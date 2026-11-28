// ============================================================
// auth-line —— 開放版（旅行小本本）的 LINE 登入
//
// Supabase 沒有內建 LINE 登入，所以這支函式自己做：
//   1. 確認 LINE 身分：
//      · 網頁：OAuth 回來的 code 由這裡用 channel secret 換成 ID token，驗簽章、channel、過期、nonce
//        （HS256 在這裡自己驗，看不懂才交給 LINE verify API）
//      · LIFF：liff.getAccessToken() → LINE verify 確認是發給這個 channel、沒過期 → /v2/profile 拿 userId
//      前端送來的 ID token 一律不收（有效期內可以重放，見 logic.ts）
//   2. 用 LINE 的 userId 找 app.line_identities（RPC line_login_lookup，一趟），沒有就建一個 Supabase 使用者
//   3. 用 admin generate_link 產一個一次性的 token_hash 回給前端，
//      前端 supabase.auth.verifyOtp({ token_hash, type: 'email' }) 換成正式 session
//
// 另一個動作 link：已經用 Google 登入的人，把 LINE 也連到同一個帳號（同樣只收 code 或 access token）。
//
// ⚡ 速度（2026-11-28，目標登入加載 3 秒內）：
//   · 不 import supabase-js / _shared/deps.ts（後者連 Anthropic SDK 一起打包），只用 fetch 打 REST，冷啟動快很多
//   · GET 只回 204：前端按「用 LINE 登入」時先打一下把函式叫醒（使用者在 LINE 授權頁的那幾秒剛好熱好），
//     不是排程保溫，一次登入多一個請求、不碰資料庫
//   · 網頁登入接受 text/plain（簡單請求不必 CORS 預檢，少一趟往返）
//
// 規則（docs/SECURITY.md）：不 log 任何 token、名字；錯誤只回固定代碼。
// 部署：supabase functions deploy auth-line --no-verify-jwt（登入前還沒有 JWT）
// 需要的 secrets：LINE_LOGIN_CHANNEL_ID、LINE_LOGIN_CHANNEL_SECRET、APP_ALLOWED_ORIGINS（逗號分隔）
// ============================================================

import { accessTokenIsOurs, lineLoginEmail, parseAuthLineRequest, verifyIdTokenLocally, type AuthLineRequest } from "./logic.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const CHANNEL_ID = Deno.env.get('LINE_LOGIN_CHANNEL_ID') || ''
const CHANNEL_SECRET = Deno.env.get('LINE_LOGIN_CHANNEL_SECRET') || ''
const ALLOWED_ORIGINS = (Deno.env.get('APP_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || ''
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-region',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    // 預檢結果快取 10 分鐘（連結 LINE 那條路還是要預檢）
    'Access-Control-Max-Age': '600',
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

// ── Supabase REST（service role）────────────────────────────────

const serviceHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
})

/** PostgREST（app schema） */
async function rest(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<Response> {
  const method = init.method ?? 'GET'
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: serviceHeaders({
      [method === 'GET' ? 'Accept-Profile' : 'Content-Profile']: 'app',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    }),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

/** GoTrue admin API */
async function authAdmin(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: serviceHeaders(),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

async function readJson<T>(res: Response): Promise<T | null> {
  try { return await res.json() as T } catch { return null }
}

async function userEmail(userId: string): Promise<string | null> {
  const res = await authAdmin(`admin/users/${encodeURIComponent(userId)}`)
  if (!res.ok) { await res.body?.cancel(); return null }
  const u = await readJson<{ email?: string }>(res)
  return u?.email || null
}

// ── LINE ─────────────────────────────────────────────────────────

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
  if (!res.ok) {
    // 只記 LINE 回的錯誤代碼（不含 code、token），查登入失敗用
    const err = await readJson<{ error?: string; error_description?: string }>(res) ?? {}
    console.error('[AUTH_LINE] token exchange failed', res.status, err.error ?? '', err.error_description ?? '', redirectUri)
    return null
  }
  const data = await readJson<{ id_token?: unknown }>(res)
  return typeof data?.id_token === 'string' ? data.id_token : null
}

/** 交給 LINE 驗 ID token：簽章、發給誰（client_id）、過期、nonce 都由 LINE 檢查 */
async function verifyIdTokenRemote(idToken: string, nonce?: string): Promise<LineProfile | null> {
  const params = new URLSearchParams({ id_token: idToken, client_id: CHANNEL_ID })
  if (nonce) params.set('nonce', nonce)
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  if (!res.ok) {
    const err = await readJson<{ error?: string; error_description?: string }>(res) ?? {}
    console.error('[AUTH_LINE] id token verify failed', res.status, err.error ?? '', err.error_description ?? '')
    return null
  }
  const data = await readJson<{ sub?: unknown; name?: unknown }>(res)
  if (typeof data?.sub !== 'string' || !data.sub) return null
  return { sub: data.sub, name: typeof data.name === 'string' ? data.name : undefined }
}

async function profileFromCode(code: string, redirectUri: string, nonce: string): Promise<LineProfile | null> {
  const idToken = await exchangeCode(code, redirectUri)
  if (!idToken) return null
  const local = await verifyIdTokenLocally(idToken, CHANNEL_ID, CHANNEL_SECRET, nonce)
  if (local.status === 'ok' && local.sub) return { sub: local.sub, name: local.name }
  return await verifyIdTokenRemote(idToken, nonce)
}

/** LIFF：驗 access token 是發給我們這個 channel 的，再查 profile 拿 userId（兩個請求同時送，profile 只有在驗過時才採用） */
async function verifyAccessToken(accessToken: string): Promise<LineProfile | null> {
  const [verify, profile] = await Promise.all([
    fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`),
    fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } }),
  ])
  const verified = verify.ok ? await readJson<unknown>(verify) : null
  if (!verify.ok || !accessTokenIsOurs(verified, CHANNEL_ID)) {
    await profile.body?.cancel()
    console.error('[AUTH_LINE] access token rejected', verify.status, String((verified as { client_id?: unknown } | null)?.client_id ?? ''))
    return null
  }
  if (!profile.ok) { await profile.body?.cancel(); return null }
  const data = await readJson<{ userId?: unknown; displayName?: unknown }>(profile)
  if (typeof data?.userId !== 'string' || !data.userId) return null
  return { sub: data.userId, name: typeof data.displayName === 'string' ? data.displayName : undefined }
}

// ── 使用者 ───────────────────────────────────────────────────────

/** 找出這個 LINE 帳號對應的使用者；第一次登入就建一個 */
async function findOrCreateUser(profile: LineProfile): Promise<{ userId: string; email: string } | null> {
  const fallbackEmail = lineLoginEmail(profile.sub)
  // 一趟：更新登入時間＋名字，順便拿 user id 與 email（Google 建的帳號後來連上 LINE 時是它自己的 email）
  const lookup = await rest('rpc/line_login_lookup', {
    method: 'POST', body: { p_line_user_id: profile.sub, p_display_name: profile.name ?? null },
  })
  if (!lookup.ok) {
    console.error('[AUTH_LINE] lookup failed', lookup.status)
    await lookup.body?.cancel()
    return null
  }
  const found = await readJson<{ user_id?: string; email?: string | null } | null>(lookup)
  if (found?.user_id) return { userId: found.user_id, email: found.email || fallbackEmail }

  let userId: string | null = null
  const created = await authAdmin('admin/users', {
    method: 'POST',
    body: { email: fallbackEmail, email_confirm: true, user_metadata: { provider: 'line', name: profile.name ?? null } },
  })
  if (created.ok) {
    const u = await readJson<{ id?: string; user?: { id?: string } }>(created)
    userId = u?.id ?? u?.user?.id ?? null
  } else {
    await created.body?.cancel()
    // 已經有這個 email 的使用者（上次建好使用者但對應表沒寫進去、或兩個請求同時建立）：
    // generate_link 會回傳那個使用者，接著補寫對應表，不要讓這個 LINE 帳號永遠登入不了
    const link = await authAdmin('admin/generate_link', { method: 'POST', body: { type: 'magiclink', email: fallbackEmail } })
    if (link.ok) {
      // GoTrue 回的是使用者本身（id 在最上層）加上 action_link／hashed_token 等欄位
      const body = await readJson<{ id?: string; user?: { id?: string } }>(link)
      userId = body?.id ?? body?.user?.id ?? null
    } else {
      await link.body?.cancel()
    }
  }
  if (!userId) return null

  // 已存在就不動（同時建立的另一個請求寫進去了），由上面的 email 對到同一個使用者
  const ins = await rest('line_identities?on_conflict=line_user_id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: { line_user_id: profile.sub, user_id: userId, display_name: profile.name ?? null },
  })
  await ins.body?.cancel()
  if (!ins.ok) return null

  // 再讀一次，以資料庫為準（另一個請求可能先把這個 LINE 對到別的使用者）
  const again = await rest(`line_identities?select=user_id&line_user_id=eq.${encodeURIComponent(profile.sub)}`)
  const rows = again.ok ? await readJson<{ user_id: string }[]>(again) : null
  const rowUser = rows?.[0]?.user_id
  if (!rowUser) return null
  if (rowUser !== userId) return { userId: rowUser, email: (await userEmail(rowUser)) || fallbackEmail }
  return { userId, email: fallbackEmail }
}

/** 已登入的人把 LINE 連到自己的帳號 */
async function linkToCurrentUser(req: Request, profile: LineProfile): Promise<{ ok: boolean; error?: string }> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return { ok: false, error: 'not_signed_in' }
  const me = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` } })
  const user = me.ok ? await readJson<{ id?: string }>(me) : (await me.body?.cancel(), null)
  if (!user?.id) return { ok: false, error: 'not_signed_in' }
  const existingRes = await rest(`line_identities?select=user_id&line_user_id=eq.${encodeURIComponent(profile.sub)}`)
  if (!existingRes.ok) { await existingRes.body?.cancel(); return { ok: false, error: 'link_failed' } }
  const existing = (await readJson<{ user_id: string }[]>(existingRes))?.[0]
  if (existing && existing.user_id !== user.id) return { ok: false, error: 'line_already_linked' }
  if (!existing) {
    const ins = await rest('line_identities', {
      method: 'POST', prefer: 'return=minimal',
      body: { line_user_id: profile.sub, user_id: user.id, display_name: profile.name ?? null },
    })
    await ins.body?.cancel()
    if (!ins.ok) return { ok: false, error: 'link_failed' }
  }
  return { ok: true }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) })
  // 叫醒用（前端按「用 LINE 登入」時打一下），什麼都不做
  if (req.method === 'GET') return new Response(null, { status: 204, headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405)
  if (!CHANNEL_ID || !CHANNEL_SECRET) {
    console.error('[AUTH_LINE] LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET not set')
    return json(req, { error: 'not_configured' }, 500)
  }

  let body: AuthLineRequest
  try {
    // 網頁登入送 text/plain（免預檢），一樣是 JSON 字串
    const parsed = parseAuthLineRequest(JSON.parse(await req.text()))
    if (!parsed) return json(req, { error: 'invalid_request' }, 400)
    body = parsed
  } catch {
    return json(req, { error: 'invalid_json' }, 400)
  }

  const t0 = Date.now()
  let profile: LineProfile | null = null
  if (body.accessToken) {
    profile = await verifyAccessToken(body.accessToken)
  } else if (body.code && body.redirectUri && body.nonce) {
    profile = await profileFromCode(body.code, body.redirectUri, body.nonce)
  }
  if (!profile) return json(req, { error: 'line_rejected' }, 401)
  const tLine = Date.now()

  if (body.action === 'link') {
    const r = await linkToCurrentUser(req, profile)
    return r.ok ? json(req, { ok: true }) : json(req, { error: r.error }, r.error === 'not_signed_in' ? 401 : 409)
  }

  const user = await findOrCreateUser(profile)
  if (!user) return json(req, { error: 'retry' }, 503)
  const tUser = Date.now()

  const linkRes = await authAdmin('admin/generate_link', { method: 'POST', body: { type: 'magiclink', email: user.email } })
  const link = linkRes.ok ? await readJson<{ hashed_token?: string; properties?: { hashed_token?: string } }>(linkRes) : null
  if (!linkRes.ok) await linkRes.body?.cancel()
  const tokenHash = link?.hashed_token ?? link?.properties?.hashed_token
  if (!tokenHash) {
    console.error('[AUTH_LINE] generateLink failed', linkRes.status)
    return json(req, { error: 'retry' }, 503)
  }
  // 只記各段耗時（毫秒），查登入慢在哪一段用
  console.log(`[AUTH_LINE] signed in line=${tLine - t0} user=${tUser - tLine} link=${Date.now() - tUser}`)
  return json(req, { tokenHash, displayName: profile.name ?? null })
})
