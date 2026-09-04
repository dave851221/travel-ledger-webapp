-- ============================================================
-- 旅程時區（ROADMAP 的 M4）
--
-- LINE Bot 判斷「今天」時，以前是從幣別去猜時區（`getTripTimezone()`）：
-- 先看主幣別，再看 rates 裡的其他幣別。主幣 TWD 的日本旅程因此猜成
-- Asia/Taipei —— 日本時間 23:30 記帳，跨日那一小時內會記到前一天去（情境 F4）。
--
-- 幣別本來就不等於所在地：主幣別是「結算時折算成哪一種錢」，
-- 跟人在哪個時區沒有關係。所以改成明確存一個欄位。
--
-- NULL 代表沒設定，Edge Function 會退回舊的猜法（行為不變），
-- 使用者到網頁的「設定 → 基本設定」選一個時區就會生效。
-- ============================================================

ALTER TABLE public.trips
    ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN public.trips.timezone IS
    'IANA 時區字串（例如 Asia/Tokyo）。LINE Bot 判斷「今天」用的就是它；NULL 代表沿用從幣別推測的舊行為。';

-- 通知 PostgREST 重新載入 schema，讓前端立即看得到新欄位
NOTIFY pgrst, 'reload schema';
