-- ============================================================
-- 07_storage — 收據照片儲存空間
--
-- bucket：travel-images（public）
-- 路徑慣例：expenses/{tripId}/{檔名}
--   前端上傳見 ExpenseModal，LINE Bot 上傳見 line-webhook。
--   supabase/scripts/delete_trip.sql 依賴這個前綴來清理照片，勿隨意更動。
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('travel-images', 'travel-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 與資料表一致的開放政策（見 05_policies 的安全性說明）
DROP POLICY IF EXISTS "Public read on travel-images"   ON storage.objects;
CREATE POLICY "Public read on travel-images"           ON storage.objects
    FOR SELECT USING (bucket_id = 'travel-images');

DROP POLICY IF EXISTS "Public insert on travel-images" ON storage.objects;
CREATE POLICY "Public insert on travel-images"         ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'travel-images');

DROP POLICY IF EXISTS "Public update on travel-images" ON storage.objects;
CREATE POLICY "Public update on travel-images"         ON storage.objects
    FOR UPDATE USING (bucket_id = 'travel-images');

DROP POLICY IF EXISTS "Public delete on travel-images" ON storage.objects;
CREATE POLICY "Public delete on travel-images"         ON storage.objects
    FOR DELETE USING (bucket_id = 'travel-images');
