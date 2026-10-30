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
--   followup_user_id / followup_until：群組「接話」—— 機器人剛回覆過的那個人，
--     在 followup_until 之前的下一句話不必 @ 也會處理（只有提及模式有作用）
CREATE TABLE IF NOT EXISTS public.line_user_states (
    line_user_id     TEXT PRIMARY KEY,
    current_trip_id  UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    pending_trip_id  UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    pending_at       TIMESTAMPTZ,
    default_config   TEXT,
    mention_required BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at   TIMESTAMPTZ DEFAULT NOW(),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    followup_user_id TEXT,
    followup_until   TIMESTAMPTZ
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

-- 機器人在群組／聊天室送出的訊息 id。
-- 使用者在 LINE 對某則訊息按「回覆」時 webhook 會帶 quotedMessageId，
-- 對得上這張表就代表是在回機器人，不必再 @。由 pg_cron 每天清掉 7 天前的。
CREATE TABLE IF NOT EXISTS public.line_bot_messages (
    message_id   TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_bot_messages_created_at ON public.line_bot_messages (created_at);

-- webhook 事件去重：LINE 重送同一個事件（webhookEventId 相同）時只處理第一份。
-- 由 pg_cron 每天清掉 2 天前的。
CREATE TABLE IF NOT EXISTS public.line_webhook_events (
    event_id   TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 動作鎖：以 PK 衝突當作鎖，防止使用者連點 Flex 按鈕造成重複記帳
CREATE TABLE IF NOT EXISTS public.line_processed_actions (
    nonce        TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES public.line_user_states(line_user_id) ON DELETE CASCADE,
    action_type  TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
