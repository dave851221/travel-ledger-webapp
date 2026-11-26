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

GRANT SELECT (id, name, members, categories, category, base_currency, timezone, rates, precision_config,
              is_archived, default_currency, default_category, default_payer, default_split_members,
              ai_preference, visibility, share_token, invite_token, created_by, created_at)
    ON app.trips TO authenticated;
GRANT UPDATE (name, categories, category, base_currency, timezone, rates, precision_config,
              is_archived, default_currency, default_category, default_payer, default_split_members,
              ai_preference)
    ON app.trips TO authenticated;
-- members（成員清單）不在 UPDATE 裡：改名要連同所有支出一起改，一律走 RPC
GRANT DELETE ON app.trips TO authenticated;

GRANT SELECT, DELETE ON app.trip_members TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.expenses TO authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA app TO service_role;
