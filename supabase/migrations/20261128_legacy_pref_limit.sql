-- 舊版 trips.ai_preference 上限 1000 字（見 supabase/schema/01_tables_core.sql）
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_ai_preference_length;
ALTER TABLE public.trips ADD CONSTRAINT trips_ai_preference_length CHECK (ai_preference IS NULL OR char_length(ai_preference) <= 1000);
