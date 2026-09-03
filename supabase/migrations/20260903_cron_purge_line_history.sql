-- ============================================================
-- 用 pg_cron 定期清理 LINE 的對話與動作紀錄
--
-- 原本是在 Edge Function 裡「每次 AI 對話有約 10% 機率順手清一次」，
-- 那個做法不可靠（沒人講話就不會清），而且會在使用者等回覆時多做 DB 寫入。
-- 改成每天固定跑一次。
--
-- 保留期間：
--   line_chat_history      14 天（AI 只讀最近 8 輪，留兩週已遠超所需）
--   line_processed_actions  7 天（nonce 防重複只需涵蓋按鈕還可能被點到的期間）
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

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
END;
$$;

-- 不是對外 API
REVOKE ALL ON FUNCTION public.purge_old_line_records() FROM PUBLIC, anon, authenticated;

-- 每天 03:17 UTC（台北 11:17）執行。重複套用這支 migration 不會產生重複排程。
DO $$
BEGIN
    PERFORM cron.unschedule('purge-line-records');
EXCEPTION WHEN OTHERS THEN
    NULL;  -- 還沒建立過就略過
END
$$;

SELECT cron.schedule(
    'purge-line-records',
    '17 3 * * *',
    $$SELECT public.purge_old_line_records();$$
);
