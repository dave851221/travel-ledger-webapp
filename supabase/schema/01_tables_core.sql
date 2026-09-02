-- ============================================================
-- 01_tables_core — 核心資料表：trips 與 expenses
-- ============================================================

-- 旅程
--   access_code：NULL 或全空白 = 該旅程免密碼（判斷一律用 btrim 後是否為空字串）
--   category   ：旅程本身的分組（首頁分組用），與 categories（支出分類）是不同概念
--   rates      ：{ 幣別: 對主幣別的匯率 }
--   precision_config：{ 幣別: 小數位數 }，例如 { "TWD": 0, "JPY": 0, "USD": 2 }
CREATE TABLE IF NOT EXISTS public.trips (
    id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                  TEXT        NOT NULL,
    access_code           TEXT,
    members               TEXT[]      NOT NULL,
    categories            TEXT[]      NOT NULL,
    category              TEXT,
    base_currency         TEXT        NOT NULL,
    rates                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
    precision_config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_archived           BOOLEAN     DEFAULT FALSE,
    default_currency      TEXT,
    default_category      TEXT,
    default_payer         TEXT[]      DEFAULT '{}',
    default_split_members TEXT[]      DEFAULT '{}',
    created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trips_category_idx ON public.trips (category);

-- 支出
--   payer_data / split_data：{ 成員名稱: 金額 }，key 是純字串顯示名稱而非 ID
--   adjustment_member      ：分帳除不盡時，餘數指派給誰
--   photo_urls             ：Storage 的「路徑」而非完整 URL，格式 expenses/{tripId}/{檔名}
--   deleted_at             ：軟刪除（垃圾桶保留 24 小時）
--   is_settlement          ：結清紀錄，統計時需特別處理
CREATE TABLE IF NOT EXISTS public.expenses (
    id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id           UUID        REFERENCES public.trips(id) ON DELETE CASCADE,
    date              DATE        NOT NULL DEFAULT CURRENT_DATE,
    category          TEXT        NOT NULL,
    description       TEXT        NOT NULL,
    amount            NUMERIC     NOT NULL,
    currency          TEXT        NOT NULL,
    payer_data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    split_data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    adjustment_member TEXT,
    photo_urls        TEXT[]      DEFAULT '{}',
    is_settlement     BOOLEAN     DEFAULT FALSE,
    deleted_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS expenses_trip_id_idx    ON public.expenses (trip_id);
CREATE INDEX IF NOT EXISTS expenses_deleted_at_idx ON public.expenses (deleted_at);

-- ── 既有資料庫相容 ────────────────────────────────────────────
-- 全新建立時以下皆為 no-op；若把 bootstrap 跑在舊資料庫上則會補正
ALTER TABLE public.trips ALTER COLUMN access_code DROP NOT NULL;

-- 空白密碼一律正規化為 NULL，避免出現兩種「無密碼」表示法
UPDATE public.trips SET access_code = NULL WHERE btrim(access_code) = '';
