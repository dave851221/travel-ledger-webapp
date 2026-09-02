-- ============================================================
-- 記錄每則對話與每筆存檔的實際發言者
--
-- line_user_states 以 sourceId（群組為 groupId）為主鍵，
-- 群組成員共用同一份綁定與偏好 —— 這是刻意的設計，讓群組內任何人
-- 都能對同一本帳記帳、查詢與撤銷。
-- 但「誰做的」原本完全沒有留下，Flex 卡片與撤銷訊息都看不出是誰。
-- ============================================================

ALTER TABLE public.line_chat_history
    ADD COLUMN IF NOT EXISTS speaker_user_id TEXT,
    ADD COLUMN IF NOT EXISTS speaker_name    TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_history_speaker
    ON public.line_chat_history (speaker_user_id);
