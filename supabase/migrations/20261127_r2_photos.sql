-- ============================================================
-- 開放版照片搬到 Cloudflare R2：app.trip_photos、count_photos、add_trip_photo、admin_overview 的照片數
-- 內容同 supabase/app/schema/10_photos.sql 與 09_admin.sql 的 admin_overview。
-- 既有照片由 scripts/migrate-photos-r2.mjs 搬（搬一張記一列、刪掉 Storage 那份）。
-- ============================================================

CREATE TABLE IF NOT EXISTS app.trip_photos (
    path       TEXT        PRIMARY KEY CHECK (path ~ '^expenses/[0-9a-f-]{36}/[^/]+$'),
    trip_id    UUID        NOT NULL REFERENCES app.trips(id) ON DELETE CASCADE,
    created_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_photos_trip_idx ON app.trip_photos (trip_id);
ALTER TABLE app.trip_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.trip_photos FROM anon, authenticated;
GRANT ALL ON app.trip_photos TO service_role;

-- 照片張數：這張表＋還留在 Storage app-images 的檔案（已經搬到 R2、表上有的不重複算）。
-- 正式環境搬完之後 app-images 是空的；本機沒設 R2 金鑰時照片還是放 app-images，張數一樣算得到。
CREATE OR REPLACE FUNCTION app.count_photos(p_trip_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT (SELECT count(*) FROM app.trip_photos WHERE trip_id = p_trip_id)::int
         + (SELECT count(*) FROM storage.objects o
            WHERE o.bucket_id = 'app-images' AND o.name LIKE 'expenses/' || p_trip_id::text || '/%'
              AND NOT EXISTS (SELECT 1 FROM app.trip_photos p WHERE p.path = o.name))::int;
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


CREATE OR REPLACE FUNCTION app.admin_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.require_site_admin();
    RETURN jsonb_build_object(
        'accounts', (SELECT count(*) FROM auth.users u
                     WHERE EXISTS (SELECT 1 FROM app.line_identities li WHERE li.user_id = u.id)
                        OR EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'google')),
        'paid_accounts', (SELECT count(*) FROM app.paid_accounts),
        'trips', (SELECT count(*) FROM app.trips),
        'paid_trips', (SELECT count(*) FROM app.trips WHERE plan = 'paid'),
        'expenses', (SELECT count(*) FROM app.expenses WHERE deleted_at IS NULL),
        'ai_today', (SELECT count(*) FROM app.ai_calls WHERE at > date_trunc('day', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei'),
        'ai_7d', (SELECT count(*) FROM app.ai_calls WHERE at > now() - interval '7 days'),
        'ai_total', (SELECT count(*) FROM app.ai_calls),
        'ai_30d', (SELECT count(*) FROM app.ai_calls WHERE at > now() - interval '30 days'),
        -- 近 30 天依種類（文字、收據…）的次數，後台估花費用
        'ai_kind_30d', coalesce((SELECT jsonb_object_agg(kind, n) FROM (
            SELECT kind, count(*) AS n FROM app.ai_calls WHERE at > now() - interval '30 days' GROUP BY 1) k), '{}'::jsonb),
        -- 最近 14 天每一天（沒有呼叫的日子也列出來，次數 0）
        'ai_by_day', (
            SELECT jsonb_agg(jsonb_build_object('day', d.day, 'calls', coalesce(c.n, 0)) ORDER BY d.day)
            FROM generate_series((now() AT TIME ZONE 'Asia/Taipei')::date - 13, (now() AT TIME ZONE 'Asia/Taipei')::date, interval '1 day') AS d(day)
            LEFT JOIN (SELECT (at AT TIME ZONE 'Asia/Taipei')::date AS day, count(*) AS n
                       FROM app.ai_calls WHERE at > now() - interval '15 days' GROUP BY 1) c ON c.day = d.day::date),
        'photos', (SELECT count(*) FROM app.trip_photos) + (SELECT count(*) FROM storage.objects o WHERE o.bucket_id = 'app-images' AND NOT EXISTS (SELECT 1 FROM app.trip_photos p WHERE p.path = o.name)),
        'line_chats', (SELECT count(*) FROM app.line_user_states WHERE current_trip_id IS NOT NULL),
        'settings', (SELECT to_jsonb(s) - 'id' FROM app.quota_settings s WHERE id),
        'plans', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.plan) FROM app.plan_limits p)
    );
END;
$$;
REVOKE ALL ON FUNCTION app.admin_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_overview() TO authenticated;

NOTIFY pgrst, 'reload schema';
