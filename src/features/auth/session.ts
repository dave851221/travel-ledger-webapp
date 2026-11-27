/**
 * 開放版的登入狀態（舊版沒有登入，這裡的東西不會被用到）。
 *
 * 規則（docs/SECURITY.md）：這裡只決定「畫面要不要請他登入」，
 * 真正能看到、改到什麼一律由資料庫的 RLS 決定。
 */
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../../api/supabase';
import { clearUserStorage, globalStorageKey, IS_PUBLIC } from '../../config/mode';
import { clearSignedPhotoUrls } from '../../utils/signedPhotos';

const OWNER_KEY = globalStorageKey('cache_owner');

/**
 * 共用裝置防護：這台裝置上的快取（旅程清單、帳目、我是誰、聊天、照片簽名網址）屬於誰。
 * 登入的人換了（換帳號、登出、session 過期後別人登入）就全部清掉，下一個人看不到上一個人的帳。
 * 在 useSession 拿到登入狀態、交給畫面之前呼叫 —— Dashboard 與首頁都要等登入狀態才讀快取，所以一定清在讀之前。
 * ⚠️ 上一個人還沒上傳的離線帳也會被清掉（不能用別人的身分上傳）。
 */
export function ensureCacheOwner(userId: string | null): void {
  if (!IS_PUBLIC) return;
  try {
    const next = userId ?? '';
    if (localStorage.getItem(OWNER_KEY) === next) return;
    clearUserStorage();
    clearSignedPhotoUrls();
    localStorage.setItem(OWNER_KEY, next);
  } catch {
    // localStorage 不能用：也就沒有快取可以外洩
  }
}

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
      ensureCacheOwner(data.session?.user.id ?? null);
      if (alive) setState({ loading: false, session: data.session });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      ensureCacheOwner(session?.user.id ?? null);
      if (alive) setState({ loading: false, session });
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  return state;
}

/** 登入完成後要回到哪一頁（HashRouter 的路徑，例如 /join/xxx/yyy）。只接受站內路徑 */
// 存在 localStorage（附時間，30 分鐘過期）：手機上登入完常常回到新分頁，sessionStorage 跟不過去
const RETURN_KEY = 'tlb:auth_return_to';
const RETURN_TTL_MS = 30 * 60 * 1000;

const isSitePath = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//');

export function rememberReturnTo(path: string): void {
  if (!isSitePath(path)) return;
  try { localStorage.setItem(RETURN_KEY, JSON.stringify({ path, at: Date.now() })); } catch { /* 隱私模式：登入後回首頁 */ }
}

/** 看一下記了哪一頁但不清掉（首頁的登入按鈕用：從 Dashboard 被送回來時，登入後要回 Dashboard） */
export function peekReturnTo(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(RETURN_KEY) || 'null') as { path?: string; at?: number } | null;
    if (!v || Date.now() - (v.at ?? 0) > RETURN_TTL_MS) return null;
    return isSitePath(v.path) ? v.path : null;
  } catch {
    return null;
  }
}

export function takeReturnTo(): string | null {
  const v = peekReturnTo();
  try { localStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
  return v;
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
