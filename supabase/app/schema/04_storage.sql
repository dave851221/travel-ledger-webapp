-- ============================================================
-- app/04_storage — 開放版的照片（私有 bucket）
--
-- 舊版的 travel-images 是公開的；開放版用 app-images，不公開，
-- 只有旅程成員能上傳、讀取、刪除，畫面上用簽名網址（createSignedUrl）顯示。
-- 路徑慣例同舊版：expenses/{tripId}/{檔名}，tripId 由 app.trip_id_from_path 解析。
-- 規劃中之後改放 Cloudflare R2（見規劃文件），那時這個檔案會換掉。
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('app-images', 'app-images', FALSE, 10 * 1024 * 1024,
        ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS app_images_select ON storage.objects;
CREATE POLICY app_images_select ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'app-images' AND app.is_member(app.trip_id_from_path(name)));

DROP POLICY IF EXISTS app_images_insert ON storage.objects;
CREATE POLICY app_images_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'app-images' AND app.is_member(app.trip_id_from_path(name)));

DROP POLICY IF EXISTS app_images_delete ON storage.objects;
CREATE POLICY app_images_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'app-images' AND app.is_member(app.trip_id_from_path(name)));
