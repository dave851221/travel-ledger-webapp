-- ============================================================
-- 首頁自訂排序（舊版）
--
-- 舊版沒有登入，大家看同一份旅程清單，所以整個網站只有一列（id = 1）：
--   layout = { "groups": [分組名稱…], "trips": { 分組名稱: [旅程 id…] } }，NULL = 預設排法。
-- 首頁按「完成」才 upsert 一次，平常只讀這一列（Supabase 免費方案 Disk IO）。
-- 開放版（app schema）不用這張表：每個人的順序存在自己帳號的 user_metadata。
-- 只新增一張表，不動任何既有資料。要撤掉：DROP TABLE public.home_layout;
-- ============================================================
CREATE TABLE IF NOT EXISTS public.home_layout (
    id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    layout     JSONB       CHECK (layout IS NULL OR octet_length(layout::text) <= 65536),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.home_layout ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read/write on home_layout" ON public.home_layout;
CREATE POLICY "Allow public read/write on home_layout"         ON public.home_layout
    FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.home_layout TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
