-- ============================================================
-- 04_triggers — 觸發器
-- ============================================================

DROP TRIGGER IF EXISTS tr_generate_line_mapping ON public.trips;

CREATE TRIGGER tr_generate_line_mapping
AFTER INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.trigger_generate_line_mapping();

-- 為既有旅程補上短碼（全新資料庫時這段不會有任何動作）
INSERT INTO public.line_trip_id_mapping (trip_id, linebot_id)
SELECT id, public.generate_linebot_id() FROM public.trips
ON CONFLICT (trip_id) DO NOTHING;

-- 軟刪除時把 deleted_at 蓋成資料庫時間，讓垃圾桶的 24 小時保留期
-- 不受各寫入端（網頁、Edge Function、LIFF）的時鐘影響
DROP TRIGGER IF EXISTS tr_expenses_stamp_deleted_at ON public.expenses;

CREATE TRIGGER tr_expenses_stamp_deleted_at
BEFORE UPDATE OF deleted_at ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.stamp_deleted_at();
