/**
 * 開放版的 LINE 登入。
 *
 * 網頁：導到 LINE 授權頁 → 回來時 lineCallback.ts 收起 code → completeLineSignIn() 交給 auth-line →
 *       拿回一次性 token_hash → supabase.auth.verifyOtp 換成正式 session。
 * LIFF：liff.getAccessToken() 直接交給 auth-line（不用跳頁），見 signInWithLiffAccessToken()。
 *
 * state 防 CSRF、nonce 防重放，存在 localStorage（手機上授權完可能回到新分頁），只用一次、15 分鐘過期。
 */
import { supabase } from '../../api/supabase';
import { rememberReturnTo, siteRootUrl } from './session';
import { LINE_PENDING_KEY, LINE_STATE_KEY, type LineOAuthState, type LinePending } from './lineCallback';

const CHANNEL_ID = import.meta.env.VITE_LINE_LOGIN_CHANNEL_ID as string | undefined;

export const lineLoginAvailable = (): boolean => !!CHANNEL_ID;

function randomString(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/** mode 'link'：已登入的人把 LINE 連到目前的帳號（回來後 completeLineSignIn 會改送 link） */
export function startLineLogin(returnTo: string, mode: 'signin' | 'link' = 'signin'): void {
  if (!CHANNEL_ID) throw new Error('line_not_configured');
  rememberReturnTo(returnTo);
  const saved: LineOAuthState = { state: randomString(), nonce: randomString(), redirectUri: siteRootUrl(), at: Date.now(), mode };
  localStorage.setItem(LINE_STATE_KEY, JSON.stringify(saved));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHANNEL_ID,
    redirect_uri: saved.redirectUri,
    state: saved.state,
    nonce: saved.nonce,
    scope: 'openid profile',
  });
  window.location.assign(`https://access.line.me/oauth2/v2.1/authorize?${params}`);
}

export function hasPendingLineSignIn(): boolean {
  try { return !!sessionStorage.getItem(LINE_PENDING_KEY); } catch { return false; }
}

/** 等著完成的是「連結 LINE」而不是登入 */
export function pendingLineIsLink(): boolean {
  try { return JSON.parse(sessionStorage.getItem(LINE_PENDING_KEY) || 'null')?.mode === 'link'; } catch { return false; }
}

/** 連結結果，給「我的帳號」顯示一次 */
export const LINE_LINK_RESULT_KEY = 'tlb:line_link_result';

async function finish(body: Record<string, string | undefined>): Promise<void> {
  const { data, error } = await supabase.functions.invoke('auth-line', { body });
  if (error || !data?.tokenHash) throw new Error((data && data.error) || 'line_signin_failed');
  const { error: otpErr } = await supabase.auth.verifyOtp({ token_hash: data.tokenHash, type: 'email' });
  if (otpErr) throw otpErr;
}

/** 網頁 LINE 登入（或連結）的後半段：回到網站後呼叫一次 */
export async function completeLineSignIn(): Promise<void> {
  let pending: LinePending | null = null;
  try { pending = JSON.parse(sessionStorage.getItem(LINE_PENDING_KEY) || 'null'); } catch { pending = null; }
  sessionStorage.removeItem(LINE_PENDING_KEY);
  if (!pending) return;
  if (pending.mode === 'link') {
    // 連結：auth-line 用目前登入的 JWT（invoke 會自動帶）認人，不換 session
    const { data, error } = await supabase.functions.invoke('auth-line', {
      body: { action: 'link', code: pending.code, redirectUri: pending.redirectUri, nonce: pending.nonce },
    });
    let code: string = data?.ok ? 'ok' : (data?.error || 'link_failed');
    if (error && 'context' in error) {
      // 409／401 的時候 data 是空的，錯誤代碼在 response body
      try { code = (await (error as { context: Response }).context.json())?.error || code; } catch { /* keep */ }
    }
    sessionStorage.setItem(LINE_LINK_RESULT_KEY, code);
    return;
  }
  await finish({ action: 'signin', code: pending.code, redirectUri: pending.redirectUri, nonce: pending.nonce });
}

/**
 * LIFF 裡：不跳頁，直接用 LINE 已經登入的身分。
 * 送 access token（liff.getAccessToken()），不送 ID token —— 伺服器向 LINE 確認是發給我們 channel 的，見 auth-line/logic.ts
 */
export async function signInWithLiffAccessToken(accessToken: string): Promise<void> {
  await finish({ action: 'signin', accessToken });
}
