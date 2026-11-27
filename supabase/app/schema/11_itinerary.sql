-- ============================================================
-- app/11_itinerary — 用 Google 試算表排的行程（David 2026-11-27）
--
-- 旅程設定貼上試算表連結，只存試算表的 id（itinerary_sheet）。
-- 試算表要「知道連結的人都能檢視」；讀取在 Edge Function tlb-itinerary（成員才讀得到）
-- 與旅行喵喵（_shared/assistant/itinerary.ts），解析在 _shared/sheetItinerary.ts。
-- 成員可以看、可以改（跟其他一般設定一樣，trips_update 的 RLS 決定誰能改）。
-- ============================================================

ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS itinerary_sheet TEXT;
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_itinerary_sheet_check;
ALTER TABLE app.trips ADD CONSTRAINT trips_itinerary_sheet_check
    CHECK (itinerary_sheet IS NULL OR itinerary_sheet ~ '^[A-Za-z0-9_-]{20,100}$');

GRANT SELECT (itinerary_sheet) ON app.trips TO authenticated;
GRANT UPDATE (itinerary_sheet) ON app.trips TO authenticated;

NOTIFY pgrst, 'reload schema';
