-- ============================================================
-- app/00_base — 開放版（旅行小本本）的 schema 與基礎函式
--
-- 舊版（旅遊小本本）在 public，完全不碰；兩版共用同一個 Supabase 專案。
-- 開放版的原則：每張表都開 RLS、預設拒絕；權限只在資料庫與 Edge Function 判斷。
-- 詳見 docs/SECURITY.md。
-- ============================================================

CREATE SCHEMA IF NOT EXISTS app;

-- PostgREST 透過 anon / authenticated 角色存取；service_role 給 Edge Function。
GRANT USAGE ON SCHEMA app TO anon, authenticated, service_role;

-- 之後在 app 裡新增的函式，預設不給任何人執行，要用的再逐一 GRANT
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 分享／邀請連結用的隨機字串：24 bytes → 32 個 URL 安全字元
CREATE OR REPLACE FUNCTION app.random_token()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
    SELECT translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
$$;

REVOKE ALL ON FUNCTION app.random_token() FROM PUBLIC, anon, authenticated;
