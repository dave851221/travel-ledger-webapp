-- ============================================================
-- Travel Ledger Webapp — 核心資料庫初始化腳本
-- 全新架設時執行此檔案，已有資料庫的 ALTER TABLE 會透過
-- IF NOT EXISTS 安全地跳過重複欄位。
-- ============================================================

-- 1. 建立 Trips 表格
CREATE TABLE IF NOT EXISTS trips (
    id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                  TEXT        NOT NULL,
    access_code           TEXT,                   -- NULL 或空白 = 該旅程免密碼
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

-- 旅程分類（首頁分組用）
ALTER TABLE trips
    ADD COLUMN IF NOT EXISTS category TEXT;

-- ============================================================
-- 密碼驗證函式
-- access_code 為 NULL 或全空白時代表免密碼，驗證一律通過。
-- 詳見 supabase/migrations/20260902_optional_access_code.sql
-- ============================================================

ALTER TABLE trips ALTER COLUMN access_code DROP NOT NULL;

DROP FUNCTION IF EXISTS public.verify_trip_code(UUID, TEXT);

CREATE FUNCTION public.verify_trip_code(p_trip_id UUID, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT access_code INTO v_code FROM public.trips WHERE id = p_trip_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    IF btrim(coalesce(v_code, '')) = '' THEN
        RETURN TRUE;
    END IF;
    RETURN v_code = coalesce(p_code, '');
END;
$$;

DROP FUNCTION IF EXISTS public.trip_requires_code(UUID);

CREATE FUNCTION public.trip_requires_code(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT coalesce(
        (SELECT btrim(coalesce(access_code, '')) <> '' FROM public.trips WHERE id = p_trip_id),
        TRUE
    );
$$;

GRANT EXECUTE ON FUNCTION public.verify_trip_code(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_requires_code(UUID)     TO anon, authenticated;
