-- ============================================================
-- 預覽「刪除某個旅程會刪掉什麼」— 唯讀，不會改動任何資料
--
-- 用法：把下面那一行的 UUID 換成目標旅程的 id（用 list_trips.sql 查），
--       整份貼進 Supabase SQL Editor 執行。
--
-- 請務必先跑這支，確認 trip_name 真的是你要刪的旅程，再執行 delete_trip.sql。
-- 操作說明見 docs/DB_MAINTENANCE.md
-- ============================================================

WITH target AS (
    SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id   -- ← 改這裡
)
SELECT 'trip_name'         AS item,
       coalesce((SELECT name FROM public.trips WHERE id = (SELECT id FROM target)),
                '⚠️ 查無此旅程 — 請確認 UUID') AS value
UNION ALL
SELECT 'expenses',         count(*)::text FROM public.expenses
       WHERE trip_id = (SELECT id FROM target)
UNION ALL
SELECT 'expenses_in_trash', count(*)::text FROM public.expenses
       WHERE trip_id = (SELECT id FROM target) AND deleted_at IS NOT NULL
UNION ALL
SELECT 'storage_photos',   count(*)::text FROM storage.objects
       WHERE bucket_id = 'travel-images'
         AND name LIKE 'expenses/' || (SELECT id::text FROM target) || '/%'
UNION ALL
SELECT 'linebot_id',       coalesce((SELECT linebot_id FROM public.line_trip_id_mapping
                                     WHERE trip_id = (SELECT id FROM target)), '(無)')
UNION ALL
SELECT 'line_bound_chats', count(*)::text FROM public.line_user_states
       WHERE current_trip_id = (SELECT id FROM target)
          OR pending_trip_id = (SELECT id FROM target);
