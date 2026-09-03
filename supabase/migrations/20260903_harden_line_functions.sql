-- ============================================================
-- 收斂兩支 LINE 短碼相關函式的權限
--
-- Supabase 的 database linter 指出：
--   1. 兩支函式沒有固定 search_path（0011_function_search_path_mutable）
--   2. 它們被暴露成 /rest/v1/rpc/ 端點，anon 就能呼叫
--      （0028/0029_*_security_definer_function_executable）
--
-- 這兩支都只該由 trips 的 INSERT trigger 內部使用，不是對外 API。
-- 注意：PostgreSQL 在觸發器實際觸發時**不會**檢查 EXECUTE 權限，
-- 因此撤銷授權不影響建立旅程時自動配發短碼。
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_linebot_id()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    chars  TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result TEXT := '';
    i      INTEGER := 0;
BEGIN
    FOR i IN 1..6 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_generate_line_mapping()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.line_trip_id_mapping (trip_id, linebot_id)
    VALUES (NEW.id, public.generate_linebot_id())
    ON CONFLICT (trip_id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- 這兩支不是對外 API，撤銷 PostgREST 會用到的角色的執行權限。
-- 函式擁有者仍保有權限，所以 SECURITY DEFINER 的內部呼叫不受影響。
REVOKE ALL ON FUNCTION public.generate_linebot_id()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_generate_line_mapping() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
