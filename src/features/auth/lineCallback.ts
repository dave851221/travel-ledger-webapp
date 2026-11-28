/**
 * LINE 登入（網頁版）回來時的網址處理 —— 必須在 Supabase client 建立之前執行。
 *
 * LINE 授權完會導回 `網站根網址?code=…&state=…`。Supabase 的 PKCE 登入（Google）回來時也帶 `?code=`，
 * Supabase client 一建立就會把它當成自己的 code 去換 session，換不到就報錯。
 * 所以 main.tsx 第一個 import 這支：state 對得上我們送出去的 LINE state，就把 code 收起來、從網址拿掉，
 * 之後由 completeLineSignIn() 交給 Edge Function auth-line。對不上就不動（那是 Google 的）。
 *
 * ⚠️ 這個檔案不能 import api/supabase（會讓 client 先建立）。
 */

export const LINE_STATE_KEY = 'tlb:line_oauth';
export const LINE_PENDING_KEY = 'tlb:line_pending';

export interface LineOAuthState {
  state: string;
  /** 建立時間（ms）。超過 15 分鐘的不認 */
  at: number;
  nonce: string;
  redirectUri: string;
  /** link：已登入的人把 LINE 連到目前帳號（不是登入） */
  mode?: 'signin' | 'link';
}

export interface LinePending {
  code: string;
  nonce: string;
  redirectUri: string;
  mode?: 'signin' | 'link';
}

export const AUTH_ERROR_KEY = 'tlb:auth_error';

/**
 * 登入失敗（Google 或 Supabase 回來時帶 ?error=…#error=…）：
 * `#error=…` 會被 HashRouter 當成路徑，整頁空白。記下來、把網址還原成首頁，由 AuthBootstrap 顯示訊息。
 */
function captureAuthError(url: URL): boolean {
  const hashParams = new URLSearchParams(url.hash.startsWith('#error') ? url.hash.slice(1) : '');
  const error = url.searchParams.get('error') || hashParams.get('error');
  if (!error) return false;
  // error_code 比較具體（例如 identity_already_exists：要連的 Google 已經是別的帳號）
  const code = url.searchParams.get('error_code') || hashParams.get('error_code');
  sessionStorage.setItem(AUTH_ERROR_KEY, code || error);
  ['error', 'error_code', 'error_description', 'sb'].forEach(k => url.searchParams.delete(k));
  url.hash = '#/';
  window.history.replaceState(window.history.state, '', url.toString());
  return true;
}

function capture(): void {
  if (import.meta.env.VITE_APP_MODE !== 'public') return;
  const url = new URL(window.location.href);
  if (captureAuthError(url)) return;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return;

  let saved: LineOAuthState | null = null;
  // 存在 localStorage 而不是 sessionStorage：手機上 LINE 授權完常常回到新分頁（或從 LINE App 跳回瀏覽器），
  // 新分頁看不到原本分頁的 sessionStorage，以前就因此停在登入頁（2026-11-26 David 手機實測）
  try { saved = JSON.parse(localStorage.getItem(LINE_STATE_KEY) || 'null'); } catch { saved = null; }
  if (!saved || saved.state !== state || Date.now() - (saved.at || 0) > 15 * 60 * 1000) return;

  localStorage.removeItem(LINE_STATE_KEY);
  const pending: LinePending = { code, nonce: saved.nonce, redirectUri: saved.redirectUri, mode: saved.mode };
  sessionStorage.setItem(LINE_PENDING_KEY, JSON.stringify(pending));

  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('friendship_status_changed');
  window.history.replaceState(window.history.state, '', url.toString());

  // 登入（不是連結）：現在就把 code 送去 auth-line，跟畫面的載入同時跑，不等 React 掛好（登入加速，2026-11-28）
  if (pending.mode !== 'link') {
    earlySignIn = postAuthLine({ action: 'signin', code, redirectUri: pending.redirectUri, nonce: pending.nonce })
      .catch(() => ({ error: 'network' }));
  }
}

export interface AuthLineResult { tokenHash?: string; error?: string }

/** 已經送出的登入請求（completeLineSignIn 接手），一頁只用一次 */
let earlySignIn: Promise<AuthLineResult> | null = null;

export function takeEarlySignIn(): Promise<AuthLineResult> | null {
  const p = earlySignIn;
  earlySignIn = null;
  return p;
}

/**
 * auth-line 的網址。這個檔案不能 import api/supabase，所以自己組。
 * 指定在雪梨跑（資料庫所在地）：預設會跑在離使用者最近的東京，登入要打的資料庫／Auth 每趟都要跨到雪梨，
 * 實測 2026-11-28 光那兩段就 0.9～1.8 秒；在雪梨跑只是 LINE token 那一趟變遠（約 0.3 秒）。
 * 叫醒（GET）與登入（POST）一定要打同一個區域，才會落在剛叫醒的那個實例。
 */
export function authLineUrl(): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/auth-line?forceFunctionRegion=ap-southeast-2`;
}

/**
 * 呼叫 auth-line 登入。用 text/plain、不帶自訂標頭 —— 這樣是「簡單請求」，瀏覽器不必先送 CORS 預檢，少一趟往返。
 * 登入前沒有 JWT，函式也不驗（--no-verify-jwt）。連結 LINE 要帶登入的 JWT，走 supabase.functions.invoke。
 */
export async function postAuthLine(body: Record<string, string | undefined>): Promise<AuthLineResult> {
  const res = await fetch(authLineUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as AuthLineResult;
  return res.ok ? data : { error: data.error || `http_${res.status}` };
}

try { capture(); } catch { /* sessionStorage 不能用：當作沒登入 */ }
