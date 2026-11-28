-- ============================================================
-- app/10_photos — 開放版的照片改放 Cloudflare R2（David 2026-11-27：讓 Supabase 維持免費方案）
--
-- 檔案在 R2 的私有 bucket（tlb-photos），路徑慣例不變：expenses/{tripId}/{檔名}。
-- R2 沒辦法便宜地「數某個資料夾有幾個檔案」，所以每張照片在這裡記一列：
--   · 照片張數上限（count_photos）改數這張表
--   · 上傳、刪除都經過 Edge Function tlb-photos（要是成員），它同時維護這張表
-- 只有 service role 能碰；網頁的使用者透過 tlb-photos 拿簽名網址。
-- ============================================================

CREATE TABLE IF NOT EXISTS app.trip_photos (
    path       TEXT        PRIMARY KEY CHECK (path ~ '^expenses/[0-9a-f-]{36}/[^/]+$'),
    trip_id    UUID        NOT NULL REFERENCES app.trips(id) ON DELETE CASCADE,
    created_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_photos_trip_idx ON app.trip_photos (trip_id);
-- 檔案大小：後台看 R2 用了多少（免費 10 GB）
ALTER TABLE app.trip_photos ADD COLUMN IF NOT EXISTS bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0);
ALTER TABLE app.trip_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.trip_photos FROM anon, authenticated;
GRANT ALL ON app.trip_photos TO service_role;

-- 照片張數：這張表＋還留在 Storage app-images 的檔案（已經搬到 R2、表上有的不重複算）。
-- 正式環境搬完之後 app-images 是空的；本機沒設 R2 金鑰時照片還是放 app-images，張數一樣算得到。
-- 只算「有帳目用到的」（含垃圾桶裡的）與兩天內剛傳的（LINE 還沒按確認的草稿、正在填的表單）：
-- 傳了照片卻沒存（草稿放著不管、表單關掉）留下的孤兒照片，過兩天就不再占名額（2026-11-28 深入 review）。
CREATE OR REPLACE FUNCTION app.count_photos(p_trip_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH used AS (
        SELECT DISTINCT u.path
        FROM app.expenses e, unnest(e.photo_urls) AS u(path)
        WHERE e.trip_id = p_trip_id
    )
    SELECT (SELECT count(*) FROM app.trip_photos p
            WHERE p.trip_id = p_trip_id
              AND (p.created_at > now() - interval '2 days' OR p.path IN (SELECT path FROM used)))::int
         + (SELECT count(*) FROM storage.objects o
            WHERE o.bucket_id = 'app-images' AND o.name LIKE 'expenses/' || p_trip_id::text || '/%'
              AND NOT EXISTS (SELECT 1 FROM app.trip_photos p WHERE p.path = o.name)
              AND (o.created_at > now() - interval '2 days' OR o.name IN (SELECT path FROM used)))::int;
$$;
REVOKE ALL ON FUNCTION app.count_photos(UUID) FROM PUBLIC, anon, authenticated;

-- 網頁上傳（tlb-photos）先占一個位置再傳到 R2：同一趟同時傳好幾張時排隊算，不會一起擠過上限。
-- 超過上限丟 photo_limit；傳到 R2 失敗時 tlb-photos 會把這列刪掉。
CREATE OR REPLACE FUNCTION app.add_trip_photo(p_trip_id UUID, p_path TEXT, p_user UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_max INTEGER;
BEGIN
    PERFORM 1 FROM app.trips WHERE id = p_trip_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no_trip' USING ERRCODE = 'P0001';
    END IF;
    SELECT max_photos INTO v_max FROM app.trip_limits(p_trip_id);
    IF v_max IS NOT NULL AND app.count_photos(p_trip_id) >= v_max THEN
        RAISE EXCEPTION 'photo_limit' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO app.trip_photos (path, trip_id, created_by) VALUES (p_path, p_trip_id, p_user);
END;
$$;
REVOKE ALL ON FUNCTION app.add_trip_photo(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.add_trip_photo(UUID, TEXT, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
