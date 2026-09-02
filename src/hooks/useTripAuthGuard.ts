import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 旅程通行碼的前端關卡。
 *
 * TripPortal 驗證成功後會寫入 `auth_{tripId}`，這裡只檢查那個旗標；
 * 沒有就把使用者送回通行碼頁面。
 *
 * ⚠️ 這純粹是 UI 層的動線，**不是安全機制** ——
 *    資料庫的 RLS 目前完全開放，任何人手動塞一個 localStorage 旗標就能通過。
 *    詳見 docs/ROADMAP.md 的已知風險。
 */
export const useTripAuthGuard = (id: string | undefined): boolean => {
  const navigate = useNavigate();

  // 直接在 render 期間判讀。用 state + effect 會多一次 render，
  // 期間 Dashboard 會以「未通過」的狀態閃一下。
  const authed = id ? !!localStorage.getItem(`auth_${id}`) : false;

  useEffect(() => {
    if (id && !authed) navigate(`/trip/${id}`);
  }, [id, authed, navigate]);

  return authed;
};
