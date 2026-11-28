-- RLS 政策裡的 auth.uid() 包成 (SELECT auth.uid())，每個查詢只算一次（Supabase performance advisor: auth_rls_initplan）
-- 行為不變，只是查很多列時不必每列重算。

DROP POLICY IF EXISTS line_identities_self ON app.line_identities;
CREATE POLICY line_identities_self ON app.line_identities
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS profiles_self ON app.profiles;
CREATE POLICY profiles_self ON app.profiles
    FOR ALL TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS trip_members_delete ON app.trip_members;
CREATE POLICY trip_members_delete ON app.trip_members
    FOR DELETE TO authenticated
    USING (user_id = (SELECT auth.uid()) OR app.is_owner(trip_id) OR (app.is_admin(trip_id) AND role = 'editor'));
