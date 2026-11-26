-- 開放版：權限分級（建立者／管理員／一般成員）、成員上限 50、旅行喵喵
-- 由 supabase/app/schema/02_functions.sql 與 03_policies.sql 組成（兩者都可重複執行），前面加上角色限制的變更

ALTER TABLE app.trip_members DROP CONSTRAINT IF EXISTS trip_members_role_check;
ALTER TABLE app.trip_members ADD CONSTRAINT trip_members_role_check CHECK (role IN ('owner', 'admin', 'editor'));

-- ============================================================
-- app/02_functions — 權限判斷與 RPC
--
-- 寫法約定（每支都照這樣，新增時也一樣）：
--   · SET search_path = ''，函式裡一律寫完整的 schema 名稱，避免被同名物件劫持
--   · SECURITY DEFINER 的函式第一件事就是檢查 auth.uid() 與身分，檢查不過就 RAISE
--   · 建立後立刻 REVOKE ALL FROM PUBLIC，再只 GRANT 給需要的角色
--   · 錯誤訊息用固定的英文代碼（not_member、not_owner…），前端依代碼顯示中文
-- ============================================================

-- ── 權限判斷（給 RLS 政策用）────────────────────────────────────
-- SECURITY DEFINER：政策裡查 trip_members，如果用呼叫者身分查，
-- trip_members 自己的 RLS 又會呼叫這支，形成無限遞迴。
CREATE OR REPLACE FUNCTION app.is_member(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.trip_members
        WHERE trip_id = p_trip_id AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION app.is_owner(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.trip_members
        WHERE trip_id = p_trip_id AND user_id = auth.uid() AND role = 'owner'
    );
$$;

-- 管理員以上（owner 或 admin）
CREATE OR REPLACE FUNCTION app.is_admin(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.trip_members
        WHERE trip_id = p_trip_id AND user_id = auth.uid() AND role IN ('owner', 'admin')
    );
$$;

REVOKE ALL ON FUNCTION app.is_member(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.is_owner(UUID)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.is_admin(UUID)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.is_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION app.is_owner(UUID)  TO authenticated;
GRANT EXECUTE ON FUNCTION app.is_admin(UUID)  TO authenticated;

-- 一趟旅程最多幾位成員（成員清單的名字數）
CREATE OR REPLACE FUNCTION app.max_members()
RETURNS INT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT 50 $$;

REVOKE ALL ON FUNCTION app.max_members() FROM PUBLIC, anon, authenticated;

-- Storage 路徑 expenses/{tripId}/{檔名} → tripId；格式不對回 NULL（不要讓轉型錯誤變成 500）
CREATE OR REPLACE FUNCTION app.trip_id_from_path(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_parts TEXT[] := string_to_array(p_name, '/');
BEGIN
    IF cardinality(v_parts) <> 3 OR v_parts[1] <> 'expenses' OR v_parts[3] = '' THEN
        RETURN NULL;
    END IF;
    RETURN v_parts[2]::UUID;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app.trip_id_from_path(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.trip_id_from_path(TEXT) TO authenticated;

-- 名字的共同檢查：去頭尾空白後 1～20 字
CREATE OR REPLACE FUNCTION app.clean_name(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v TEXT := btrim(coalesce(p_name, ''));
BEGIN
    IF char_length(v) NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
    END IF;
    RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION app.clean_name(TEXT) FROM PUBLIC, anon, authenticated;

-- ── 建立旅程 ───────────────────────────────────────────────────
-- 建立者成為 owner，並以 p_my_name 的身分加入（必須是 p_members 之一）。
-- trips 沒有開 INSERT 權限，這是唯一的建立方式。
CREATE OR REPLACE FUNCTION app.create_trip(
    p_name          TEXT,
    p_members       TEXT[],
    p_my_name       TEXT,
    p_base_currency TEXT,
    p_categories    TEXT[],
    p_timezone      TEXT DEFAULT NULL,
    p_category      TEXT DEFAULT NULL,
    -- 幣別小數位數（例如 {"JPY": 0}），由前端依幣別決定；跟建立一起寫，不另外更新一次
    p_precision_config JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_members TEXT[];
    v_me      TEXT;
    v_id      UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;

    -- 去重但保留輸入順序（DISTINCT 會依字母排序，成員順序就亂了）
    SELECT array_agg(n ORDER BY first_ord) INTO v_members
    FROM (
        SELECT app.clean_name(m) AS n, min(ord) AS first_ord
        FROM unnest(p_members) WITH ORDINALITY AS u(m, ord)
        GROUP BY 1
    ) s;
    v_me := app.clean_name(p_my_name);
    IF v_members IS NULL OR NOT (v_me = ANY (v_members)) THEN
        RAISE EXCEPTION 'my_name_not_in_members' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_members) > app.max_members() THEN
        RAISE EXCEPTION 'too_many_members' USING ERRCODE = '22023';
    END IF;

    INSERT INTO app.trips (name, members, categories, base_currency, timezone, category, created_by,
                           rates, precision_config)
    VALUES (btrim(p_name), v_members, coalesce(p_categories, '{}'), upper(btrim(p_base_currency)),
            p_timezone, p_category, v_uid,
            jsonb_build_object(upper(btrim(p_base_currency)), 1),
            CASE WHEN jsonb_typeof(p_precision_config) = 'object' THEN p_precision_config ELSE '{}'::jsonb END)
    RETURNING id INTO v_id;

    INSERT INTO app.trip_members (trip_id, user_id, member_name, role)
    VALUES (v_id, v_uid, v_me, 'owner');

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB) TO authenticated;

-- ── 邀請連結 ───────────────────────────────────────────────────
-- 還沒登入也能先看邀請：回傳旅程名稱與成員清單，讓他選「我是誰」。
-- 只回傳這兩樣，帳目要等加入後（或旅程開放分享時走 get_trip_snapshot）才看得到。
CREATE OR REPLACE FUNCTION app.invite_preview(p_trip_id UUID, p_token TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object('name', t.name, 'members', to_jsonb(t.members))
    FROM app.trips t
    WHERE t.id = p_trip_id AND t.invite_token = p_token AND coalesce(p_token, '') <> '';
$$;

REVOKE ALL ON FUNCTION app.invite_preview(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invite_preview(UUID, TEXT) TO anon, authenticated;

-- 接受邀請：以 p_member_name 的身分加入。
--   名字已在成員清單 → 認領（可以跟別人認領同一個名字）
--   名字不在清單     → 以新成員加入（附加到 members）
-- 已經是成員的人再按一次，只會更新名字，不會變成兩列、也不會改掉 owner 身分。
CREATE OR REPLACE FUNCTION app.accept_invite(p_trip_id UUID, p_token TEXT, p_member_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid  UUID := auth.uid();
    v_name TEXT := app.clean_name(p_member_name);
    v_trip app.trips%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_trip FROM app.trips WHERE id = p_trip_id FOR UPDATE;
    IF NOT FOUND OR coalesce(p_token, '') = '' OR v_trip.invite_token <> p_token THEN
        RAISE EXCEPTION 'invalid_invite' USING ERRCODE = '42501';
    END IF;

    IF NOT (v_name = ANY (v_trip.members)) THEN
        IF cardinality(v_trip.members) >= app.max_members() THEN
            RAISE EXCEPTION 'too_many_members' USING ERRCODE = '22023';
        END IF;
        UPDATE app.trips SET members = array_append(members, v_name) WHERE id = p_trip_id;
    END IF;

    INSERT INTO app.trip_members (trip_id, user_id, member_name, role)
    VALUES (p_trip_id, v_uid, v_name, 'editor')
    ON CONFLICT (trip_id, user_id) DO UPDATE SET member_name = EXCLUDED.member_name;
END;
$$;

REVOKE ALL ON FUNCTION app.accept_invite(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.accept_invite(UUID, TEXT, TEXT) TO authenticated;

-- 「我是誰」：切換成這趟旅程的另一個成員（名字必須在成員清單裡）
CREATE OR REPLACE FUNCTION app.set_my_member(p_trip_id UUID, p_member_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF NOT app.is_member(p_trip_id) THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.trips WHERE id = p_trip_id AND p_member_name = ANY (members)) THEN
        RAISE EXCEPTION 'unknown_member' USING ERRCODE = '22023';
    END IF;
    UPDATE app.trip_members SET member_name = p_member_name
    WHERE trip_id = p_trip_id AND user_id = v_uid;
END;
$$;

REVOKE ALL ON FUNCTION app.set_my_member(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_my_member(UUID, TEXT) TO authenticated;

-- ── owner 專用：分享設定與連結 ─────────────────────────────────
-- p_password 只在 visibility = 'password' 時使用；傳 NULL 表示沿用舊密碼
CREATE OR REPLACE FUNCTION app.set_trip_visibility(p_trip_id UUID, p_visibility TEXT, p_password TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT app.is_admin(p_trip_id) THEN
        RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
    IF p_visibility NOT IN ('members', 'link', 'password') THEN
        RAISE EXCEPTION 'invalid_visibility' USING ERRCODE = '22023';
    END IF;
    IF p_password IS NOT NULL AND char_length(p_password) NOT BETWEEN 4 AND 64 THEN
        RAISE EXCEPTION 'invalid_password' USING ERRCODE = '22023';
    END IF;

    UPDATE app.trips
    SET visibility = p_visibility,
        view_password_hash = CASE
            WHEN p_password IS NOT NULL THEN extensions.crypt(p_password, extensions.gen_salt('bf', 10))
            ELSE view_password_hash
        END
    WHERE id = p_trip_id;
    -- 'password' 卻沒有密碼時，trips_password_needs_hash 會擋下來
END;
$$;

REVOKE ALL ON FUNCTION app.set_trip_visibility(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_trip_visibility(UUID, TEXT, TEXT) TO authenticated;

-- 重新產生連結，舊連結立刻失效。p_kind：'share' 或 'invite'
CREATE OR REPLACE FUNCTION app.rotate_trip_token(p_trip_id UUID, p_kind TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_token TEXT := app.random_token();
BEGIN
    IF NOT app.is_admin(p_trip_id) THEN
        RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
    IF p_kind = 'share' THEN
        UPDATE app.trips SET share_token = v_token WHERE id = p_trip_id;
    ELSIF p_kind = 'invite' THEN
        UPDATE app.trips SET invite_token = v_token WHERE id = p_trip_id;
    ELSE
        RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
    END IF;
    RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION app.rotate_trip_token(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.rotate_trip_token(UUID, TEXT) TO authenticated;

-- 把 owner 交給另一位成員（自己變成 editor）
CREATE OR REPLACE FUNCTION app.transfer_owner(p_trip_id UUID, p_new_owner UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT app.is_owner(p_trip_id) THEN
        RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.trip_members WHERE trip_id = p_trip_id AND user_id = p_new_owner) THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '22023';
    END IF;
    UPDATE app.trip_members SET role = 'owner'  WHERE trip_id = p_trip_id AND user_id = p_new_owner;
    UPDATE app.trip_members SET role = 'editor' WHERE trip_id = p_trip_id AND user_id = auth.uid()
                                                  AND user_id <> p_new_owner;
END;
$$;

REVOKE ALL ON FUNCTION app.transfer_owner(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.transfer_owner(UUID, UUID) TO authenticated;

-- ── 沒登入也能看：分享連結 ─────────────────────────────────────
-- 依旅程的 visibility 決定：
--   members  → 一律拒絕（成員請登入，走一般查詢）
--   link     → p_token 等於 share_token 就給
--   password → p_token 正確且密碼正確才給
-- 回傳的旅程欄位跟成員看到的一樣，但**不含** share_token、invite_token、created_by；
-- 帳目只含還沒刪除的。照片路徑照給，實際圖片要另外拿簽名網址（Edge Function）。
CREATE OR REPLACE FUNCTION app.get_trip_snapshot(p_trip_id UUID, p_token TEXT, p_password TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_trip app.trips%ROWTYPE;
BEGIN
    SELECT * INTO v_trip FROM app.trips WHERE id = p_trip_id;
    IF NOT FOUND OR coalesce(p_token, '') = '' OR v_trip.share_token <> p_token
       OR v_trip.visibility = 'members' THEN
        RAISE EXCEPTION 'no_access' USING ERRCODE = '42501';
    END IF;
    IF v_trip.visibility = 'password' THEN
        IF p_password IS NULL OR extensions.crypt(p_password, v_trip.view_password_hash) <> v_trip.view_password_hash THEN
            RAISE EXCEPTION 'wrong_password' USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'trip', jsonb_build_object(
            'id', v_trip.id, 'name', v_trip.name, 'members', v_trip.members,
            'categories', v_trip.categories, 'category', v_trip.category,
            'base_currency', v_trip.base_currency, 'timezone', v_trip.timezone,
            'rates', v_trip.rates, 'precision_config', v_trip.precision_config,
            'is_archived', v_trip.is_archived, 'visibility', v_trip.visibility,
            'created_at', v_trip.created_at
        ),
        'expenses', coalesce((
            SELECT jsonb_agg(to_jsonb(e) - 'created_by' ORDER BY e.date, e.created_at)
            FROM app.expenses e
            WHERE e.trip_id = p_trip_id AND e.deleted_at IS NULL
        ), '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION app.get_trip_snapshot(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_trip_snapshot(UUID, TEXT, TEXT) TO anon, authenticated;

-- ── 成員清單與改名 ─────────────────────────────────────────────
-- 等同舊版的 rename_trip_members，另外：
--   · 要是成員才能改
--   · 認領了某個名字的帳號跟著改名（trip_members.member_name）
--   · 被移除的名字如果還有人認領，拒絕（先請他切換成別人）
CREATE OR REPLACE FUNCTION app.update_trip_members(p_trip_id UUID, p_members TEXT[], p_renames JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_old     TEXT[];
    v_members TEXT[];
BEGIN
    IF NOT app.is_admin(p_trip_id) THEN
        RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
    IF p_renames IS NULL OR jsonb_typeof(p_renames) <> 'object' THEN
        RAISE EXCEPTION 'invalid_renames' USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(app.clean_name(m) ORDER BY ord) INTO v_members
    FROM unnest(p_members) WITH ORDINALITY AS u(m, ord);
    IF v_members IS NULL OR cardinality(v_members) > app.max_members()
       OR cardinality(v_members) <> (SELECT count(DISTINCT m) FROM unnest(v_members) AS m) THEN
        RAISE EXCEPTION 'invalid_members' USING ERRCODE = '22023';
    END IF;

    UPDATE app.trip_members tm
    SET member_name = coalesce(p_renames ->> tm.member_name, tm.member_name)
    WHERE tm.trip_id = p_trip_id;

    IF EXISTS (SELECT 1 FROM app.trip_members WHERE trip_id = p_trip_id AND NOT (member_name = ANY (v_members))) THEN
        RAISE EXCEPTION 'member_claimed' USING ERRCODE = '22023';
    END IF;

    UPDATE app.trips SET members = v_members WHERE id = p_trip_id;

    v_old := ARRAY(SELECT jsonb_object_keys(p_renames));
    IF cardinality(v_old) = 0 THEN
        RETURN;
    END IF;

    UPDATE app.expenses e
    SET payer_data = (
            SELECT coalesce(jsonb_object_agg(coalesce(p_renames ->> t.k, t.k), t.v), '{}'::jsonb)
            FROM jsonb_each(e.payer_data) AS t(k, v)
        ),
        split_data = (
            SELECT coalesce(jsonb_object_agg(coalesce(p_renames ->> t.k, t.k), t.v), '{}'::jsonb)
            FROM jsonb_each(e.split_data) AS t(k, v)
        ),
        adjustment_member = coalesce(p_renames ->> e.adjustment_member, e.adjustment_member)
    WHERE e.trip_id = p_trip_id
      AND (e.payer_data ?| v_old OR e.split_data ?| v_old OR e.adjustment_member = ANY (v_old));
END;
$$;

REVOKE ALL ON FUNCTION app.update_trip_members(UUID, TEXT[], JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.update_trip_members(UUID, TEXT[], JSONB) TO authenticated;

-- ── 垃圾桶（同舊版，保留期以資料庫時鐘判斷）────────────────────
-- SECURITY INVOKER：expenses 的 RLS 會擋掉不是成員的人
CREATE OR REPLACE FUNCTION app.list_trip_trash(p_trip_id UUID)
RETURNS SETOF app.expenses
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT * FROM app.expenses
    WHERE trip_id = p_trip_id AND deleted_at IS NOT NULL AND deleted_at > now() - interval '24 hours'
    ORDER BY deleted_at DESC;
$$;

CREATE OR REPLACE FUNCTION app.list_expired_trash(p_trip_id UUID)
RETURNS TABLE(id UUID, photo_urls TEXT[])
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT e.id, e.photo_urls FROM app.expenses e
    WHERE e.trip_id = p_trip_id AND e.deleted_at IS NOT NULL AND e.deleted_at <= now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION app.list_trip_trash(UUID)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.list_expired_trash(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.list_trip_trash(UUID)    TO authenticated;
GRANT EXECUTE ON FUNCTION app.list_expired_trash(UUID) TO authenticated;

-- ── Triggers ───────────────────────────────────────────────────
-- 軟刪除時間一律用資料庫時鐘；寫入者一律是目前登入的帳號（前端送什麼都不算）。
-- 例外：Edge Function 用 service role 寫入時沒有 auth.uid()，由它自己填 created_by
-- （LINE 機器人已經把 LINE 帳號對應到使用者，知道是誰）。
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
        NEW.created_by := OLD.created_by;
        NEW.created_at := OLD.created_at;
        NEW.trip_id    := OLD.trip_id;   -- 帳不能被搬到別的旅程
        IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
            NEW.deleted_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_app_expenses_before_write ON app.expenses;
CREATE TRIGGER tr_app_expenses_before_write
    BEFORE INSERT OR UPDATE ON app.expenses
    FOR EACH ROW EXECUTE FUNCTION app.expenses_before_write();

-- 每趟旅程至少要留一位 owner：最後一位 owner 不能離開或被移除
CREATE OR REPLACE FUNCTION app.keep_one_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF OLD.role = 'owner'
       AND EXISTS (SELECT 1 FROM app.trips WHERE id = OLD.trip_id)
       AND NOT EXISTS (SELECT 1 FROM app.trip_members
                       WHERE trip_id = OLD.trip_id AND role = 'owner' AND user_id <> OLD.user_id) THEN
        RAISE EXCEPTION 'last_owner' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tr_app_keep_one_owner ON app.trip_members;
CREATE TRIGGER tr_app_keep_one_owner
    BEFORE DELETE ON app.trip_members
    FOR EACH ROW EXECUTE FUNCTION app.keep_one_owner();

-- ── 權限分級（David 2026-11-26）────────────────────────────────
-- 一般成員能改：記帳、預設值、匯率與小數位數、分類、AI 記帳偏好
-- 管理員以上才能改：旅程名稱、旅程分組、主幣別、時區、封存（以及隱私、連結、成員名單，走各自的 RPC）
-- 欄位級權限只分得出「登入的人」，分不出角色，所以用 trigger 擋。
CREATE OR REPLACE FUNCTION app.trips_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    -- service role（Edge Function）與 SECURITY DEFINER 的 RPC 不受限（它們自己檢查過了）
    IF auth.uid() IS NULL OR current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    IF NOT app.is_admin(OLD.id) AND (
           NEW.name IS DISTINCT FROM OLD.name
        OR NEW.category IS DISTINCT FROM OLD.category
        OR NEW.base_currency IS DISTINCT FROM OLD.base_currency
        OR NEW.timezone IS DISTINCT FROM OLD.timezone
        OR NEW.is_archived IS DISTINCT FROM OLD.is_archived
    ) THEN
        RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_app_trips_guard_update ON app.trips;
CREATE TRIGGER tr_app_trips_guard_update
    BEFORE UPDATE ON app.trips
    FOR EACH ROW EXECUTE FUNCTION app.trips_guard_update();

-- 建立者指定或取消管理員（p_role：'admin' 或 'editor'）。建立者自己的角色不能用這支改（要轉移請用 transfer_owner）
CREATE OR REPLACE FUNCTION app.set_member_role(p_trip_id UUID, p_user_id UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT app.is_owner(p_trip_id) THEN
        RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
    END IF;
    IF p_role NOT IN ('admin', 'editor') THEN
        RAISE EXCEPTION 'invalid_role' USING ERRCODE = '22023';
    END IF;
    UPDATE app.trip_members SET role = p_role
    WHERE trip_id = p_trip_id AND user_id = p_user_id AND role <> 'owner';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '22023';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.set_member_role(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_member_role(UUID, UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';


-- ============================================================
-- app/03_policies — Row Level Security（預設拒絕）
--
-- 沒有寫政策的動作 = 誰都不能做。service_role（Edge Function）繞過 RLS，
-- 所以 Edge Function 必須自己檢查身分，見 docs/SECURITY.md 第 3 條。
-- ============================================================

ALTER TABLE app.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_identities ENABLE ROW LEVEL SECURITY;

-- ── line_identities：只看得到自己的，寫入只有 Edge Function（service role）──
DROP POLICY IF EXISTS line_identities_self ON app.line_identities;
CREATE POLICY line_identities_self ON app.line_identities
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

ALTER TABLE app.trips        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trip_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.expenses     ENABLE ROW LEVEL SECURITY;

-- ── profiles：只有自己 ─────────────────────────────────────────
DROP POLICY IF EXISTS profiles_self ON app.profiles;
CREATE POLICY profiles_self ON app.profiles
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ── trips：成員可看、可改一般設定；owner 才能刪 ────────────────
-- 建立只能走 app.create_trip（沒有 INSERT 權限）；
-- 哪些欄位能改由 01_tables 的欄位級權限決定。
DROP POLICY IF EXISTS trips_select ON app.trips;
CREATE POLICY trips_select ON app.trips
    FOR SELECT TO authenticated
    USING (app.is_member(id));

DROP POLICY IF EXISTS trips_update ON app.trips;
CREATE POLICY trips_update ON app.trips
    FOR UPDATE TO authenticated
    USING (app.is_member(id))
    WITH CHECK (app.is_member(id));

DROP POLICY IF EXISTS trips_delete ON app.trips;
CREATE POLICY trips_delete ON app.trips
    FOR DELETE TO authenticated
    USING (app.is_owner(id));

-- ── trip_members：看得到同一趟的其他成員；自己可以離開，建立者／管理員可以移除別人 ──
-- 加入只能走 accept_invite／create_trip；改名字只能走 set_my_member／update_trip_members。
DROP POLICY IF EXISTS trip_members_select ON app.trip_members;
CREATE POLICY trip_members_select ON app.trip_members
    FOR SELECT TO authenticated
    USING (app.is_member(trip_id));

DROP POLICY IF EXISTS trip_members_delete ON app.trip_members;
CREATE POLICY trip_members_delete ON app.trip_members
    FOR DELETE TO authenticated
    -- 自己離開；建立者可以移除任何人；管理員只能移除一般成員
    USING (user_id = auth.uid() OR app.is_owner(trip_id) OR (app.is_admin(trip_id) AND role = 'editor'));

-- ── expenses：成員可讀寫 ───────────────────────────────────────
DROP POLICY IF EXISTS expenses_member ON app.expenses;
CREATE POLICY expenses_member ON app.expenses
    FOR ALL TO authenticated
    USING (app.is_member(trip_id))
    WITH CHECK (app.is_member(trip_id));

-- ── 即時同步 ───────────────────────────────────────────────────
-- Realtime 的 postgres_changes 會套用 RLS：使用者只收得到自己是成員的旅程的變動
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime' AND schemaname = 'app' AND tablename = 'trips') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE app.trips;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime' AND schemaname = 'app' AND tablename = 'expenses') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE app.expenses;
        END IF;
    END IF;
END;
$$;
