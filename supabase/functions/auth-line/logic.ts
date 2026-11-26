// auth-line 的純函式（vitest 會測這一份，見 logic.test.ts）

export interface AuthLineRequest {
  /** signin：登入或註冊；link：把 LINE 連到目前登入的帳號 */
  action: 'signin' | 'link'
  /** LIFF 裡直接拿到的 ID token */
  idToken?: string
  /** 網頁 OAuth 回來的 code，要搭配當初送出的 redirectUri */
  code?: string
  redirectUri?: string
  /** 送去 LINE 授權時帶的 nonce，驗 ID token 時要對得上（防重放） */
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
  const idToken = str(r.idToken)
  const code = str(r.code)
  const redirectUri = str(r.redirectUri)
  const nonce = str(r.nonce)
  if (!idToken && !(code && redirectUri)) return null
  if (redirectUri && !/^https?:\/\//.test(redirectUri)) return null
  return { action, idToken, code, redirectUri, nonce }
}

/**
 * LINE 帳號在 Supabase Auth 裡的 email。LINE 不一定給 email，但 Supabase 的一次性登入需要一個，
 * 所以用 userId 組一個不會真的寄得出去的地址（.invalid 是保留網域）。
 * 這個地址不會顯示給任何人，也不會寄信。
 */
export function lineLoginEmail(lineUserId: string): string {
  return `line-${lineUserId.toLowerCase().replace(/[^a-z0-9]/g, '')}@line.users.invalid`
}
