-- ============================================================
-- 群組的「靜音模式」
--
-- 群組原本有兩種模式（mention_required）：
--   提及模式（預設）：照片都處理，文字要 @耀西 或以「耀西」開頭
--   全回應模式      ：照片與文字全部處理
-- 新增第三種：
--   靜音模式        ：照片不處理，文字一樣要 @（mention_required 維持 TRUE）
-- 群組裡常常貼一堆風景照、截圖，每張都出一張卡片太吵，也會吃 AI 額度。
-- ============================================================

ALTER TABLE public.line_user_states
    ADD COLUMN IF NOT EXISTS photos_muted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.line_user_states.photos_muted IS
    '群組靜音模式：TRUE 時照片不下載、不辨識。只在 mention_required = TRUE 時有意義。';
