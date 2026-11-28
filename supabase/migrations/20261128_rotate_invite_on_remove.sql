-- 移除成員時自動換邀請連結（見 supabase/app/schema/02_functions.sql）

-- 有人被移出旅程（不是自己離開）時自動換一個新的邀請連結，舊連結立刻失效：
-- 被移除的人手上的邀請連結不能再拿來加回來（David 2026-11-28）。
-- 自己離開、刪帳號、整趟刪除不換（旅程不在了就不用換）。
CREATE OR REPLACE FUNCTION app.rotate_invite_on_remove()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND OLD.user_id <> auth.uid() THEN
        UPDATE app.trips SET invite_token = app.random_token() WHERE id = OLD.trip_id;
    END IF;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app.rotate_invite_on_remove() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_rotate_invite_on_remove ON app.trip_members;
CREATE TRIGGER tr_app_rotate_invite_on_remove
    AFTER DELETE ON app.trip_members
    FOR EACH ROW EXECUTE FUNCTION app.rotate_invite_on_remove();
