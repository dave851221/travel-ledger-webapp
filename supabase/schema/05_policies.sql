-- ============================================================
-- 05_policies — Row Level Security
--
-- ⚠️ 目前所有政策皆為完全開放（FOR ALL USING (true)）。
--    本專案沒有使用 Supabase Auth，旅程通行碼只是前端的門面，
--    任何持有 anon key 且知道 trip UUID 的人都能讀寫全部資料。
--    僅適合高度信任的親友圈使用。收斂計畫見 docs/ROADMAP.md。
--    政策集中在這個檔案，未來要收緊時只需改這裡。
-- ============================================================

ALTER TABLE public.trips                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_trip_id_mapping   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_user_states       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_chat_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_processed_actions ENABLE ROW LEVEL SECURITY;

-- 政策名稱與既有資料庫保持一致，重複執行不會產生重複政策
DROP POLICY IF EXISTS "Allow public read/write on trips"    ON public.trips;
CREATE POLICY "Allow public read/write on trips"            ON public.trips
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public read/write on expenses" ON public.expenses;
CREATE POLICY "Allow public read/write on expenses"         ON public.expenses
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public all on mapping"         ON public.line_trip_id_mapping;
CREATE POLICY "Allow public all on mapping"                 ON public.line_trip_id_mapping
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public all on user_states"     ON public.line_user_states;
CREATE POLICY "Allow public all on user_states"             ON public.line_user_states
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public all on chat_history"    ON public.line_chat_history;
CREATE POLICY "Allow public all on chat_history"            ON public.line_chat_history
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all on processed_actions"      ON public.line_processed_actions;
CREATE POLICY "Allow all on processed_actions"              ON public.line_processed_actions
    FOR ALL USING (true) WITH CHECK (true);
