-- Add category column to trips table for grouping trips on Home page.
-- Nullable; rows without a category will be displayed under "未分類".
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS category TEXT;

CREATE INDEX IF NOT EXISTS trips_category_idx ON public.trips (category);
