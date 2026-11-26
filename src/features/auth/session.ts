/**
 * 開放版的登入狀態（舊版沒有登入，這裡的東西不會被用到）。
 *
 * 規則（docs/SECURITY.md）：這裡只決定「畫面要不要請他登入」，
 * 真正能看到、改到什麼一律由資料庫的 RLS 決定。
 */
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../../api/supabase';
import { IS_PUBLIC } from '../../config/mode';

export interface SessionState {
  /** 還在讀本機存的登入資料（第一次 render 不知道有沒有登入） */
  loading: boolean;
  session: Session | null;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ loading: IS_PUBLIC, session: null });

  useEffect(() => {
    if (!IS_PUBLIC || !supabase) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setState({ loading: false, session: data.session });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (alive) setState({ loading: false, session });
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  return state;
}

/** 登入完成後要回到哪一頁（HashRouter 的路徑，例如 /join/xxx/yyy）。只接受站內路徑 */
const RETURN_KEY = 'tlb:auth_return_to';

export function rememberReturnTo(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//')) return;
  try { sessionStorage.setItem(RETURN_KEY, path); } catch { /* 隱私模式：登入後回首頁 */ }
}

/** 看一下記了哪一頁但不清掉（首頁的登入按鈕用：從 Dashboard 被送回來時，登入後要回 Dashboard） */
export function peekReturnTo(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    return v && v.startsWith('/') && !v.startsWith('//') ? v : null;
  } catch {
    return null;
  }
}

export function takeReturnTo(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return v && v.startsWith('/') && !v.startsWith('//') ? v : null;
  } catch {
    return null;
  }
}

/** 網站的根網址（不含 # 之後），OAuth 回來的落點 */
export function siteRootUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}

export async function signInWithGoogle(returnTo: string): Promise<void> {
  rememberReturnTo(returnTo);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: siteRootUrl() },
  });
  if (error) throw error;
}

/** 本機開發專用：Email 一次性登入（信在本機 Supabase 的 Inbucket）。正式環境沒有開 Email 登入 */
export async function signInWithDevEmail(email: string, returnTo: string): Promise<void> {
  rememberReturnTo(returnTo);
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: siteRootUrl() } });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
