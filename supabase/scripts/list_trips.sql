-- ============================================================
-- 列出所有旅程，用來找出目標旅程的 UUID
--
-- 直接整份貼進 Supabase SQL Editor 執行，不需修改任何內容。
-- 操作說明見 docs/DB_MAINTENANCE.md
-- ============================================================

SELECT
    t.id,
    t.name,
    t.category,
    t.is_archived,
    t.created_at::date                                AS created,
    count(e.id) FILTER (WHERE e.deleted_at IS NULL)   AS expenses,
    count(e.id) FILTER (WHERE e.deleted_at IS NOT NULL) AS in_trash,
    coalesce(sum(cardinality(e.photo_urls)), 0)       AS photos,
    m.linebot_id
FROM public.trips t
LEFT JOIN public.expenses e             ON e.trip_id = t.id
LEFT JOIN public.line_trip_id_mapping m ON m.trip_id = t.id
GROUP BY t.id, m.linebot_id
ORDER BY t.created_at DESC;
