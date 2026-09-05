-- ============================================================
-- 垃圾桶保留期改由資料庫時鐘判斷（ROADMAP 已知風險 2）
--
-- 以前前端是把 `deleted_at` 撈回瀏覽器，再用 `new Date()` 相減判斷
-- 有沒有超過 24 小時。裝置時間不準的話，會提早把還能還原的紀錄永久刪除，
-- 或是永遠清不掉過期的紀錄。
--
-- 改法有兩半：
--   1. 兩支 RPC 在伺服器端用 now() 切出「保留期內」與「已過期」兩份清單。
--   2. 一個 BEFORE UPDATE trigger 把軟刪除的時間戳蓋成資料庫時間 ——
--      寫入端有三個（網頁 useTrash、LINE Edge Function、LIFF），
--      不統一時間來源的話上面的判斷還是會歪。
--      還原（deleted_at 寫回 NULL）不受影響。
-- ============================================================

-- 保留期內的垃圾桶內容（供畫面顯示）
DROP FUNCTION IF EXISTS public.list_trip_trash(UUID);

CREATE FUNCTION public.list_trip_trash(p_trip_id UUID)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT *
    FROM public.expenses
    WHERE trip_id = p_trip_id
      AND deleted_at IS NOT NULL
      AND deleted_at > now() - interval '24 hours'
    ORDER BY deleted_at DESC;
$$;

-- 已過保留期的垃圾桶內容（供前端永久刪除；photo_urls 是為了先清 Storage）
DROP FUNCTION IF EXISTS public.list_expired_trash(UUID);

CREATE FUNCTION public.list_expired_trash(p_trip_id UUID)
RETURNS TABLE(id UUID, photo_urls TEXT[])
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT e.id, e.photo_urls
    FROM public.expenses e
    WHERE e.trip_id = p_trip_id
      AND e.deleted_at IS NOT NULL
      AND e.deleted_at <= now() - interval '24 hours';
$$;

GRANT EXECUTE ON FUNCTION public.list_trip_trash(UUID)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_expired_trash(UUID) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.stamp_deleted_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        NEW.deleted_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_expenses_stamp_deleted_at ON public.expenses;

CREATE TRIGGER tr_expenses_stamp_deleted_at
BEFORE UPDATE OF deleted_at ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.stamp_deleted_at();

-- 通知 PostgREST 重新載入 schema，讓新的 RPC 立即可用
NOTIFY pgrst, 'reload schema';
