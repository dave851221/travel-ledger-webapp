-- =============================================================================
-- Travel Ledger WebApp — 完整資料庫初始化腳本
--
-- ⚠️ 自動產生，請勿手動編輯。
--    來源：supabase/schema/NN_*.sql
--    重新產生：npm run db:build
--
-- 用途：全新架設時，把整份貼進 Supabase SQL Editor 執行一次即可。
--       已在運作的資料庫請改走 supabase/migrations/。
--       兩者的關係見 docs/SETUP.md。
--
-- 本腳本可重複執行（idempotent）。
-- =============================================================================

-- <<<<<<<<<< 00_extensions.sql <<<<<<<<<<

-- ============================================================
-- 00_extensions — 必要的 Postgres 擴充套件
-- ============================================================

-- uuid_generate_v4()：trips.id 與 expenses.id 的預設值需要它
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- <<<<<<<<<< 01_tables_core.sql <<<<<<<<<<

-- ============================================================
-- 01_tables_core — 核心資料表：trips 與 expenses
-- ============================================================

-- 旅程
--   access_code：NULL 或全空白 = 該旅程免密碼（判斷一律用 btrim 後是否為空字串）
--   category   ：旅程本身的分組（首頁分組用），與 categories（支出分類）是不同概念
--   rates      ：{ 幣別: 對主幣別的匯率 }
--   precision_config：{ 幣別: 小數位數 }，例如 { "TWD": 0, "JPY": 0, "USD": 2 }
--   ai_preference   ：LINE Bot 解析自然語言與收據時參考的自由文字偏好。
--                     整趟旅程共用一份（不分 LINE 綁定、不分管道），網頁設定頁與
--                     LIFF 偏好頁編輯的都是這個欄位。空字串一律存成 NULL。
--   timezone   ：IANA 時區字串（例如 Asia/Tokyo）。LINE Bot 判斷「今天」用的就是它。
--                NULL 代表沒設，Bot 會退回舊的「從幣別猜」邏輯（主幣 TWD 的日本旅程
--                因此會猜成台北時間 —— 那正是加這個欄位的原因，見 ROADMAP 的 M4）。
CREATE TABLE IF NOT EXISTS public.trips (
    id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                  TEXT        NOT NULL,
    access_code           TEXT,
    ai_preference         TEXT,
    members               TEXT[]      NOT NULL,
    categories            TEXT[]      NOT NULL,
    category              TEXT,
    base_currency         TEXT        NOT NULL,
    timezone              TEXT,
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
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS ai_preference TEXT;

-- 空白密碼一律正規化為 NULL，避免出現兩種「無密碼」表示法
UPDATE public.trips SET access_code = NULL WHERE btrim(access_code) = '';


-- <<<<<<<<<< 02_tables_line.sql <<<<<<<<<<

-- ============================================================
-- 02_tables_line — LINE Bot 整合所需資料表
-- ============================================================

-- 旅程 ↔ 6 位短碼對應。短碼由 trigger 於 trips INSERT 時自動產生（見 04_triggers）
CREATE TABLE IF NOT EXISTS public.line_trip_id_mapping (
    trip_id    UUID PRIMARY KEY REFERENCES public.trips(id) ON DELETE CASCADE,
    linebot_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- LINE 端的對話狀態
--   line_user_id：實際存的是 sourceId（群組為 groupId、聊天室為 roomId、一對一為 userId）
--                 因此「群組內所有人共用同一份狀態」是刻意的設計 —— 群組成員都能操作同一本帳
--   current_trip_id：已綁定的旅程；pending_trip_id：等待輸入通行碼中
--     ⚠️ 兩者可以同時有值 —— 那是「已綁定 A，正在切換到 B」。
--        驗證成功才會把 current 換掉，中途放棄不會變成沒綁定（M1）。
--   pending_at：進入等待通行碼狀態的時間，超過 10 分鐘由 Edge Function 自動放棄
--   mention_required：群組觸發模式，true = 需 @提及或以「耀西」開頭才回應
--   last_active_at：每次收到事件時由 Edge Function 背景更新
CREATE TABLE IF NOT EXISTS public.line_user_states (
    line_user_id     TEXT PRIMARY KEY,
    current_trip_id  UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    pending_trip_id  UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    pending_at       TIMESTAMPTZ,
    default_config   TEXT,
    mention_required BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at   TIMESTAMPTZ DEFAULT NOW(),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 對話紀錄。role 目前有四種用途：
--   'user' / 'model'：餵給 Gemini 的對話上下文
--   'pending'       ：Flex 卡片的 postback payload 側通道（繞過 300 bytes 限制）
--   'saved'         ：最近一筆存檔的支出 id，供「撤銷上一筆」使用
--   speaker_* 記錄實際發言者。群組共用同一份狀態是刻意的設計，
--   但每次互動仍要看得出是誰做的（Flex 卡片、撤銷訊息都會顯示）。
CREATE TABLE IF NOT EXISTS public.line_chat_history (
    id              BIGSERIAL PRIMARY KEY,
    line_user_id    TEXT NOT NULL REFERENCES public.line_user_states(line_user_id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    speaker_user_id TEXT,
    speaker_name    TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user_id ON public.line_chat_history (line_user_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_speaker ON public.line_chat_history (speaker_user_id);

-- 動作鎖：以 PK 衝突當作鎖，防止使用者連點 Flex 按鈕造成重複記帳
CREATE TABLE IF NOT EXISTS public.line_processed_actions (
    nonce        TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES public.line_user_states(line_user_id) ON DELETE CASCADE,
    action_type  TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);


-- <<<<<<<<<< 03_functions.sql <<<<<<<<<<

-- ============================================================
-- 03_functions — 資料庫函式
-- ============================================================

-- 通行碼驗證（SECURITY DEFINER：讓 access_code 不必離開資料庫）
-- access_code 為 NULL 或全空白代表免密碼，一律回傳 TRUE
DROP FUNCTION IF EXISTS public.verify_trip_code(UUID, TEXT);
DROP FUNCTION IF EXISTS public.verify_trip_code(TEXT, TEXT);  -- 早期版本的簽章

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

-- 這個旅程需不需要輸入通行碼？供 TripPortal 決定是否顯示密碼欄
-- 查無此旅程時回傳 TRUE（fail closed）
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

-- 產生 6 位短碼，字元集排除容易混淆的 0/1/I/O
CREATE OR REPLACE FUNCTION public.generate_linebot_id()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    chars  TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result TEXT := '';
    i      INTEGER := 0;
BEGIN
    FOR i IN 1..6 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$;

-- 新旅程建立時自動配一組短碼。
-- 必須是 SECURITY DEFINER：line_trip_id_mapping 有 RLS，
-- 以呼叫者權限寫入會失敗（這是踩過的坑，見 CLAUDE.md）
CREATE OR REPLACE FUNCTION public.trigger_generate_line_mapping()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.line_trip_id_mapping (trip_id, linebot_id)
    VALUES (NEW.id, public.generate_linebot_id())
    ON CONFLICT (trip_id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- 這兩支只給 trips 的 INSERT trigger 內部使用，不是對外 API，
-- 撤銷 PostgREST 會用到的角色的執行權限，避免被當成 RPC 呼叫。
-- PostgreSQL 在觸發器觸發時不檢查 EXECUTE 權限，因此不影響自動配發短碼。
REVOKE ALL ON FUNCTION public.generate_linebot_id()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_generate_line_mapping() FROM PUBLIC, anon, authenticated;

-- 通知 PostgREST 重新載入 schema，讓新建立/變更的 RPC 立即可用
NOTIFY pgrst, 'reload schema';


-- <<<<<<<<<< 04_triggers.sql <<<<<<<<<<

-- ============================================================
-- 04_triggers — 觸發器
-- ============================================================

DROP TRIGGER IF EXISTS tr_generate_line_mapping ON public.trips;

CREATE TRIGGER tr_generate_line_mapping
AFTER INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.trigger_generate_line_mapping();

-- 為既有旅程補上短碼（全新資料庫時這段不會有任何動作）
INSERT INTO public.line_trip_id_mapping (trip_id, linebot_id)
SELECT id, public.generate_linebot_id() FROM public.trips
ON CONFLICT (trip_id) DO NOTHING;


-- <<<<<<<<<< 05_policies.sql <<<<<<<<<<

-- ============================================================
-- 05_policies — Row Level Security
--
-- ⚠️ 目前所有政策皆為完全開放（FOR ALL USING (true)）。
--    本專案沒有使用 Supabase Auth，旅程通行碼只是前端的門面，
--    任何持有 anon key 且知道 trip UUID 的人都能讀寫全部資料。
--    僅適合高度信任的親友圈使用。收斂計畫見 docs/ROADMAP.md。
--    政策集中在這個檔案，未來要收緊時只需改這裡。
-- ============================================================

ALTER TABLE public.trips                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_trip_id_mapping   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_user_states       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_chat_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_processed_actions ENABLE ROW LEVEL SECURITY;

-- 政策名稱與既有資料庫保持一致，重複執行不會產生重複政策
DROP POLICY IF EXISTS "Allow public read/write on trips"    ON public.trips;
CREATE POLICY "Allow public read/write on trips"            ON public.trips
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public read/write on expenses" ON public.expenses;
CREATE POLICY "Allow public read/write on expenses"         ON public.expenses
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public all on mapping"         ON public.line_trip_id_mapping;
CREATE POLICY "Allow public all on mapping"                 ON public.line_trip_id_mapping
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public all on user_states"     ON public.line_user_states;
CREATE POLICY "Allow public all on user_states"             ON public.line_user_states
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public all on chat_history"    ON public.line_chat_history;
CREATE POLICY "Allow public all on chat_history"            ON public.line_chat_history
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all on processed_actions"      ON public.line_processed_actions;
CREATE POLICY "Allow all on processed_actions"              ON public.line_processed_actions
    FOR ALL USING (true) WITH CHECK (true);


-- <<<<<<<<<< 06_realtime.sql <<<<<<<<<<

-- ============================================================
-- 06_realtime — 即時同步發布
-- Dashboard 訂閱 expenses 與 trips 的變更
-- ============================================================

-- ALTER PUBLICATION ... ADD TABLE 對已加入的表會報錯，因此先檢查
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trips'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.trips;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'expenses'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;
    END IF;
END
$$;


-- <<<<<<<<<< 07_storage.sql <<<<<<<<<<

-- ============================================================
-- 07_storage — 收據照片儲存空間
--
-- bucket：travel-images（public）
-- 路徑慣例：expenses/{tripId}/{檔名}
--   前端上傳見 ExpenseModal，LINE Bot 上傳見 line-webhook。
--   supabase/scripts/delete_trip.sql 依賴這個前綴來清理照片，勿隨意更動。
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('travel-images', 'travel-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 與資料表一致的開放政策（見 05_policies 的安全性說明）
DROP POLICY IF EXISTS "Public read on travel-images"   ON storage.objects;
CREATE POLICY "Public read on travel-images"           ON storage.objects
    FOR SELECT USING (bucket_id = 'travel-images');

DROP POLICY IF EXISTS "Public insert on travel-images" ON storage.objects;
CREATE POLICY "Public insert on travel-images"         ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'travel-images');

DROP POLICY IF EXISTS "Public update on travel-images" ON storage.objects;
CREATE POLICY "Public update on travel-images"         ON storage.objects
    FOR UPDATE USING (bucket_id = 'travel-images');

DROP POLICY IF EXISTS "Public delete on travel-images" ON storage.objects;
CREATE POLICY "Public delete on travel-images"         ON storage.objects
    FOR DELETE USING (bucket_id = 'travel-images');

