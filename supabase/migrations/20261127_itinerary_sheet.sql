-- 開放版：行程可以用 Google 試算表（app.trips.itinerary_sheet），內容同 supabase/app/schema/11_itinerary.sql

ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS itinerary_sheet TEXT;
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_itinerary_sheet_check;
ALTER TABLE app.trips ADD CONSTRAINT trips_itinerary_sheet_check
    CHECK (itinerary_sheet IS NULL OR itinerary_sheet ~ '^[A-Za-z0-9_-]{20,100}$');

GRANT SELECT (itinerary_sheet) ON app.trips TO authenticated;
GRANT UPDATE (itinerary_sheet) ON app.trips TO authenticated;

NOTIFY pgrst, 'reload schema';
