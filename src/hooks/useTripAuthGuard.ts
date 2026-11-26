import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { IS_PUBLIC } from '../config/mode';
import { rememberReturnTo, useSession } from '../features/auth/session';

/**
 * 進 Dashboard 之前的關卡。
 *
 * 舊版：TripPortal 驗證成功後會寫入 `auth_{tripId}`，這裡只檢查那個旗標；
 * 沒有就把使用者送回通行碼頁面。
 * ⚠️ 這純粹是 UI 層的動線，**不是安全機制** ——
 *    舊版資料庫的 RLS 完全開放，任何人手動塞一個 localStorage 旗標就能通過。
 *    詳見 docs/ROADMAP.md 的已知風險。
 *
 * 開放版：要登入。沒登入就記住這一頁、送回首頁登入，登入後自動回來。
 * 登入之後能不能看到這趟由 RLS 決定（不是成員就查不到，useTripData 會導回首頁）。
 */
export const useTripAuthGuard = (id: string | undefined): boolean => {
  const navigate = useNavigate();
  const { session, loading } = useSession();

  // 直接在 render 期間判讀。用 state + effect 會多一次 render，
  // 期間 Dashboard 會以「未通過」的狀態閃一下。
  const authed = IS_PUBLIC
    ? !!session
    : (id ? !!localStorage.getItem(`auth_${id}`) : false);

  useEffect(() => {
    if (!id || authed) return;
    if (IS_PUBLIC) {
      if (loading) return;
      rememberReturnTo(`/trip/${id}/dashboard`);
      navigate('/');
      return;
    }
    navigate(`/trip/${id}`);
  }, [id, authed, loading, navigate]);

  return authed;
};
