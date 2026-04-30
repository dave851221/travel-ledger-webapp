-- ============================================================
-- Travel Ledger Webapp — 核心資料庫初始化腳本
-- 全新架設時執行此檔案，已有資料庫的 ALTER TABLE 會透過
-- IF NOT EXISTS 安全地跳過重複欄位。
-- ============================================================

-- 1. 建立 Trips 表格
CREATE TABLE IF NOT EXISTS trips (
    id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                  TEXT        NOT NULL,
    access_code           TEXT        NOT NULL,
    members               TEXT[]      NOT NULL,
    categories            TEXT[]      NOT NULL,
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

-- 2. 建立 Expenses 表格
CREATE TABLE IF NOT EXISTS expenses (
    id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id           UUID        REFERENCES trips(id) ON DELETE CASCADE,
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

-- 3. 開啟 Real-time
ALTER PUBLICATION supabase_realtime ADD TABLE trips;
ALTER PUBLICATION supabase_realtime ADD TABLE expenses;

-- 4. 設定 RLS（Row Level Security）
ALTER TABLE trips    ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read/write on trips"    ON trips    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read/write on expenses" ON expenses FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 下方 ALTER TABLE 供「既有資料庫」補齊欄位，全新架設可略過
-- （IF NOT EXISTS 保證重複執行不會出錯）
-- ============================================================

ALTER TABLE trips
    ADD COLUMN IF NOT EXISTS default_currency      TEXT,
    ADD COLUMN IF NOT EXISTS default_category      TEXT,
    ADD COLUMN IF NOT EXISTS default_payer         TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS default_split_members TEXT[] DEFAULT '{}';

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
