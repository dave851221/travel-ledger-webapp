-- ============================================================
-- 綁定流程的逾時與狀態修正（ROADMAP 的 M1）
--
-- 原本的行為：使用者一輸入 `ID:代碼`，current_trip_id 當下就被清空，
-- 只留 pending_trip_id 等密碼。於是
--   - 打錯代碼或改變主意 → 變成完全沒綁定，而且沒有任何指令可以退回去
--   - 群組裡等密碼期間，每個人講的每一句話都被當成密碼，一律回「密碼錯誤」
--   - 沒有逾時，這個狀態會一直卡著
--
-- 改法（Edge Function 端）：
--   - 輸入 ID 時**不動** current_trip_id，密碼驗證成功才切換
--     （因此 current_trip_id 與 pending_trip_id 現在可以同時有值 = 切換中）
--   - 新增「取消綁定」／「放棄綁定」指令
--   - 等待超過 10 分鐘自動放棄 —— 需要這裡新增的 pending_at
--
-- 這支 migration 只負責欄位。
-- ============================================================

-- 1. 進入「等待通行碼」狀態的時間戳。
--    NULL 代表沒有在等待，或是舊資料（程式一律把 NULL 視為已過期）。
ALTER TABLE public.line_user_states
    ADD COLUMN IF NOT EXISTS pending_at TIMESTAMPTZ;

COMMENT ON COLUMN public.line_user_states.pending_at IS
    '進入等待通行碼狀態的時間。超過 10 分鐘由 line-webhook 自動清掉 pending_trip_id。';

-- 2. 補上 created_at。
--    線上資料庫的這張表沒有這個欄位，與 supabase/schema/02_tables_line.sql 有出入
--    （20260904_trip_ai_preference.sql 的註解已記錄過這件事）。
--    這裡把漂移補回來，讓 bootstrap 建出來的與線上一致。
--    ⚠️ 既有的列會拿到 NOW()，那不是真正的建立時間 —— 目前沒有程式讀它。
ALTER TABLE public.line_user_states
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 3. 既有的等待狀態沒有 pending_at，會被視為過期而自動放棄。
--    這是刻意的：那些狀態本來就已經卡在那裡不知道多久了。

-- 4. 通知 PostgREST 重新載入 schema
NOTIFY pgrst, 'reload schema';
