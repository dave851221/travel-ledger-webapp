-- =============================================================================
-- 旅行小本本（開放版）— app schema 初始化腳本
--
-- ⚠️ 自動產生，請勿手動編輯。
--    來源：supabase/app/schema/NN_*.sql
--    重新產生：npm run db:build
--
-- 舊版（public schema）完全不受影響；兩版共用同一個 Supabase 專案。
-- 本腳本可重複執行（idempotent）。規則見 docs/SECURITY.md。
-- =============================================================================

-- <<<<<<<<<< app/00_base.sql <<<<<<<<<<

-- ============================================================
-- app/00_base — 開放版（旅行小本本）的 schema 與基礎函式
--
-- 舊版（旅遊小本本）在 public，完全不碰；兩版共用同一個 Supabase 專案。
-- 開放版的原則：每張表都開 RLS、預設拒絕；權限只在資料庫與 Edge Function 判斷。
-- 詳見 docs/SECURITY.md。
-- ============================================================

CREATE SCHEMA IF NOT EXISTS app;

-- PostgREST 透過 anon / authenticated 角色存取；service_role 給 Edge Function。
GRANT USAGE ON SCHEMA app TO anon, authenticated, service_role;

-- 之後在 app 裡新增的函式，預設不給任何人執行，要用的再逐一 GRANT
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 分享／邀請連結用的隨機字串：24 bytes → 32 個 URL 安全字元
CREATE OR REPLACE FUNCTION app.random_token()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
    SELECT translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
$$;

REVOKE ALL ON FUNCTION app.random_token() FROM PUBLIC, anon, authenticated;


-- <<<<<<<<<< app/01_tables.sql <<<<<<<<<<

-- ============================================================
-- app/01_tables — 開放版（旅行小本本）的資料表
--
-- 每一張表都開 RLS 且預設拒絕（政策在 03_policies.sql），規則見 docs/SECURITY.md。
-- ============================================================

-- ── 使用者的個人設定 ───────────────────────────────────────────
-- default_alias：加入新旅程時預設帶入的名字（LINE 顯示名稱常常太長或有表情符號）
CREATE TABLE IF NOT EXISTS app.profiles (
    user_id       UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    default_alias TEXT        CHECK (default_alias IS NULL OR char_length(btrim(default_alias)) BETWEEN 1 AND 20),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── LINE 帳號 ↔ 使用者 ─────────────────────────────────────────
-- Supabase 沒有內建 LINE 登入，由 Edge Function auth-line 驗過 LINE 的 ID token 後寫入這張表。
-- line_user_id 是 LINE Login channel 所屬 provider 底下的 userId；
-- ⚠️ Messaging API（機器人）的 channel 必須在同一個 provider，機器人看到的 userId 才會一樣。
-- 一個使用者可以連好幾個 LINE 帳號（換手機、換帳號），一個 LINE 帳號只屬於一個使用者。
-- 只有 service role 寫入；使用者只看得到自己的（不送 LINE ID 給其他成員）。
CREATE TABLE IF NOT EXISTS app.line_identities (
    line_user_id TEXT        PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS line_identities_user_idx ON app.line_identities (user_id);

-- ── 旅程 ───────────────────────────────────────────────────────
-- 與 public.trips 相同的欄位（前端與 Edge Function 共用同一套程式），差別：
--   · 沒有 access_code：進入權限改由 trip_members 決定
--   · visibility：沒登入的人能不能看 —— members（只有成員）/ link（有分享連結就能看）/
--                 password（分享連結 + 密碼）
--   · share_token：分享連結裡的隨機字串；invite_token：邀請連結裡的隨機字串。
--                  兩者分開，分享給「只想讓他看」的人不等於讓他加入記帳。
--                  owner 可以重新產生，舊連結立刻失效。
--   · view_password_hash：bcrypt（extensions.crypt），原文不存
--   · created_by：建立者（不等於 owner，owner 以 trip_members.role 為準）
CREATE TABLE IF NOT EXISTS app.trips (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    members               TEXT[]      NOT NULL,
    categories            TEXT[]      NOT NULL,
    category              TEXT,
    base_currency         TEXT        NOT NULL,
    timezone              TEXT,
    -- 旅程日期（選填）：一天只填 start_date；end_date 含當天
    start_date            DATE,
    end_date              DATE,
    rates                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
    precision_config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_archived           BOOLEAN     NOT NULL DEFAULT FALSE,
    default_currency      TEXT,
    default_category      TEXT,
    default_payer         TEXT[]      DEFAULT '{}',
    default_split_members TEXT[]      DEFAULT '{}',
    ai_preference         TEXT,
    visibility            TEXT        NOT NULL DEFAULT 'members'
                                      CHECK (visibility IN ('members', 'link', 'password')),
    share_token           TEXT        NOT NULL DEFAULT app.random_token(),
    invite_token          TEXT        NOT NULL DEFAULT app.random_token(),
    view_password_hash    TEXT,
    created_by            UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 密碼模式一定要有密碼，否則等於「有連結就能看」卻顯示成要密碼
    CONSTRAINT trips_dates_check CHECK (end_date IS NULL OR (start_date IS NOT NULL AND end_date >= start_date)),
    CONSTRAINT trips_password_needs_hash CHECK (visibility <> 'password' OR view_password_hash IS NOT NULL)
);

-- ── 誰是這趟旅程的成員 ─────────────────────────────────────────
-- 一個帳號一列；member_name 是他在這趟裡的名字（＝帳目 JSONB 的 key），可以重複：
-- 夫妻共用一份、或同一個人有兩個 LINE，都可以認領同一個成員。
-- 「切換成其他成員」就是改自己這一列的 member_name（走 RPC set_my_member，會檢查名字在 members 裡）。
CREATE TABLE IF NOT EXISTS app.trip_members (
    trip_id     UUID        NOT NULL REFERENCES app.trips(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    member_name TEXT        NOT NULL,
    -- owner：建立者，最高權限（指定管理員、刪除旅程、轉移）；admin：管理員（旅程名稱、隱私、成員管理）；
    -- editor：一般成員（記帳、預設值、匯率、分類）。哪些欄位誰能改見 02_functions 的 trips_guard_update。
    role        TEXT        NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'admin', 'editor')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (trip_id, user_id)
);

CREATE INDEX IF NOT EXISTS trip_members_user_idx ON app.trip_members (user_id);

-- ── 支出 ───────────────────────────────────────────────────────
-- 欄位與 public.expenses 相同，另外記下是哪個帳號寫入的（created_by，由 trigger 蓋上）
CREATE TABLE IF NOT EXISTS app.expenses (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id            UUID        NOT NULL REFERENCES app.trips(id) ON DELETE CASCADE,
    date               DATE        NOT NULL DEFAULT CURRENT_DATE,
    category           TEXT        NOT NULL,
    description        TEXT        NOT NULL,
    amount             NUMERIC     NOT NULL,
    currency           TEXT        NOT NULL,
    payer_data         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    split_data         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    adjustment_member  TEXT,
    photo_urls         TEXT[]      DEFAULT '{}',
    receipt_photo_urls TEXT[]      DEFAULT '{}',
    is_settlement      BOOLEAN     DEFAULT FALSE,
    deleted_at         TIMESTAMPTZ,
    created_by         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_expenses_trip_id_idx    ON app.expenses (trip_id);
CREATE INDEX IF NOT EXISTS app_expenses_deleted_at_idx ON app.expenses (deleted_at);

-- ── 表層權限 ───────────────────────────────────────────────────
-- anon 對任何表都沒有權限：沒登入的人只能走 SECURITY DEFINER 的 get_trip_snapshot。
-- authenticated 有表權限，但能碰到哪幾列由 RLS 決定；
-- 沒有 INSERT 權限的表（trips、trip_members）只能透過 RPC 建立。
--
-- trips 用「欄位級」權限：
--   · SELECT 不含 view_password_hash（誰都不需要拿到，連 owner 也不用）
--   · UPDATE 只開一般設定欄位；visibility、兩個 token、密碼、created_by 只能由 owner 透過 RPC 改。
--   ⚠️ 新增 trips 欄位時要決定它屬於哪一邊，並在這裡補上 —— 不補的話前端讀不到也寫不進去。
--   （欄位級權限必須「只給需要的欄位」，對整張表 GRANT 之後再 REVOKE 單一欄位是沒有效果的。）
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON app.profiles TO authenticated;
GRANT SELECT ON app.line_identities TO authenticated;

GRANT SELECT (id, name, members, categories, category, base_currency, timezone, start_date, end_date, rates, precision_config,
              is_archived, default_currency, default_category, default_payer, default_split_members,
              ai_preference, visibility, share_token, invite_token, created_by, created_at)
    ON app.trips TO authenticated;
GRANT UPDATE (name, categories, category, base_currency, timezone, start_date, end_date, rates, precision_config,
              is_archived, default_currency, default_category, default_payer, default_split_members,
              ai_preference)
    ON app.trips TO authenticated;
-- members（成員清單）不在 UPDATE 裡：改名要連同所有支出一起改，一律走 RPC
GRANT DELETE ON app.trips TO authenticated;

GRANT SELECT, DELETE ON app.trip_members TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.expenses TO authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA app TO service_role;


-- <<<<<<<<<< app/02_functions.sql <<<<<<<<<<

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
AS $$ SELECT 150 $$;

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
-- 參數多了旅程日期（2026-11-27），舊的 8 個參數版本先拿掉，不然 PostgREST 會看到兩個同名函式
DROP FUNCTION IF EXISTS app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB);
CREATE OR REPLACE FUNCTION app.create_trip(
    p_name          TEXT,
    p_members       TEXT[],
    p_my_name       TEXT,
    p_base_currency TEXT,
    p_categories    TEXT[],
    p_timezone      TEXT DEFAULT NULL,
    p_category      TEXT DEFAULT NULL,
    -- 幣別小數位數（例如 {"JPY": 0}），由前端依幣別決定；跟建立一起寫，不另外更新一次
    p_precision_config JSONB DEFAULT '{}'::jsonb,
    -- 旅程日期（選填），規則同 trips_dates_check
    p_start_date    DATE DEFAULT NULL,
    p_end_date      DATE DEFAULT NULL
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
                           rates, precision_config, start_date, end_date)
    VALUES (btrim(p_name), v_members, coalesce(p_categories, '{}'), upper(btrim(p_base_currency)),
            p_timezone, p_category, v_uid,
            jsonb_build_object(upper(btrim(p_base_currency)), 1),
            CASE WHEN jsonb_typeof(p_precision_config) = 'object' THEN p_precision_config ELSE '{}'::jsonb END,
            p_start_date, CASE WHEN p_end_date = p_start_date THEN NULL ELSE p_end_date END)
    RETURNING id INTO v_id;

    INSERT INTO app.trip_members (trip_id, user_id, member_name, role)
    VALUES (v_id, v_uid, v_me, 'owner');

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB, DATE, DATE) TO authenticated;

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
            'start_date', v_trip.start_date, 'end_date', v_trip.end_date,
            'default_currency', v_trip.default_currency, 'default_category', v_trip.default_category,
            -- 分享頁也看得到行程（試算表由 tlb-itinerary 讀，它會再驗一次分享連結）
            'itinerary_sheet', v_trip.itinerary_sheet,
            'itinerary_color', v_trip.itinerary_color, 'itinerary_style', v_trip.itinerary_style,
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

-- 分享連結對不對（給 Edge Function 用：分享頁的照片簽名網址、試算表行程）。規則同 get_trip_snapshot。
CREATE OR REPLACE FUNCTION app.share_access_ok(p_trip_id UUID, p_token TEXT, p_password TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_trip app.trips%ROWTYPE;
BEGIN
    SELECT * INTO v_trip FROM app.trips WHERE id = p_trip_id;
    IF NOT FOUND OR coalesce(p_token, '') = '' OR v_trip.share_token <> p_token OR v_trip.visibility = 'members' THEN
        RETURN FALSE;
    END IF;
    IF v_trip.visibility = 'password' THEN
        RETURN p_password IS NOT NULL AND extensions.crypt(p_password, v_trip.view_password_hash) = v_trip.view_password_hash;
    END IF;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION app.share_access_ok(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.share_access_ok(UUID, TEXT, TEXT) TO service_role;

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
-- 管理員以上才能改：旅程名稱、旅程分組、主幣別、時區、封存、行程試算表與行程的色系／呈現方式（以及隱私、連結、成員名單，走各自的 RPC）
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
        OR NEW.itinerary_sheet IS DISTINCT FROM OLD.itinerary_sheet
        OR NEW.itinerary_color IS DISTINCT FROM OLD.itinerary_color
        OR NEW.itinerary_style IS DISTINCT FROM OLD.itinerary_style
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

-- ── 帳號資訊（David 2026-11-27：成員清單要看得出誰是誰、用什麼登入）────────
-- 遮掉 email 的中間：d***1@gmail.com。成員彼此只看得到這個，不給完整 email、不給 LINE userId
CREATE OR REPLACE FUNCTION app.mask_email(p_email TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_email IS NULL OR position('@' IN p_email) < 2 THEN NULL
        WHEN position('@' IN p_email) <= 3 THEN left(p_email, 1) || '***' || substr(p_email, position('@' IN p_email))
        ELSE left(p_email, 1) || '***' || substr(p_email, position('@' IN p_email) - 1)
    END;
$$;

REVOKE ALL ON FUNCTION app.mask_email(TEXT) FROM PUBLIC, anon, authenticated;

-- 一個帳號的登入方式與顯示用的名字：
--   line   → app.line_identities（顯示 LINE 名稱）
--   google → auth.identities（顯示 Google 名稱與遮過的 email）
-- LINE 帳號在 auth 裡的 email 是 line-…@line.users.invalid（產生登入 token 用的），不顯示
CREATE OR REPLACE FUNCTION app.account_logins(p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'provider'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('provider', 'line', 'name', li.display_name) AS x
        FROM app.line_identities li WHERE li.user_id = p_user_id
        UNION ALL
        SELECT jsonb_build_object(
            'provider', 'google',
            'name', coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'name'),
            'account', app.mask_email(i.identity_data ->> 'email'))
        FROM auth.identities i WHERE i.user_id = p_user_id AND i.provider = 'google'
    ) s;
$$;

REVOKE ALL ON FUNCTION app.account_logins(UUID) FROM PUBLIC, anon, authenticated;

-- 這趟旅程登入的成員（成員才能看）：名字、角色、登入方式
CREATE OR REPLACE FUNCTION app.trip_member_accounts(p_trip_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT app.is_member(p_trip_id) THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '42501';
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'user_id', tm.user_id,
            'member_name', tm.member_name,
            'role', tm.role,
            'logins', app.account_logins(tm.user_id)
        ) ORDER BY tm.joined_at)
        FROM app.trip_members tm WHERE tm.trip_id = p_trip_id
    ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION app.trip_member_accounts(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.trip_member_accounts(UUID) TO authenticated;

-- 我自己的帳號連了哪些登入方式（「我的帳號」頁用）
CREATE OR REPLACE FUNCTION app.my_logins()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    RETURN app.account_logins(auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION app.my_logins() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_logins() TO authenticated;

NOTIFY pgrst, 'reload schema';


-- <<<<<<<<<< app/03_policies.sql <<<<<<<<<<

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
    USING (user_id = (SELECT auth.uid()));

ALTER TABLE app.trips        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trip_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.expenses     ENABLE ROW LEVEL SECURITY;

-- ── profiles：只有自己 ─────────────────────────────────────────
DROP POLICY IF EXISTS profiles_self ON app.profiles;
CREATE POLICY profiles_self ON app.profiles
    FOR ALL TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

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
    USING (user_id = (SELECT auth.uid()) OR app.is_owner(trip_id) OR (app.is_admin(trip_id) AND role = 'editor'));

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


-- <<<<<<<<<< app/04_storage.sql <<<<<<<<<<

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

-- 上傳政策（成員＋照片張數上限）在 05_quota.sql

DROP POLICY IF EXISTS app_images_delete ON storage.objects;
CREATE POLICY app_images_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'app-images' AND app.is_member(app.trip_id_from_path(name)));


-- <<<<<<<<<< app/05_quota.sql <<<<<<<<<<

-- ============================================================
-- app/05_quota — 每趟旅程的用量上限與 AI 防濫用
--
-- 規則（David 2026-11-26／27）：
--   · 免費、付費旅程都有上限，只設用量、不設有效期。數字放在 app.plan_limits，改數字不用改程式
--     （免費 60 筆／30 次 AI／30 張照片；解鎖 600／300／600；加量包加在 trips.extra_*）
--   · AI 次數 LINE 與網頁共用；被 AI 拒絕的呼叫也算（真的花了錢）
--   · 不限每個人每分鐘／每天的次數，只用「每趟」當上限（David 2026-11-27）
--   · 防止一直開新的免費旅程刷 AI：從沒付過費的帳號最多「建立」5 趟（刪掉的也算；加入別人的不算），
--     付過費（app.paid_accounts）就不限
--   · app.quota_settings.ai_enabled 是總開關（緊急時一鍵停掉所有 AI），平常不會擋
--   · 上限只在資料庫判斷，前端只負責顯示（docs/SECURITY.md）
-- ============================================================

-- ── 方案與上限 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.plan_limits (
    plan         TEXT    PRIMARY KEY,
    max_entries  INTEGER NOT NULL CHECK (max_entries >= 0),
    max_ai_calls INTEGER NOT NULL CHECK (max_ai_calls >= 0),
    max_photos   INTEGER NOT NULL CHECK (max_photos >= 0)
);

INSERT INTO app.plan_limits (plan, max_entries, max_ai_calls, max_photos) VALUES
    ('free', 60, 30, 30),
    ('paid', 600, 300, 600)
ON CONFLICT (plan) DO NOTHING;

-- 旅程的方案與加量（只有 service role 能改：付款流程或開發者手動）
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS extra_entries  INTEGER NOT NULL DEFAULT 0 CHECK (extra_entries >= 0);
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS extra_ai_calls INTEGER NOT NULL DEFAULT 0 CHECK (extra_ai_calls >= 0);
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS extra_photos   INTEGER NOT NULL DEFAULT 0 CHECK (extra_photos >= 0);
-- 開發者後台可以單獨暫停一趟的 AI（例如被拿來大量叫 AI、或內容有問題），帳照常能記
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS ai_suspended   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_plan_fkey;
ALTER TABLE app.trips ADD CONSTRAINT trips_plan_fkey FOREIGN KEY (plan) REFERENCES app.plan_limits(plan);
-- 成員看得到自己旅程的方案（顯示用量），但改不了（UPDATE 的欄位清單在 01_tables 沒有這幾個）
GRANT SELECT (plan, extra_entries, extra_ai_calls, extra_photos) ON app.trips TO authenticated;

-- ── 全站設定（只有一列）───────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.quota_settings (
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    ai_enabled         BOOLEAN NOT NULL DEFAULT TRUE,  -- 總開關：FALSE 時所有 AI 立刻停
    free_trip_creations INTEGER NOT NULL DEFAULT 5 CHECK (free_trip_creations >= 0)
);
INSERT INTO app.quota_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- 付過費的帳號（付款流程寫入；建立旅程不設上限）
CREATE TABLE IF NOT EXISTS app.paid_accounts (
    user_id       UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    first_paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每個帳號建立過幾趟旅程（旅程刪掉這裡也留著，不然刪了再建就能一直拿新的免費額度）
CREATE TABLE IF NOT EXISTS app.trip_creations (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    trip_id    UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_creations_user_idx ON app.trip_creations (user_id);
-- 上線前就建好的旅程也算進去
INSERT INTO app.trip_creations (user_id, trip_id, created_at)
SELECT t.created_by, t.id, t.created_at FROM app.trips t
WHERE t.created_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app.trip_creations c WHERE c.trip_id = t.id);

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
ALTER TABLE app.quota_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.paid_accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trip_creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_calls    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.plan_limits, app.quota_settings, app.paid_accounts, app.trip_creations, app.ai_calls FROM anon, authenticated;
GRANT ALL ON app.plan_limits, app.quota_settings, app.paid_accounts, app.trip_creations, app.ai_calls TO service_role;

-- ── 建立旅程的上限 ─────────────────────────────────────────────
-- （trip_allowance 在 07_account.sql 會換成「連同刪掉的舊帳號一起算」的版本）
CREATE OR REPLACE FUNCTION app.trip_allowance(p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'paid', EXISTS (SELECT 1 FROM app.paid_accounts WHERE user_id = p_user_id),
        'created', (SELECT count(*)::int FROM app.trip_creations WHERE user_id = p_user_id),
        'limit', (SELECT free_trip_creations FROM app.quota_settings WHERE id));
$$;
REVOKE ALL ON FUNCTION app.trip_allowance(UUID) FROM PUBLIC, anon, authenticated;

-- 建立旅程的畫面顯示「還能建立幾趟」
CREATE OR REPLACE FUNCTION app.my_trip_allowance()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    RETURN app.trip_allowance(auth.uid());
END;
$$;
REVOKE ALL ON FUNCTION app.my_trip_allowance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_trip_allowance() TO authenticated;

CREATE OR REPLACE FUNCTION app.trips_check_creation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    a JSONB;
BEGIN
    IF NEW.created_by IS NULL THEN
        RETURN NEW;
    END IF;
    -- 同一個帳號同時建好幾趟時排隊算
    PERFORM pg_advisory_xact_lock(hashtextextended('trip_creations:' || NEW.created_by::text, 0));
    a := app.trip_allowance(NEW.created_by);
    IF NOT (a ->> 'paid')::boolean AND (a ->> 'created')::int >= (a ->> 'limit')::int THEN
        RAISE EXCEPTION 'trip_limit' USING ERRCODE = 'P0001', DETAIL = a ->> 'limit';
    END IF;
    INSERT INTO app.trip_creations (user_id, trip_id) VALUES (NEW.created_by, NEW.id);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.trips_check_creation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_trips_check_creation ON app.trips;
CREATE TRIGGER tr_app_trips_check_creation
    BEFORE INSERT ON app.trips
    FOR EACH ROW EXECUTE FUNCTION app.trips_check_creation();

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
--   ai_disabled（總開關關著）、trip_limit、no_trip
-- 呼叫端要先確認 actor 是這趟的成員（或是綁定這趟的 LINE 群組裡的人），這支只管次數。
-- actor 只記下來（之後查濫用用），不拿來限制。
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


-- <<<<<<<<<< app/06_line.sql <<<<<<<<<<

-- ============================================================
-- app/06_line — 旅行喵喵（LINE 機器人 tlb-line-webhook）的對話狀態
--
-- 與舊版 public 的 line_* 表同名、同欄位（機器人程式兩版共用，見 _shared/appMode.ts），差別：
--   · 綁定旅程不用通行碼，要「LINE 帳號已連到網站帳號、而且是那趟的成員」（bind_line_chat）
--   · bound_by：誰把這個聊天綁到這趟（帳號 id），之後被移出旅程就自動失效
--   · 沒有 line_trip_id_mapping（不用 6 碼代碼）
-- 全部只有 service role 能讀寫：網站的使用者碰不到別人的聊天紀錄。
-- ============================================================

CREATE TABLE IF NOT EXISTS app.line_user_states (
    line_user_id     TEXT PRIMARY KEY,            -- groupId / roomId / userId
    current_trip_id  UUID REFERENCES app.trips(id) ON DELETE SET NULL,
    pending_trip_id  UUID REFERENCES app.trips(id) ON DELETE SET NULL,  -- 開放版不用，留著讓程式共用
    pending_at       TIMESTAMPTZ,
    default_config   TEXT,
    mention_required BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at   TIMESTAMPTZ DEFAULT now(),
    created_at       TIMESTAMPTZ DEFAULT now(),
    followup_user_id TEXT,
    followup_until   TIMESTAMPTZ,
    photos_muted     BOOLEAN NOT NULL DEFAULT FALSE,
    bound_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app.line_chat_history (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    line_user_id    TEXT NOT NULL REFERENCES app.line_user_states(line_user_id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    speaker_user_id TEXT,
    speaker_name    TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_line_chat_history_user_idx ON app.line_chat_history (line_user_id);
CREATE INDEX IF NOT EXISTS app_line_chat_history_created_idx ON app.line_chat_history (created_at);

CREATE TABLE IF NOT EXISTS app.line_bot_messages (
    message_id   TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_line_bot_messages_created_idx ON app.line_bot_messages (created_at);

CREATE TABLE IF NOT EXISTS app.line_webhook_events (
    event_id   TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.line_processed_actions (
    nonce        TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES app.line_user_states(line_user_id) ON DELETE CASCADE,
    action_type  TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE app.line_user_states       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_chat_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_bot_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_webhook_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_processed_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.line_user_states, app.line_chat_history, app.line_bot_messages,
              app.line_webhook_events, app.line_processed_actions FROM anon, authenticated;
GRANT ALL ON app.line_user_states, app.line_chat_history, app.line_bot_messages,
             app.line_webhook_events, app.line_processed_actions TO service_role;

-- ── LINE 使用者 → 網站帳號 → 在這趟的名字 ─────────────────────
-- 回傳 NULL：這個 LINE 還沒連到網站帳號、或不是這趟的成員
CREATE OR REPLACE FUNCTION app.line_member(p_line_user_id TEXT, p_trip_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object('user_id', tm.user_id, 'member_name', tm.member_name, 'role', tm.role)
    FROM app.line_identities li
    JOIN app.trip_members tm ON tm.user_id = li.user_id AND tm.trip_id = p_trip_id
    WHERE li.line_user_id = p_line_user_id
    LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.line_member(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.line_member(TEXT, UUID) TO service_role;

-- 這個 LINE 使用者可以綁哪些旅程（他是成員、沒封存），旅程日期（沒填用建立日）新的在前；附日期與人數給選旅程卡片
CREATE OR REPLACE FUNCTION app.line_bindable_trips(p_line_user_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'linked', EXISTS (SELECT 1 FROM app.line_identities WHERE line_user_id = p_line_user_id),
        'trips', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', t.id, 'name', t.name, 'start_date', t.start_date, 'end_date', t.end_date,
                       'member_count', coalesce(array_length(t.members, 1), 0))
                   ORDER BY coalesce(t.start_date, t.created_at::date) DESC, t.created_at DESC)
            FROM app.line_identities li
            JOIN app.trip_members tm ON tm.user_id = li.user_id
            JOIN app.trips t ON t.id = tm.trip_id AND NOT t.is_archived
            WHERE li.line_user_id = p_line_user_id
        ), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION app.line_bindable_trips(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.line_bindable_trips(TEXT) TO service_role;

-- LINE 登入（auth-line）：一趟資料庫往返找出 LINE 帳號對應的使用者與登入用 email，順便記登入時間與 LINE 名稱。
-- 以前是 select → update → admin.getUserById 三趟（Edge Function 在東京、資料庫在雪梨，每趟都要好幾百毫秒）。
-- 沒有對應時回 NULL（第一次登入，由 auth-line 建使用者）。
CREATE OR REPLACE FUNCTION app.line_login_lookup(p_line_user_id TEXT, p_display_name TEXT)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH li AS (
        UPDATE app.line_identities
           SET last_login_at = now(),
               display_name = coalesce(p_display_name, display_name)
         WHERE line_user_id = p_line_user_id
        RETURNING user_id
    )
    SELECT jsonb_build_object('user_id', u.id, 'email', u.email)
      FROM li JOIN auth.users u ON u.id = li.user_id;
$$;
REVOKE ALL ON FUNCTION app.line_login_lookup(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.line_login_lookup(TEXT, TEXT) TO service_role;

-- 把一個 LINE 聊天（群組或一對一）綁到旅程：發言的人必須是那趟的成員
CREATE OR REPLACE FUNCTION app.bind_line_chat(p_source_id TEXT, p_line_user_id TEXT, p_trip_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_member JSONB := app.line_member(p_line_user_id, p_trip_id);
    v_trip   RECORD;
BEGIN
    IF v_member IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_member');
    END IF;
    SELECT name, members, is_archived INTO v_trip FROM app.trips WHERE id = p_trip_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_trip');
    END IF;
    IF v_trip.is_archived THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'archived');
    END IF;
    INSERT INTO app.line_user_states (line_user_id, current_trip_id, bound_by)
    VALUES (p_source_id, p_trip_id, (v_member ->> 'user_id')::uuid)
    ON CONFLICT (line_user_id) DO UPDATE
        SET current_trip_id = EXCLUDED.current_trip_id, bound_by = EXCLUDED.bound_by,
            pending_trip_id = NULL, pending_at = NULL;
    RETURN jsonb_build_object('ok', TRUE, 'name', v_trip.name, 'members', to_jsonb(v_trip.members));
END;
$$;
REVOKE ALL ON FUNCTION app.bind_line_chat(TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.bind_line_chat(TEXT, TEXT, UUID) TO service_role;

-- 綁定的人被移出旅程（或自己離開）：他綁的聊天跟著解除，免得被踢的人還能從 LINE 記帳
CREATE OR REPLACE FUNCTION app.unbind_line_on_leave()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE app.line_user_states SET current_trip_id = NULL, bound_by = NULL
    WHERE current_trip_id = OLD.trip_id AND bound_by = OLD.user_id;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app.unbind_line_on_leave() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_unbind_line_on_leave ON app.trip_members;
CREATE TRIGGER tr_app_unbind_line_on_leave
    AFTER DELETE ON app.trip_members
    FOR EACH ROW EXECUTE FUNCTION app.unbind_line_on_leave();

-- 機器人用 service role 上傳照片，storage 的上傳政策管不到，自己先問張數（line-webhook/quota.ts）
GRANT EXECUTE ON FUNCTION app.photo_quota_ok(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';


-- <<<<<<<<<< app/07_account.sql <<<<<<<<<<

-- ============================================================
-- app/07_account — 刪除自己的帳號（David 2026-11-27）
--
-- 用途：LINE 或 Google 已經自己登入過、變成另一個帳號時，刪掉那個帳號就能把它連到主帳號。
-- 刪除時：
--   · 自己建立、而且只剩自己的旅程 → 整趟刪掉（照片由前端先刪，見 AccountModal）
--   · 還有別人的旅程 → 自己是建立者的話，交給最早加入的管理員（沒有就最早加入的成員）
--   · 帳上的名字、別人記的帳都留著；自己記的帳 created_by 變成空的
--   · 登入方式（LINE／Google）、個人設定一起刪掉
-- 防刷免費額度：刪掉帳號再用同一個 LINE／Google 註冊，「建立過幾趟」要接著算，
-- 所以刪除前把登入方式的雜湊（不存原文）與建立過的趟數留在 app.deleted_identity_trips。
-- ============================================================

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

    -- 建立過、而且還留著的旅程數（只剩自己的已經刪掉，空出名額）與有沒有付過費：跟著登入方式留下來（只存雜湊）
    SELECT (a ->> 'created')::int, (a ->> 'paid')::boolean INTO v_created, v_paid FROM app.trip_allowance(v_uid) a;
    INSERT INTO app.deleted_identity_trips (identity_hash, trips_created, paid)
    SELECT h, v_created, v_paid FROM unnest(app.identity_hashes(v_uid)) h
    ON CONFLICT (identity_hash) DO UPDATE
        SET trips_created = GREATEST(app.deleted_identity_trips.trips_created, EXCLUDED.trips_created),
            paid = app.deleted_identity_trips.paid OR EXCLUDED.paid,
            deleted_at = now();

    -- trip_members、line_identities、profiles、auth.identities 都會跟著刪（ON DELETE CASCADE）
    DELETE FROM auth.users WHERE id = v_uid;
END;
$$;
REVOKE ALL ON FUNCTION app.delete_my_account(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.delete_my_account(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';


-- <<<<<<<<<< app/08_liff.sql <<<<<<<<<<

-- ============================================================
-- app/08_liff — 開放版 LIFF 編輯頁讀草稿、防重複存檔
--
-- 舊版的 LIFF 頁直接讀寫 public.line_chat_history／line_processed_actions（對匿名開放）。
-- 開放版那兩張表只有 service role 能碰（06_line.sql），LIFF 頁改走這三支 RPC：
-- 一律先找到那張草稿（line_user_id ＋ nonce），確認呼叫的人是草稿那趟（tid）的成員，才讀／寫。
-- ============================================================

-- 找出一張草稿（最近 30 張 pending 裡 n = nonce 的那張）；找不到回 NULL。成員檢查由呼叫端做。
CREATE OR REPLACE FUNCTION app.liff_find_draft(p_source_id TEXT, p_nonce TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    r RECORD;
    d JSONB;
BEGIN
    FOR r IN SELECT content FROM app.line_chat_history
             WHERE line_user_id = p_source_id AND role = 'pending'
             ORDER BY created_at DESC LIMIT 30 LOOP
        BEGIN
            d := r.content::jsonb;
        EXCEPTION WHEN others THEN
            CONTINUE;
        END;
        IF d ->> 'n' = p_nonce THEN
            RETURN d;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.liff_find_draft(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- 草稿所屬的旅程；不是成員就丟 not_member
CREATE OR REPLACE FUNCTION app.liff_draft_trip(p_draft JSONB)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_trip UUID;
BEGIN
    BEGIN
        v_trip := (p_draft ->> 'tid')::uuid;
    EXCEPTION WHEN others THEN
        v_trip := NULL;
    END;
    IF v_trip IS NULL OR NOT app.is_member(v_trip) THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '42501';
    END IF;
    RETURN v_trip;
END;
$$;
REVOKE ALL ON FUNCTION app.liff_draft_trip(JSONB) FROM PUBLIC, anon, authenticated;

-- LIFF 編輯頁打開草稿：{ used: 已經按過確認／取消, draft: 草稿內容 }；找不到草稿 draft 是 null
CREATE OR REPLACE FUNCTION app.liff_draft(p_source_id TEXT, p_nonce TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    d JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    d := app.liff_find_draft(p_source_id, p_nonce);
    IF d IS NULL THEN
        RETURN jsonb_build_object('used', FALSE, 'draft', NULL);
    END IF;
    PERFORM app.liff_draft_trip(d);
    RETURN jsonb_build_object(
        'used', EXISTS (SELECT 1 FROM app.line_processed_actions WHERE nonce = p_nonce),
        'draft', d);
END;
$$;
REVOKE ALL ON FUNCTION app.liff_draft(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.liff_draft(TEXT, TEXT) TO authenticated;

-- 存檔前佔用 nonce（跟 LINE 上的「確認存入」「取消」搶同一把鎖）；佔到回 TRUE
CREATE OR REPLACE FUNCTION app.liff_claim_nonce(p_source_id TEXT, p_nonce TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    d JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    d := app.liff_find_draft(p_source_id, p_nonce);
    IF d IS NULL THEN
        RETURN FALSE;
    END IF;
    PERFORM app.liff_draft_trip(d);
    INSERT INTO app.line_processed_actions (nonce, line_user_id, action_type)
    VALUES (p_nonce, p_source_id, 'save')
    ON CONFLICT (nonce) DO NOTHING;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app.liff_claim_nonce(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.liff_claim_nonce(TEXT, TEXT) TO authenticated;

-- 存檔失敗時放掉 nonce，不然那張卡片之後再也存不進去
CREATE OR REPLACE FUNCTION app.liff_release_nonce(p_source_id TEXT, p_nonce TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    d JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    d := app.liff_find_draft(p_source_id, p_nonce);
    IF d IS NULL THEN
        RETURN;
    END IF;
    PERFORM app.liff_draft_trip(d);
    DELETE FROM app.line_processed_actions
    WHERE nonce = p_nonce AND line_user_id = p_source_id AND action_type = 'save';
END;
$$;
REVOKE ALL ON FUNCTION app.liff_release_nonce(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.liff_release_nonce(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';


-- <<<<<<<<<< app/09_admin.sql <<<<<<<<<<

-- ============================================================
-- app/09_admin — 開發者後台（David 2026-11-27）
--
-- 誰是管理員：app.site_admins（只有 service role 能改，要用 SQL 加人）。
-- 後台的每一支 RPC 第一件事都是 app.require_site_admin()，不是管理員就丟 not_admin。
-- 能做的事：看總覽、看旅程與帳號、解鎖旅程／加量、標記付費、AI 總開關、暫停某趟的 AI、改方案上限。
-- 隱私：只看得到統計數字、旅程名稱、遮過的 email 與 LINE 名稱；看不到帳目內容與照片。
-- ============================================================

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

-- ── 建立旅程的額度（最終版；05_quota、07_account 的舊版本被這裡取代）─────────
-- David 2026-11-27：刪掉的旅程要空出名額（不想花錢的人照樣能玩）→ 算「還留著、自己建立的旅程」。
-- 加上同一個 LINE／Google 刪掉的舊帳號留下來還在的旅程（app.deleted_identity_trips）。
-- 付過費、或是網站管理員（例如從舊版匯入很多趟的 David）不限。
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
        'paid', EXISTS (SELECT 1 FROM app.paid_accounts WHERE user_id = p_user_id)
                OR EXISTS (SELECT 1 FROM app.site_admins WHERE user_id = p_user_id)
                OR (SELECT paid FROM prev),
        'created', (SELECT count(*)::int FROM app.trips WHERE created_by = p_user_id) + (SELECT created FROM prev),
        'limit', (SELECT free_trip_creations FROM app.quota_settings WHERE id));
$$;
REVOKE ALL ON FUNCTION app.trip_allowance(UUID) FROM PUBLIC, anon, authenticated;

-- ── 方案一覽（升級視窗顯示用；數字以這張表為準，後台改了這裡就跟著變）────
CREATE OR REPLACE FUNCTION app.plan_catalog()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(jsonb_object_agg(plan, jsonb_build_object(
        'max_entries', max_entries, 'max_ai_calls', max_ai_calls, 'max_photos', max_photos)), '{}'::jsonb)
    FROM app.plan_limits;
$$;
REVOKE ALL ON FUNCTION app.plan_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.plan_catalog() TO authenticated;


-- <<<<<<<<<< app/10_photos.sql <<<<<<<<<<

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

NOTIFY pgrst, 'reload schema';


-- <<<<<<<<<< app/11_itinerary.sql <<<<<<<<<<

-- ============================================================
-- app/11_itinerary — 用 Google 試算表排的行程（David 2026-11-27）
--
-- 旅程設定貼上試算表連結，只存試算表的 id（itinerary_sheet）。
-- 試算表要「知道連結的人都能檢視」；讀取在 Edge Function tlb-itinerary（成員才讀得到）
-- 與旅行喵喵（_shared/assistant/itinerary.ts），解析在 _shared/sheetItinerary.ts。
-- 成員可以看、可以改（跟其他一般設定一樣，trips_update 的 RLS 決定誰能改）。
-- ============================================================

ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS itinerary_sheet TEXT;
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_itinerary_sheet_check;
ALTER TABLE app.trips ADD CONSTRAINT trips_itinerary_sheet_check
    CHECK (itinerary_sheet IS NULL OR itinerary_sheet ~ '^[A-Za-z0-9_-]{20,100}$');

GRANT SELECT (itinerary_sheet) ON app.trips TO authenticated;
GRANT UPDATE (itinerary_sheet) ON app.trips TO authenticated;

NOTIFY pgrst, 'reload schema';

-- 行程頁的色系與呈現方式（David 2026-11-28）：管理員以上才能改（trips_guard_update 擋）；值對應 src/features/itinerary/themes.ts
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS itinerary_color TEXT;
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS itinerary_style TEXT;
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_itinerary_look_check;
ALTER TABLE app.trips ADD CONSTRAINT trips_itinerary_look_check
    CHECK ((itinerary_color IS NULL OR itinerary_color ~ '^[a-z]{2,20}$') AND (itinerary_style IS NULL OR itinerary_style ~ '^[a-z]{2,20}$'));
GRANT SELECT (itinerary_color, itinerary_style) ON app.trips TO authenticated;
GRANT UPDATE (itinerary_color, itinerary_style) ON app.trips TO authenticated;

NOTIFY pgrst, 'reload schema';

