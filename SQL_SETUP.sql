-- 1. 建立 Trips 表格
CREATE TABLE trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    access_code TEXT NOT NULL,
    members TEXT[] NOT NULL,
    categories TEXT[] NOT NULL,
    base_currency TEXT NOT NULL,
    rates JSONB NOT NULL DEFAULT '{}'::jsonb,
    precision_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_archived BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 建立 Expenses 表格
CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL,
    payer_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    split_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    adjustment_member TEXT,
    photo_urls TEXT[] DEFAULT '{}',
    is_settlement BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ
);

-- 3. 開啟 Real-time (選擇性，之後會用到)
ALTER PUBLICATION supabase_realtime ADD TABLE trips;
ALTER PUBLICATION supabase_realtime ADD TABLE expenses;

-- 4. 設定權限 (暫時設為所有人可讀寫，實務上可根據需求調整 RLS)
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read/write on trips" ON trips FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read/write on expenses" ON expenses FOR ALL USING (true) WITH CHECK (true);
