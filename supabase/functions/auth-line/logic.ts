// auth-line 的純函式（vitest 會測這一份，見 logic.test.ts）

export interface AuthLineRequest {
  /** signin：登入或註冊；link：把 LINE 連到目前登入的帳號 */
  action: 'signin' | 'link'
  /**
   * LIFF 裡的 access token（liff.getAccessToken()）。伺服器拿它向 LINE 確認是發給我們這個 channel、
   * 還沒過期，再用它查 profile 拿 userId。
   * 刻意不收前端送來的 ID token：ID token 在有效期內可以被重放，又沒辦法要求 LIFF 帶我們指定的 nonce。
   */
  accessToken?: string
  /** 網頁 OAuth 回來的 code，要搭配當初送出的 redirectUri；ID token 由伺服器自己換，不經過前端 */
  code?: string
  redirectUri?: string
  /** 送去 LINE 授權時帶的 nonce，驗伺服器換回來的 ID token 時要對得上 */
  nonce?: string
}

const MAX_LEN = 4096

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_LEN ? v : undefined

/** 收斂前端送來的內容；不合法回 null */
export function parseAuthLineRequest(raw: unknown): AuthLineRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const action = r.action === 'link' ? 'link' : r.action === 'signin' || r.action === undefined ? 'signin' : null
  if (!action) return null
  const accessToken = str(r.accessToken)
  const code = str(r.code)
  const redirectUri = str(r.redirectUri)
  const nonce = str(r.nonce)
  if (!accessToken && !(code && redirectUri)) return null
  if (redirectUri && !/^https?:\/\//.test(redirectUri)) return null
  // 網頁登入一定要有 nonce（防止別處拿到的 code 被拿來換）
  if (code && !nonce) return null
  return { action, accessToken, code, redirectUri, nonce }
}

/** LINE 的 access token 驗證結果：一定要是發給我們這個 channel 的、還沒過期 */
export function accessTokenIsOurs(verify: unknown, channelId: string): boolean {
  if (!verify || typeof verify !== 'object') return false
  const v = verify as Record<string, unknown>
  return String(v.client_id ?? '') === channelId && Number(v.expires_in ?? 0) > 0
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

export interface LocalIdTokenResult {
  /** ok：簽章與內容都對；other：不是 HS256、格式看不懂，交給 LINE 的 verify API 判斷 */
  status: 'ok' | 'other'
  sub?: string
  name?: string
}

/**
 * 在函式裡自己驗 LINE 網頁登入的 ID token，省掉一趟 LINE verify API（登入加速，2026-11-28）。
 * 這個 token 是伺服器剛剛用 channel secret 從 LINE token endpoint 直接換回來的（不經過瀏覽器），
 * LINE 網頁登入的 ID token 用 channel secret 做 HS256 簽章，這裡照樣驗簽章、iss、aud、exp、nonce。
 * 任何一項對不上或不是 HS256 都回 other，由呼叫端退回 LINE 的 verify API（結果以 LINE 為準）。
 */
export async function verifyIdTokenLocally(
  idToken: string, channelId: string, channelSecret: string, nonce: string, nowSec = Math.floor(Date.now() / 1000),
): Promise<LocalIdTokenResult> {
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) return { status: 'other' }
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])))
    if (header?.alg !== 'HS256' || !channelSecret) return { status: 'other' }
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    )
    const sigOk = await crypto.subtle.verify(
      'HMAC', key, base64UrlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
    if (!sigOk) return { status: 'other' }
    const p = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]))) as Record<string, unknown>
    const aud = Array.isArray(p.aud) ? p.aud.map(String) : [String(p.aud ?? '')]
    if (p.iss !== 'https://access.line.me') return { status: 'other' }
    if (!aud.includes(channelId)) return { status: 'other' }
    if (typeof p.exp !== 'number' || p.exp <= nowSec) return { status: 'other' }
    if (p.nonce !== nonce) return { status: 'other' }
    if (typeof p.sub !== 'string' || !p.sub) return { status: 'other' }
    return { status: 'ok', sub: p.sub, name: typeof p.name === 'string' ? p.name : undefined }
  } catch {
    return { status: 'other' }
  }
}

/**
 * LINE 帳號在 Supabase Auth 裡的 email。LINE 不一定給 email，但 Supabase 的一次性登入需要一個，
 * 所以用 userId 組一個不會真的寄得出去的地址（.invalid 是保留網域）。
 * 這個地址不會顯示給任何人，也不會寄信。
 */
export function lineLoginEmail(lineUserId: string): string {
  return `line-${lineUserId.toLowerCase().replace(/[^a-z0-9]/g, '')}@line.users.invalid`
}
