-- ============================================================
-- line-webhook 保溫
--
-- Edge Function 的 worker 閒置約一分鐘就關掉，LINE 卡片上的按鈕因此幾乎每次都冷啟動：
-- 新 worker 連資料庫、LINE API 都要重新握手，每按一次多等 0.5～1 秒。
-- 每 30 秒 GET 一次（index.ts 開頭的保溫分支，只做兩個最輕的查詢），worker 與連線就一直是熱的。
-- 一個月約 8.6 萬次呼叫，在免費額度（50 萬）內。
--
-- ⚠️ 網址寫死成正式專案；別的環境套這支 migration 要換成自己的專案網址。
-- 不想要了：SELECT cron.unschedule('keep-line-webhook-warm');
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
    'keep-line-webhook-warm',
    '30 seconds',
    $$ SELECT net.http_get('https://cdrjtthstteyruqmyrss.supabase.co/functions/v1/line-webhook') $$
);
