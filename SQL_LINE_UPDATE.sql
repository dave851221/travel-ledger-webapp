-- LINE Bot 整合所需資料表與邏輯

-- 1. 建立對應表
CREATE TABLE IF NOT EXISTS line_trip_id_mapping (
    trip_id UUID PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
    linebot_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 建立 LINE 使用者狀態表
CREATE TABLE IF NOT EXISTS line_user_states (
    line_user_id TEXT PRIMARY KEY,
    current_trip_id UUID REFERENCES trips(id) ON DELETE SET NULL,
    pending_trip_id UUID REFERENCES trips(id) ON DELETE SET NULL, -- 用於密碼驗證中
    default_config TEXT,
    last_active_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 自動生成 6 位隨機碼的 Function
CREATE OR REPLACE FUNCTION generate_linebot_id() RETURNS TEXT AS $$
DECLARE
    chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 排除容易混淆的字元 (0, 1, I, O)
    result TEXT := '';
    i INTEGER := 0;
BEGIN
    FOR i IN 1..6 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- 4. 建立 Trigger Function
CREATE OR REPLACE FUNCTION trigger_generate_line_mapping()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO line_trip_id_mapping (trip_id, linebot_id)
    VALUES (NEW.id, generate_linebot_id())
    ON CONFLICT (trip_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. 綁定 Trigger 到 trips 表
DROP TRIGGER IF EXISTS tr_generate_line_mapping ON trips;
CREATE TRIGGER tr_generate_line_mapping
AFTER INSERT ON trips
FOR EACH ROW EXECUTE FUNCTION trigger_generate_line_mapping();

-- 6. 為現有旅程補上 ID (Initial Migration)
INSERT INTO line_trip_id_mapping (trip_id, linebot_id)
SELECT id, generate_linebot_id() FROM trips
ON CONFLICT (trip_id) DO NOTHING;

-- 7. 開啟 RLS (Row Level Security)
ALTER TABLE line_trip_id_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_user_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on mapping" ON line_trip_id_mapping FOR SELECT USING (true);
CREATE POLICY "Allow public all on user_states" ON line_user_states FOR ALL USING (true) WITH CHECK (true);
