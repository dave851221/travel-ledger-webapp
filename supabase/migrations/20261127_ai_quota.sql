-- 用量上限與 AI 防濫用（開放版 app schema）：方案上限表、trips 方案欄位、AI 呼叫紀錄、全站開關、
-- 記帳筆數 trigger、照片上傳政策、consume_ai／trip_usage。內容與 supabase/app/schema/05_quota.sql 相同。
-- 只新增；既有旅程全部是 free（80 筆／30 次 AI／30 張照片）。舊版 public 不受影響。

-- ── 方案與上限 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.plan_limits (
    plan         TEXT    PRIMARY KEY,
    max_entries  INTEGER NOT NULL CHECK (max_entries >= 0),
    max_ai_calls INTEGER NOT NULL CHECK (max_ai_calls >= 0),
    max_photos   INTEGER NOT NULL CHECK (max_photos >= 0)
);

INSERT INTO app.plan_limits (plan, max_entries, max_ai_calls, max_photos) VALUES
    ('free', 80, 30, 30),
    ('paid', 600, 300, 300)
ON CONFLICT (plan) DO NOTHING;

-- 旅程的方案與加量（只有 service role 能改：付款流程或開發者手動）
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS extra_entries  INTEGER NOT NULL DEFAULT 0 CHECK (extra_entries >= 0);
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS extra_ai_calls INTEGER NOT NULL DEFAULT 0 CHECK (extra_ai_calls >= 0);
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS extra_photos   INTEGER NOT NULL DEFAULT 0 CHECK (extra_photos >= 0);
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_plan_fkey;
ALTER TABLE app.trips ADD CONSTRAINT trips_plan_fkey FOREIGN KEY (plan) REFERENCES app.plan_limits(plan);
-- 成員看得到自己旅程的方案（顯示用量），但改不了（UPDATE 的欄位清單在 01_tables 沒有這幾個）
GRANT SELECT (plan, extra_entries, extra_ai_calls, extra_photos) ON app.trips TO authenticated;

-- ── 全站的 AI 開關與每日門檻（只有一列）────────────────────────
CREATE TABLE IF NOT EXISTS app.ai_settings (
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,     -- kill switch：FALSE 時所有 AI 立刻停
    global_daily_calls INTEGER NOT NULL DEFAULT 2000,     -- 全站一天的 AI 次數上限（約 NT$150）
    user_per_minute    INTEGER NOT NULL DEFAULT 6,
    user_per_day       INTEGER NOT NULL DEFAULT 80
);
INSERT INTO app.ai_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── 每一次 AI 呼叫的紀錄 ───────────────────────────────────────
-- actor：誰叫的，'user:<uuid>'（登入帳號）或 'line:<userId>'（群組裡還沒登入過的人）。
-- 不存訊息內容。被頻率限制擋下的不寫（沒花錢），所以這張表的列數＝真的叫了 AI 的次數。
CREATE TABLE IF NOT EXISTS app.ai_calls (
    id      BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id UUID        REFERENCES app.trips(id) ON DELETE SET NULL,
    actor   TEXT        NOT NULL CHECK (char_length(actor) <= 80),
    kind    TEXT        NOT NULL CHECK (kind IN ('text', 'receipt', 'voice', 'search', 'other')),
    at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_calls_trip_idx  ON app.ai_calls (trip_id);
CREATE INDEX IF NOT EXISTS ai_calls_actor_idx ON app.ai_calls (actor, at);
CREATE INDEX IF NOT EXISTS ai_calls_at_idx    ON app.ai_calls (at);

ALTER TABLE app.plan_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_calls    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.plan_limits, app.ai_settings, app.ai_calls FROM anon, authenticated;
GRANT ALL ON app.plan_limits, app.ai_settings, app.ai_calls TO service_role;

-- ── 一趟旅程的上限（方案＋加量）──────────────────────────────
CREATE OR REPLACE FUNCTION app.trip_limits(p_trip_id UUID)
RETURNS TABLE (max_entries INTEGER, max_ai_calls INTEGER, max_photos INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pl.max_entries + t.extra_entries, pl.max_ai_calls + t.extra_ai_calls, pl.max_photos + t.extra_photos
    FROM app.trips t JOIN app.plan_limits pl ON pl.plan = t.plan
    WHERE t.id = p_trip_id;
$$;
REVOKE ALL ON FUNCTION app.trip_limits(UUID) FROM PUBLIC, anon, authenticated;

-- 算進上限的記帳：沒刪除、不是結清（結清是系統幫忙記的，不該卡住還錢）
CREATE OR REPLACE FUNCTION app.count_entries(p_trip_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT count(*)::int FROM app.expenses
    WHERE trip_id = p_trip_id AND deleted_at IS NULL AND is_settlement IS NOT TRUE;
$$;
REVOKE ALL ON FUNCTION app.count_entries(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app.count_photos(p_trip_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT count(*)::int FROM storage.objects
    WHERE bucket_id = 'app-images' AND name LIKE 'expenses/' || p_trip_id::text || '/%';
$$;
REVOKE ALL ON FUNCTION app.count_photos(UUID) FROM PUBLIC, anon, authenticated;

-- ── 記帳筆數上限：新增、或從垃圾桶救回時檢查 ─────────────────
CREATE OR REPLACE FUNCTION app.expenses_check_quota()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_max INTEGER;
BEGIN
    IF NEW.is_settlement IS TRUE OR NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND OLD.is_settlement IS NOT TRUE THEN
        RETURN NEW; -- 本來就算在裡面，只是修改內容
    END IF;
    -- 同一趟同時有好幾筆寫入時排隊算，不會一起擠過上限
    PERFORM 1 FROM app.trips WHERE id = NEW.trip_id FOR UPDATE;
    SELECT max_entries INTO v_max FROM app.trip_limits(NEW.trip_id);
    IF v_max IS NOT NULL AND app.count_entries(NEW.trip_id) >= v_max THEN
        RAISE EXCEPTION 'entry_limit' USING ERRCODE = 'P0001', DETAIL = v_max::text;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.expenses_check_quota() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_expenses_quota ON app.expenses;
CREATE TRIGGER tr_app_expenses_quota
    BEFORE INSERT OR UPDATE OF deleted_at, is_settlement ON app.expenses
    FOR EACH ROW EXECUTE FUNCTION app.expenses_check_quota();

-- ── 照片張數上限：給 storage 的上傳政策用 ──────────────────────
-- 超過時直接 RAISE（不是回 FALSE），前端才看得到 photo_limit 而不是籠統的「沒有權限」
CREATE OR REPLACE FUNCTION app.photo_quota_ok(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_max INTEGER;
BEGIN
    SELECT max_photos INTO v_max FROM app.trip_limits(p_trip_id);
    IF v_max IS NOT NULL AND app.count_photos(p_trip_id) >= v_max THEN
        RAISE EXCEPTION 'photo_limit' USING ERRCODE = 'P0001';
    END IF;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION app.photo_quota_ok(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.photo_quota_ok(UUID) TO authenticated;

DROP POLICY IF EXISTS app_images_insert ON storage.objects;
CREATE POLICY app_images_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'app-images'
                AND app.is_member(app.trip_id_from_path(name))
                AND app.photo_quota_ok(app.trip_id_from_path(name)));

-- ── AI：先扣一次，再叫 AI ──────────────────────────────────────
-- Edge Function（service role）每次要叫 AI 之前呼叫；ok=false 就不要叫，照 reason 回覆使用者：
--   ai_disabled（kill switch 或全站今天用完）、trip_limit、rate_minute、rate_day、no_trip
-- 呼叫端要先確認 actor 是這趟的成員（或是綁定這趟的 LINE 群組裡的人），這支只管次數。
CREATE OR REPLACE FUNCTION app.consume_ai(p_trip_id UUID, p_actor TEXT, p_kind TEXT DEFAULT 'text')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    s       app.ai_settings%ROWTYPE;
    v_max   INTEGER;
    v_used  INTEGER;
BEGIN
    IF p_actor IS NULL OR p_actor !~ '^(user|line):[A-Za-z0-9-]{1,64}$' THEN
        RAISE EXCEPTION 'invalid_actor' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO s FROM app.ai_settings WHERE id;
    IF NOT FOUND OR NOT s.enabled THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'ai_disabled');
    END IF;

    -- 同一趟排隊扣，避免兩則訊息同時擠過上限
    PERFORM 1 FROM app.trips WHERE id = p_trip_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_trip');
    END IF;

    IF (SELECT count(*) FROM app.ai_calls WHERE at > now() - interval '1 day') >= s.global_daily_calls THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'ai_disabled');
    END IF;
    IF (SELECT count(*) FROM app.ai_calls WHERE actor = p_actor AND at > now() - interval '1 minute') >= s.user_per_minute THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'rate_minute');
    END IF;
    IF (SELECT count(*) FROM app.ai_calls WHERE actor = p_actor AND at > now() - interval '1 day') >= s.user_per_day THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'rate_day');
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

-- ── 成員看用量（旅程設定裡顯示）───────────────────────────────
CREATE OR REPLACE FUNCTION app.trip_usage(p_trip_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    l RECORD;
BEGIN
    IF NOT app.is_member(p_trip_id) THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO l FROM app.trip_limits(p_trip_id);
    RETURN jsonb_build_object(
        'plan', (SELECT plan FROM app.trips WHERE id = p_trip_id),
        'entries',  jsonb_build_object('used', app.count_entries(p_trip_id), 'limit', l.max_entries),
        'ai_calls', jsonb_build_object('used', (SELECT count(*)::int FROM app.ai_calls WHERE trip_id = p_trip_id), 'limit', l.max_ai_calls),
        'photos',   jsonb_build_object('used', app.count_photos(p_trip_id), 'limit', l.max_photos)
    );
END;
$$;
REVOKE ALL ON FUNCTION app.trip_usage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.trip_usage(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
