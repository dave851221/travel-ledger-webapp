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
--   mention_required：群組觸發模式，true = 需 @提及或以「耀西」開頭才回應
CREATE TABLE IF NOT EXISTS public.line_user_states (
    line_user_id     TEXT PRIMARY KEY,
    current_trip_id  UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    pending_trip_id  UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    default_config   TEXT,
    mention_required BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at   TIMESTAMPTZ DEFAULT NOW(),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 對話紀錄。role 目前有四種用途：
--   'user' / 'model'：餵給 Gemini 的對話上下文
--   'pending'       ：Flex 卡片的 postback payload 側通道（繞過 300 bytes 限制）
--   'saved'         ：最近一筆存檔的支出 id，供「撤銷上一筆」使用
CREATE TABLE IF NOT EXISTS public.line_chat_history (
    id           BIGSERIAL PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES public.line_user_states(line_user_id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user_id ON public.line_chat_history (line_user_id);

-- 動作鎖：以 PK 衝突當作鎖，防止使用者連點 Flex 按鈕造成重複記帳
CREATE TABLE IF NOT EXISTS public.line_processed_actions (
    nonce        TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES public.line_user_states(line_user_id) ON DELETE CASCADE,
    action_type  TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
