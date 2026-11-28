-- 2026-11-28 LINE 登入加速：auth-line 一趟往返查出使用者與 email（取代 select → update → getUserById）
-- LINE 登入（auth-line）：一趟資料庫往返找出 LINE 帳號對應的使用者與登入用 email，順便記登入時間與 LINE 名稱。
-- 以前是 select → update → admin.getUserById 三趟（Edge Function 在東京、資料庫在雪梨，每趟都要好幾百毫秒）。
-- 沒有對應時回 NULL（第一次登入，由 auth-line 建使用者）。
CREATE OR REPLACE FUNCTION app.line_login_lookup(p_line_user_id TEXT, p_display_name TEXT)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH li AS (
        UPDATE app.line_identities
           SET last_login_at = now(),
               display_name = coalesce(p_display_name, display_name)
         WHERE line_user_id = p_line_user_id
        RETURNING user_id
    )
    SELECT jsonb_build_object('user_id', u.id, 'email', u.email)
      FROM li JOIN auth.users u ON u.id = li.user_id;
$$;
REVOKE ALL ON FUNCTION app.line_login_lookup(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.line_login_lookup(TEXT, TEXT) TO service_role;