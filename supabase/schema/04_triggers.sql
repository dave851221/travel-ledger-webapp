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
