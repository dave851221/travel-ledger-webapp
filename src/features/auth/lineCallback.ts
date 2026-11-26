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
  nonce: string;
  redirectUri: string;
}

export interface LinePending {
  code: string;
  nonce: string;
  redirectUri: string;
}

function capture(): void {
  if (import.meta.env.VITE_APP_MODE !== 'public') return;
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return;

  let saved: LineOAuthState | null = null;
  try { saved = JSON.parse(sessionStorage.getItem(LINE_STATE_KEY) || 'null'); } catch { saved = null; }
  if (!saved || saved.state !== state) return;

  sessionStorage.removeItem(LINE_STATE_KEY);
  const pending: LinePending = { code, nonce: saved.nonce, redirectUri: saved.redirectUri };
  sessionStorage.setItem(LINE_PENDING_KEY, JSON.stringify(pending));

  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('friendship_status_changed');
  window.history.replaceState(window.history.state, '', url.toString());
}

try { capture(); } catch { /* sessionStorage 不能用：當作沒登入 */ }
