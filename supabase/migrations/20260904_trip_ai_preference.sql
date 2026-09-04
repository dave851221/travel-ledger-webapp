-- ============================================================
-- AI 記帳偏好搬到旅程層級
--
-- 原本偏好存在 line_user_states.default_config，範圍是「每個 LINE 綁定各一份」：
-- 同一趟旅程若有人在群組綁、有人一對一綁，偏好互不相通；網頁上完全看不到也改不了。
--
-- 改為 trips.ai_preference —— 一趟旅程只有一份，網頁設定頁、LIFF 偏好頁、
-- LINE 的「設定:」文字指令編輯的都是同一個欄位。
--
-- line_user_states.default_config 保留不刪（舊資料的來源），程式不再讀寫。
-- ============================================================

-- 1. 新欄位
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS ai_preference TEXT;

COMMENT ON COLUMN public.trips.ai_preference IS
    'LINE Bot 解析自然語言與收據時參考的自由文字偏好，整趟旅程共用一份。空字串一律存成 NULL。';

-- 2. 把舊的 default_config 搬過來
--    同一趟旅程可能有多個 LINE 綁定（群組一份、一對一一份）且內容不同，
--    取 last_active_at 最新的那一筆：它有 DEFAULT NOW() 且程式從未更新過，等同建立時間。
--    （線上資料庫的 line_user_states 沒有 created_at 欄位，與 schema/02_tables_line.sql 有出入。）
UPDATE public.trips t
SET ai_preference = s.default_config
FROM (
    SELECT DISTINCT ON (current_trip_id)
        current_trip_id,
        default_config
    FROM public.line_user_states
    WHERE current_trip_id IS NOT NULL
      AND btrim(coalesce(default_config, '')) <> ''
    ORDER BY current_trip_id, last_active_at DESC NULLS LAST, line_user_id
) AS s
WHERE t.id = s.current_trip_id
  AND t.ai_preference IS NULL;

-- 3. 空白內容一律正規化為 NULL，避免出現兩種「沒有偏好」的表示法
UPDATE public.trips SET ai_preference = NULL WHERE btrim(ai_preference) = '';

-- 4. 通知 PostgREST 重新載入 schema，讓前端立即看得到新欄位
NOTIFY pgrst, 'reload schema';
