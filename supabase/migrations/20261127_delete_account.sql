-- 刪除自己的帳號（開放版 app schema）。內容與 supabase/app/schema/07_account.sql 相同，
-- 另外更新 02_functions 的 app.expenses_before_write：帳號被刪時 expenses.created_by 才能變成空的。

CREATE OR REPLACE FUNCTION app.expenses_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF auth.uid() IS NOT NULL THEN
            NEW.created_by := auth.uid();
        END IF;
        NEW.created_at := now();
        IF NEW.deleted_at IS NOT NULL THEN
            NEW.deleted_at := now();
        END IF;
    ELSE
        -- 使用者改不了是誰記的；帳號被刪掉時（外鍵 ON DELETE SET NULL，以資料表擁有者身分執行）才會變成空的
        IF NOT (NEW.created_by IS NULL AND current_user NOT IN ('authenticated', 'anon')) THEN
            NEW.created_by := OLD.created_by;
        END IF;
        NEW.created_at := OLD.created_at;
        NEW.trip_id    := OLD.trip_id;   -- 帳不能被搬到別的旅程
        IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
            NEW.deleted_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS app.deleted_identity_trips (
    identity_hash TEXT        PRIMARY KEY,  -- sha256('line:<userId>' 或 'google:<sub>')
    trips_created INTEGER     NOT NULL DEFAULT 0,
    paid          BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app.deleted_identity_trips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.deleted_identity_trips FROM anon, authenticated;
GRANT ALL ON app.deleted_identity_trips TO service_role;

-- 一個帳號目前所有登入方式的雜湊
CREATE OR REPLACE FUNCTION app.identity_hashes(p_user_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(array_agg(h), '{}') FROM (
        SELECT encode(extensions.digest('line:' || li.line_user_id, 'sha256'), 'hex') AS h
        FROM app.line_identities li WHERE li.user_id = p_user_id
        UNION
        SELECT encode(extensions.digest('google:' || i.provider_id, 'sha256'), 'hex')
        FROM auth.identities i WHERE i.user_id = p_user_id AND i.provider = 'google'
    ) s;
$$;
REVOKE ALL ON FUNCTION app.identity_hashes(UUID) FROM PUBLIC, anon, authenticated;

-- 建立旅程的額度：把同一個 LINE／Google 以前刪掉的帳號建立過的趟數也算進來
CREATE OR REPLACE FUNCTION app.trip_allowance(p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH prev AS (
        SELECT coalesce(max(d.trips_created), 0) AS created, coalesce(bool_or(d.paid), FALSE) AS paid
        FROM app.deleted_identity_trips d
        WHERE d.identity_hash = ANY (app.identity_hashes(p_user_id))
    )
    SELECT jsonb_build_object(
        'paid', EXISTS (SELECT 1 FROM app.paid_accounts WHERE user_id = p_user_id) OR (SELECT paid FROM prev),
        'created', (SELECT count(*)::int FROM app.trip_creations WHERE user_id = p_user_id) + (SELECT created FROM prev),
        'limit', (SELECT free_trip_creations FROM app.quota_settings WHERE id));
$$;
REVOKE ALL ON FUNCTION app.trip_allowance(UUID) FROM PUBLIC, anon, authenticated;

-- 刪除前給使用者看：哪些旅程會整趟刪掉、哪些會交給別人
CREATE OR REPLACE FUNCTION app.account_deletion_preview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
        'delete', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.created_at)
            FROM app.trip_members me JOIN app.trips t ON t.id = me.trip_id
            WHERE me.user_id = v_uid
              AND NOT EXISTS (SELECT 1 FROM app.trip_members o WHERE o.trip_id = me.trip_id AND o.user_id <> v_uid)
        ), '[]'::jsonb),
        'leave', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'owner', me.role = 'owner') ORDER BY t.created_at)
            FROM app.trip_members me JOIN app.trips t ON t.id = me.trip_id
            WHERE me.user_id = v_uid
              AND EXISTS (SELECT 1 FROM app.trip_members o WHERE o.trip_id = me.trip_id AND o.user_id <> v_uid)
        ), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION app.account_deletion_preview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.account_deletion_preview() TO authenticated;

-- 刪除自己的帳號。p_confirm 必須是「刪除帳號」四個字（前端要使用者自己打），避免誤呼叫
CREATE OR REPLACE FUNCTION app.delete_my_account(p_confirm TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_created INTEGER;
    v_paid    BOOLEAN;
    r         RECORD;
    v_next    UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    IF p_confirm IS DISTINCT FROM '刪除帳號' THEN
        RAISE EXCEPTION 'not_confirmed' USING ERRCODE = '22023';
    END IF;

    -- 建立過幾趟、有沒有付過費：跟著登入方式留下來（只存雜湊）
    SELECT (a ->> 'created')::int, (a ->> 'paid')::boolean INTO v_created, v_paid FROM app.trip_allowance(v_uid) a;
    INSERT INTO app.deleted_identity_trips (identity_hash, trips_created, paid)
    SELECT h, v_created, v_paid FROM unnest(app.identity_hashes(v_uid)) h
    ON CONFLICT (identity_hash) DO UPDATE
        SET trips_created = GREATEST(app.deleted_identity_trips.trips_created, EXCLUDED.trips_created),
            paid = app.deleted_identity_trips.paid OR EXCLUDED.paid,
            deleted_at = now();

    FOR r IN SELECT trip_id, role FROM app.trip_members WHERE user_id = v_uid LOOP
        SELECT o.user_id INTO v_next FROM app.trip_members o
        WHERE o.trip_id = r.trip_id AND o.user_id <> v_uid
        ORDER BY (o.role = 'owner') DESC, (o.role = 'admin') DESC, o.joined_at
        LIMIT 1;
        IF v_next IS NULL THEN
            DELETE FROM app.trips WHERE id = r.trip_id;           -- 只剩自己：整趟刪掉
        ELSIF r.role = 'owner' THEN
            UPDATE app.trip_members SET role = 'owner' WHERE trip_id = r.trip_id AND user_id = v_next;
        END IF;
    END LOOP;

    -- trip_members、line_identities、profiles、auth.identities 都會跟著刪（ON DELETE CASCADE）
    DELETE FROM auth.users WHERE id = v_uid;
END;
$$;
REVOKE ALL ON FUNCTION app.delete_my_account(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.delete_my_account(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
