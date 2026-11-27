-- ============================================================
-- 後台看照片佔多少空間：app.trip_photos.bytes（既有的從 Storage 的檔案資訊補）＋ admin_overview 的 photo_bytes
-- ============================================================

ALTER TABLE app.trip_photos ADD COLUMN IF NOT EXISTS bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0);

UPDATE app.trip_photos p SET bytes = (o.metadata->>'size')::bigint
FROM storage.objects o
WHERE o.bucket_id = 'app-images' AND o.name = p.path AND p.bytes = 0 AND o.metadata ? 'size';

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
        -- 照片佔的空間（bytes）：R2 上的＋還留在 Storage app-images、表上沒有的
        'photo_bytes', (SELECT coalesce(sum(bytes), 0) FROM app.trip_photos)
                     + (SELECT coalesce(sum((o.metadata->>'size')::bigint), 0) FROM storage.objects o
                        WHERE o.bucket_id = 'app-images' AND NOT EXISTS (SELECT 1 FROM app.trip_photos p WHERE p.path = o.name)),
        'line_chats', (SELECT count(*) FROM app.line_user_states WHERE current_trip_id IS NOT NULL),
        'settings', (SELECT to_jsonb(s) - 'id' FROM app.quota_settings s WHERE id),
        'plans', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.plan) FROM app.plan_limits p)
    );
END;
$$;
REVOKE ALL ON FUNCTION app.admin_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_overview() TO authenticated;

NOTIFY pgrst, 'reload schema';
