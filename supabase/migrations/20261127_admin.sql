-- 開發者後台（開放版 app schema）。內容與 supabase/app/schema/09_admin.sql 相同，
-- 另外：trips.ai_suspended（暫停某趟的 AI）與 05_quota.sql 裡更新過的 app.consume_ai。

ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS ai_suspended BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION app.consume_ai(p_trip_id UUID, p_actor TEXT, p_kind TEXT DEFAULT 'text')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_max   INTEGER;
    v_used  INTEGER;
BEGIN
    IF p_actor IS NULL OR p_actor !~ '^(user|line):[A-Za-z0-9-]{1,64}$' THEN
        RAISE EXCEPTION 'invalid_actor' USING ERRCODE = '22023';
    END IF;
    IF NOT coalesce((SELECT ai_enabled FROM app.quota_settings WHERE id), FALSE) THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'ai_disabled');
    END IF;

    -- 同一趟排隊扣，避免兩則訊息同時擠過上限
    PERFORM 1 FROM app.trips WHERE id = p_trip_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_trip');
    END IF;
    -- 開發者後台暫停了這趟的 AI（09_admin.sql）
    IF (SELECT ai_suspended FROM app.trips WHERE id = p_trip_id) THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'suspended');
    END IF;


    SELECT max_ai_calls INTO v_max FROM app.trip_limits(p_trip_id);
    SELECT count(*)::int INTO v_used FROM app.ai_calls WHERE trip_id = p_trip_id;
    IF v_used >= v_max THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'trip_limit', 'limit', v_max);
    END IF;

    INSERT INTO app.ai_calls (trip_id, actor, kind)
    VALUES (p_trip_id, p_actor, CASE WHEN p_kind IN ('text', 'receipt', 'voice', 'search') THEN p_kind ELSE 'other' END);
    RETURN jsonb_build_object('ok', TRUE, 'remaining', v_max - v_used - 1, 'limit', v_max);
END;
$$;
REVOKE ALL ON FUNCTION app.consume_ai(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.consume_ai(UUID, TEXT, TEXT) TO service_role;

CREATE TABLE IF NOT EXISTS app.site_admins (
    user_id    UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app.site_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.site_admins FROM anon, authenticated;
GRANT ALL ON app.site_admins TO service_role;

-- 後台的操作紀錄（誰在什麼時候改了什麼），只有 service role 讀得到
CREATE TABLE IF NOT EXISTS app.admin_log (
    id       BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    admin_id UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    action   TEXT        NOT NULL,
    detail   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app.admin_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.admin_log FROM anon, authenticated;
GRANT ALL ON app.admin_log TO service_role;

CREATE OR REPLACE FUNCTION app.is_site_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM app.site_admins WHERE user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION app.is_site_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.is_site_admin() TO authenticated;

CREATE OR REPLACE FUNCTION app.require_site_admin()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT app.is_site_admin() THEN
        RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.require_site_admin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app.admin_note(p_action TEXT, p_detail JSONB)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    INSERT INTO app.admin_log (admin_id, action, detail) VALUES (auth.uid(), p_action, p_detail);
$$;
REVOKE ALL ON FUNCTION app.admin_note(TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- ── 總覽 ───────────────────────────────────────────────────────
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
        'ai_by_day', coalesce((
            SELECT jsonb_agg(jsonb_build_object('day', d, 'calls', n) ORDER BY d)
            FROM (SELECT (at AT TIME ZONE 'Asia/Taipei')::date AS d, count(*) AS n
                  FROM app.ai_calls WHERE at > now() - interval '14 days' GROUP BY 1) s), '[]'::jsonb),
        'photos', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'app-images'),
        'line_chats', (SELECT count(*) FROM app.line_user_states WHERE current_trip_id IS NOT NULL),
        'settings', (SELECT to_jsonb(s) - 'id' FROM app.quota_settings s WHERE id),
        'plans', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.plan) FROM app.plan_limits p)
    );
END;
$$;
REVOKE ALL ON FUNCTION app.admin_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_overview() TO authenticated;

-- ── 旅程清單（最近建立的在前；可用名稱搜尋）─────────────────────
CREATE OR REPLACE FUNCTION app.admin_trips(p_search TEXT DEFAULT NULL, p_limit INT DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.require_site_admin();
    RETURN coalesce((
        SELECT jsonb_agg(row ORDER BY (row ->> 'created_at') DESC) FROM (
            SELECT jsonb_build_object(
                'id', t.id, 'name', t.name, 'created_at', t.created_at, 'is_archived', t.is_archived,
                'plan', t.plan, 'extra_entries', t.extra_entries, 'extra_ai_calls', t.extra_ai_calls,
                'extra_photos', t.extra_photos, 'ai_suspended', t.ai_suspended,
                'members', cardinality(t.members),
                'accounts', (SELECT count(*) FROM app.trip_members tm WHERE tm.trip_id = t.id),
                'owner', (SELECT app.account_logins(tm.user_id) FROM app.trip_members tm
                          WHERE tm.trip_id = t.id AND tm.role = 'owner' LIMIT 1),
                'line_bound', EXISTS (SELECT 1 FROM app.line_user_states s WHERE s.current_trip_id = t.id),
                'last_entry', (SELECT max(e.created_at) FROM app.expenses e WHERE e.trip_id = t.id),
                'limits', (SELECT to_jsonb(l) FROM app.trip_limits(t.id) l),
                'entries', app.count_entries(t.id),
                'ai_calls', (SELECT count(*) FROM app.ai_calls a WHERE a.trip_id = t.id),
                'photos', app.count_photos(t.id)
            ) AS row
            FROM app.trips t
            WHERE p_search IS NULL OR btrim(p_search) = '' OR t.name ILIKE '%' || btrim(p_search) || '%'
                  OR t.id::text = btrim(p_search)
            ORDER BY t.created_at DESC
            LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
        ) s
    ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION app.admin_trips(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_trips(TEXT, INT) TO authenticated;

-- ── 帳號清單 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.admin_accounts(p_limit INT DEFAULT 100)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.require_site_admin();
    RETURN coalesce((
        SELECT jsonb_agg(row ORDER BY (row ->> 'created_at') DESC) FROM (
            SELECT jsonb_build_object(
                'id', u.id, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
                'logins', app.account_logins(u.id),
                'paid', EXISTS (SELECT 1 FROM app.paid_accounts p WHERE p.user_id = u.id),
                'admin', EXISTS (SELECT 1 FROM app.site_admins a WHERE a.user_id = u.id),
                'allowance', app.trip_allowance(u.id),
                'trips', (SELECT count(*) FROM app.trip_members tm WHERE tm.user_id = u.id),
                'ai_calls', (SELECT count(*) FROM app.ai_calls c WHERE c.actor = 'user:' || u.id::text)
            ) AS row
            FROM auth.users u
            ORDER BY u.created_at DESC
            LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
        ) s
    ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION app.admin_accounts(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_accounts(INT) TO authenticated;

-- ── 改一趟旅程：方案、加量、暫停 AI ────────────────────────────
CREATE OR REPLACE FUNCTION app.admin_update_trip(
    p_trip_id UUID, p_plan TEXT, p_extra_entries INT, p_extra_ai_calls INT, p_extra_photos INT, p_ai_suspended BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.require_site_admin();
    UPDATE app.trips SET
        plan = p_plan,
        extra_entries = greatest(coalesce(p_extra_entries, 0), 0),
        extra_ai_calls = greatest(coalesce(p_extra_ai_calls, 0), 0),
        extra_photos = greatest(coalesce(p_extra_photos, 0), 0),
        ai_suspended = coalesce(p_ai_suspended, FALSE)
    WHERE id = p_trip_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no_trip' USING ERRCODE = '22023';
    END IF;
    PERFORM app.admin_note('update_trip', jsonb_build_object('trip_id', p_trip_id, 'plan', p_plan,
        'extra', jsonb_build_array(p_extra_entries, p_extra_ai_calls, p_extra_photos), 'ai_suspended', p_ai_suspended));
END;
$$;
REVOKE ALL ON FUNCTION app.admin_update_trip(UUID, TEXT, INT, INT, INT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_update_trip(UUID, TEXT, INT, INT, INT, BOOLEAN) TO authenticated;

-- ── 標記帳號付過費（建立旅程不限）───────────────────────────────
CREATE OR REPLACE FUNCTION app.admin_set_paid(p_user_id UUID, p_paid BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.require_site_admin();
    IF p_paid THEN
        INSERT INTO app.paid_accounts (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
    ELSE
        DELETE FROM app.paid_accounts WHERE user_id = p_user_id;
    END IF;
    PERFORM app.admin_note('set_paid', jsonb_build_object('user_id', p_user_id, 'paid', p_paid));
END;
$$;
REVOKE ALL ON FUNCTION app.admin_set_paid(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_set_paid(UUID, BOOLEAN) TO authenticated;

-- ── 全站設定：AI 總開關、免費建立趟數 ───────────────────────────
CREATE OR REPLACE FUNCTION app.admin_update_settings(p_ai_enabled BOOLEAN, p_free_trip_creations INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.require_site_admin();
    UPDATE app.quota_settings SET
        ai_enabled = coalesce(p_ai_enabled, ai_enabled),
        free_trip_creations = greatest(coalesce(p_free_trip_creations, free_trip_creations), 0)
    WHERE id;
    PERFORM app.admin_note('update_settings', jsonb_build_object('ai_enabled', p_ai_enabled, 'free_trip_creations', p_free_trip_creations));
END;
$$;
REVOKE ALL ON FUNCTION app.admin_update_settings(BOOLEAN, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_update_settings(BOOLEAN, INT) TO authenticated;

-- ── 方案上限 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.admin_update_plan(p_plan TEXT, p_max_entries INT, p_max_ai_calls INT, p_max_photos INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.require_site_admin();
    UPDATE app.plan_limits SET
        max_entries = greatest(p_max_entries, 0),
        max_ai_calls = greatest(p_max_ai_calls, 0),
        max_photos = greatest(p_max_photos, 0)
    WHERE plan = p_plan;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no_plan' USING ERRCODE = '22023';
    END IF;
    PERFORM app.admin_note('update_plan', jsonb_build_object('plan', p_plan,
        'limits', jsonb_build_array(p_max_entries, p_max_ai_calls, p_max_photos)));
END;
$$;
REVOKE ALL ON FUNCTION app.admin_update_plan(TEXT, INT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.admin_update_plan(TEXT, INT, INT, INT) TO authenticated;

NOTIFY pgrst, 'reload schema';
