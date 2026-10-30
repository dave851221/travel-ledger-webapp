-- ============================================================
-- LINE webhook 事件去重
--
-- LINE 在 webhook 沒有及時回 200 時會重送同一個事件（Console 開了「重新傳送」時），
-- 每個事件都帶唯一的 webhookEventId。機器人一則訊息要跑 AI、OCR，常常超過 LINE 的等待時間，
-- 重送進來的那一份會再處理一次 —— 同一句話被回兩次、記帳卡出兩張。
-- Edge Function 處理事件前先寫入這張表，PK 衝突就代表處理過了，直接略過。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.line_webhook_events (
    event_id   TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 只有 Edge Function（service role）讀寫，刻意不建任何政策
ALTER TABLE public.line_webhook_events ENABLE ROW LEVEL SECURITY;

-- 每天的清理一併清掉 2 天前的事件 id（LINE 只在短時間內重送）
CREATE OR REPLACE FUNCTION public.purge_old_line_records()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.line_chat_history
    WHERE created_at < NOW() - INTERVAL '14 days';

    DELETE FROM public.line_processed_actions
    WHERE created_at < NOW() - INTERVAL '7 days';

    DELETE FROM public.line_bot_messages
    WHERE created_at < NOW() - INTERVAL '7 days';

    DELETE FROM public.line_webhook_events
    WHERE created_at < NOW() - INTERVAL '2 days';
END;
$$;

REVOKE ALL ON FUNCTION public.purge_old_line_records() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
