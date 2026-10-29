-- ============================================================
-- 群組裡的來回對話：引用回覆與「接話」
--
-- 提及模式下，群組成員原本每一句都要 @耀西 或以「耀西」開頭。改成：
--   1. 對機器人的訊息按 LINE 的「回覆」也算在跟它講話
--      → 要記下機器人送出的訊息 id，才認得出被引用的是不是它（line_bot_messages）
--   2. 機器人剛回覆過的那個人，3 分鐘內的下一句話不必 @
--      → line_user_states 記住是誰、到什麼時候（followup_*）
-- ============================================================

-- 1. 機器人送出的訊息 id（只記群組與聊天室）
CREATE TABLE IF NOT EXISTS public.line_bot_messages (
    message_id   TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_bot_messages_created_at ON public.line_bot_messages (created_at);

-- 只有 Edge Function（service role）讀寫，刻意不建任何政策
ALTER TABLE public.line_bot_messages ENABLE ROW LEVEL SECURITY;

-- 2. 接話的對象與期限
ALTER TABLE public.line_user_states
    ADD COLUMN IF NOT EXISTS followup_user_id TEXT,
    ADD COLUMN IF NOT EXISTS followup_until   TIMESTAMPTZ;

COMMENT ON COLUMN public.line_user_states.followup_user_id IS
    '群組裡機器人剛回覆過的人（LINE userId）。followup_until 之前他的下一句話不必 @ 也會處理。';

-- 3. 每天的清理一併清掉 7 天前的訊息 id（原本的排程見 20260903_cron_purge_line_history.sql）
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
END;
$$;

REVOKE ALL ON FUNCTION public.purge_old_line_records() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
