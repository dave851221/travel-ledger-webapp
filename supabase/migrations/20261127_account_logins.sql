-- 成員清單顯示登入方式（LINE／Google 名稱、遮過的 email），與「我的帳號」的登入方式清單。
-- 內容與 supabase/app/schema/02_functions.sql 相同；只新增函式，不動資料。

-- ── 帳號資訊（David 2026-11-27：成員清單要看得出誰是誰、用什麼登入）────────
-- 遮掉 email 的中間：d***1@gmail.com。成員彼此只看得到這個，不給完整 email、不給 LINE userId
CREATE OR REPLACE FUNCTION app.mask_email(p_email TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_email IS NULL OR position('@' IN p_email) < 2 THEN NULL
        WHEN position('@' IN p_email) <= 3 THEN left(p_email, 1) || '***' || substr(p_email, position('@' IN p_email))
        ELSE left(p_email, 1) || '***' || substr(p_email, position('@' IN p_email) - 1)
    END;
$$;

REVOKE ALL ON FUNCTION app.mask_email(TEXT) FROM PUBLIC, anon, authenticated;

-- 一個帳號的登入方式與顯示用的名字：
--   line   → app.line_identities（顯示 LINE 名稱）
--   google → auth.identities（顯示 Google 名稱與遮過的 email）
-- LINE 帳號在 auth 裡的 email 是 line-…@line.users.invalid（產生登入 token 用的），不顯示
CREATE OR REPLACE FUNCTION app.account_logins(p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'provider'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('provider', 'line', 'name', li.display_name) AS x
        FROM app.line_identities li WHERE li.user_id = p_user_id
        UNION ALL
        SELECT jsonb_build_object(
            'provider', 'google',
            'name', coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'name'),
            'account', app.mask_email(i.identity_data ->> 'email'))
        FROM auth.identities i WHERE i.user_id = p_user_id AND i.provider = 'google'
    ) s;
$$;

REVOKE ALL ON FUNCTION app.account_logins(UUID) FROM PUBLIC, anon, authenticated;

-- 這趟旅程登入的成員（成員才能看）：名字、角色、登入方式
CREATE OR REPLACE FUNCTION app.trip_member_accounts(p_trip_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT app.is_member(p_trip_id) THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '42501';
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'user_id', tm.user_id,
            'member_name', tm.member_name,
            'role', tm.role,
            'logins', app.account_logins(tm.user_id)
        ) ORDER BY tm.joined_at)
        FROM app.trip_members tm WHERE tm.trip_id = p_trip_id
    ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION app.trip_member_accounts(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.trip_member_accounts(UUID) TO authenticated;

-- 我自己的帳號連了哪些登入方式（「我的帳號」頁用）
CREATE OR REPLACE FUNCTION app.my_logins()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    RETURN app.account_logins(auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION app.my_logins() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_logins() TO authenticated;

NOTIFY pgrst, 'reload schema';
