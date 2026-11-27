-- 後台總覽：近 30 天 AI 次數與種類（估花費）、14 天圖表補上 0 的日子。內容與 09_admin.sql 的 app.admin_overview 相同。

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
        'photos', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'app-images'),
        'line_chats', (SELECT count(*) FROM app.line_user_states WHERE current_trip_id IS NOT NULL),
        'settings', (SELECT to_jsonb(s) - 'id' FROM app.quota_settings s WHERE id),
        'plans', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.plan) FROM app.plan_limits p)
    );
END;
$$;
REVOKE ALL ON FUNCTION app.admin_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_overview() TO authenticated;
