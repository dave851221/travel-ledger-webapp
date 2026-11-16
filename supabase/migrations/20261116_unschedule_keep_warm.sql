-- ============================================================
-- 關掉 line-webhook 保溫（20261116_keep_line_webhook_warm.sql）
--
-- 每 30 秒一次的 pg_cron + pg_net 會一直寫 cron.job_run_details 與 net._http_response，
-- 免費方案的 Disk IO 額度當天就快用完（Supabase 寄信警告），2026-11-16 依 David 指示關掉。
-- ⚠️ 不要再加高頻（分鐘級以下）的排程或寫入。
-- ============================================================

SELECT cron.unschedule('keep-line-webhook-warm')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'keep-line-webhook-warm');
