/**
 * 開放版的 LIFF 頁（編輯支出、記帳偏好）要先登入：資料都在 RLS 後面，只有旅程成員讀得到。
 * 在 LINE 裡打開時用 LIFF 的 access token 直接登入（auth-line 驗過是我們 channel 的），不用跳頁。
 * 不在 LINE 裡（例如複製網址到瀏覽器）又沒登入 → 丟 'need_login'，頁面請使用者在 LINE 裡打開或先登入網站。
 */
import { supabase } from '../../api/supabase';
import { IS_PUBLIC } from '../../config/mode';
import { signInWithLiffAccessToken } from './lineLogin';

export async function ensureLiffSession(liff: LiffSDK | null): Promise<void> {
  if (!IS_PUBLIC) return;
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const token = liff?.isInClient() ? liff.getAccessToken() : null;
  if (!token) throw new Error('請在 LINE 裡打開這個頁面，或先到網站登入。');
  await signInWithLiffAccessToken(token);
}
