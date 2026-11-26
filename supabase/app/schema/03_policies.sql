-- ============================================================
-- app/03_policies — Row Level Security（預設拒絕）
--
-- 沒有寫政策的動作 = 誰都不能做。service_role（Edge Function）繞過 RLS，
-- 所以 Edge Function 必須自己檢查身分，見 docs/SECURITY.md 第 3 條。
-- ============================================================

ALTER TABLE app.profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trips        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trip_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.expenses     ENABLE ROW LEVEL SECURITY;

-- ── profiles：只有自己 ─────────────────────────────────────────
DROP POLICY IF EXISTS profiles_self ON app.profiles;
CREATE POLICY profiles_self ON app.profiles
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ── trips：成員可看、可改一般設定；owner 才能刪 ────────────────
-- 建立只能走 app.create_trip（沒有 INSERT 權限）；
-- 哪些欄位能改由 01_tables 的欄位級權限決定。
DROP POLICY IF EXISTS trips_select ON app.trips;
CREATE POLICY trips_select ON app.trips
    FOR SELECT TO authenticated
    USING (app.is_member(id));

DROP POLICY IF EXISTS trips_update ON app.trips;
CREATE POLICY trips_update ON app.trips
    FOR UPDATE TO authenticated
    USING (app.is_member(id))
    WITH CHECK (app.is_member(id));

DROP POLICY IF EXISTS trips_delete ON app.trips;
CREATE POLICY trips_delete ON app.trips
    FOR DELETE TO authenticated
    USING (app.is_owner(id));

-- ── trip_members：看得到同一趟的其他成員；自己可以離開，owner 可以移除別人 ──
-- 加入只能走 accept_invite／create_trip；改名字只能走 set_my_member／update_trip_members。
DROP POLICY IF EXISTS trip_members_select ON app.trip_members;
CREATE POLICY trip_members_select ON app.trip_members
    FOR SELECT TO authenticated
    USING (app.is_member(trip_id));

DROP POLICY IF EXISTS trip_members_delete ON app.trip_members;
CREATE POLICY trip_members_delete ON app.trip_members
    FOR DELETE TO authenticated
    USING (user_id = auth.uid() OR app.is_owner(trip_id));

-- ── expenses：成員可讀寫 ───────────────────────────────────────
DROP POLICY IF EXISTS expenses_member ON app.expenses;
CREATE POLICY expenses_member ON app.expenses
    FOR ALL TO authenticated
    USING (app.is_member(trip_id))
    WITH CHECK (app.is_member(trip_id));

-- ── 即時同步 ───────────────────────────────────────────────────
-- Realtime 的 postgres_changes 會套用 RLS：使用者只收得到自己是成員的旅程的變動
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime' AND schemaname = 'app' AND tablename = 'trips') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE app.trips;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime' AND schemaname = 'app' AND tablename = 'expenses') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE app.expenses;
        END IF;
    END IF;
END;
$$;
