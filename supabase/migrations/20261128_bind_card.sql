-- 2026-11-28 LINE「綁定」改成 Flex 選旅程卡片：line_bindable_trips 多回旅程日期與人數，依旅程日期排序

-- 這個 LINE 使用者可以綁哪些旅程（他是成員、沒封存），旅程日期（沒填用建立日）新的在前；附日期與人數給選旅程卡片
CREATE OR REPLACE FUNCTION app.line_bindable_trips(p_line_user_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'linked', EXISTS (SELECT 1 FROM app.line_identities WHERE line_user_id = p_line_user_id),
        'trips', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', t.id, 'name', t.name, 'start_date', t.start_date, 'end_date', t.end_date,
                       'member_count', coalesce(array_length(t.members, 1), 0))
                   ORDER BY coalesce(t.start_date, t.created_at::date) DESC, t.created_at DESC)
            FROM app.line_identities li
            JOIN app.trip_members tm ON tm.user_id = li.user_id
            JOIN app.trips t ON t.id = tm.trip_id AND NOT t.is_archived
            WHERE li.line_user_id = p_line_user_id
        ), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION app.line_bindable_trips(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.line_bindable_trips(TEXT) TO service_role;
