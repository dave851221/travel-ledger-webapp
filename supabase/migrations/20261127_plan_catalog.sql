-- 升級視窗顯示方案上限用的 app.plan_catalog()（內容與 09_admin.sql 相同）。只新增函式。

CREATE OR REPLACE FUNCTION app.plan_catalog()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(jsonb_object_agg(plan, jsonb_build_object(
        'max_entries', max_entries, 'max_ai_calls', max_ai_calls, 'max_photos', max_photos)), '{}'::jsonb)
    FROM app.plan_limits;
$$;
REVOKE ALL ON FUNCTION app.plan_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.plan_catalog() TO authenticated;
