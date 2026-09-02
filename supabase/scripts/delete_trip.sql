-- ============================================================
-- 永久刪除一個旅程，連同它的支出、收據照片與 LINE 綁定
--
-- ⚠️ 不可逆。執行前請務必：
--    1. 先跑 preview_trip.sql 確認刪的是正確的旅程
--    2. 考慮先在 Supabase Dashboard → Database → Backups 建一次備份
--
-- 用法：把下面「改這裡」那一行的 UUID 換成目標旅程 id，整份貼進 SQL Editor 執行。
--       整份包在一個交易裡，任何一步失敗都會全部回滾。
--
-- 操作說明見 docs/DB_MAINTENANCE.md
-- ============================================================

BEGIN;

-- ── 步驟 1：指定目標旅程（只需要修改這一行）─────────────────────
CREATE TEMP TABLE _target ON COMMIT DROP AS
SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id;   -- ← 改這裡


-- ── 步驟 2：防呆檢查 ──────────────────────────────────────────
-- UUID 忘了改、或查無此旅程時直接中止整個交易
DO $$
DECLARE
    v_id   uuid;
    v_name text;
BEGIN
    SELECT id INTO v_id FROM _target;

    IF v_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
        RAISE EXCEPTION '尚未填入目標旅程的 UUID —— 請修改步驟 1 那一行';
    END IF;

    SELECT name INTO v_name FROM public.trips WHERE id = v_id;
    IF v_name IS NULL THEN
        RAISE EXCEPTION '查無此旅程：% —— 請用 list_trips.sql 重新確認 UUID', v_id;
    END IF;

    RAISE NOTICE '準備刪除旅程：% (%)', v_name, v_id;
END
$$;


-- ── 步驟 3：先刪 Storage 的收據照片 ───────────────────────────
-- 順序很重要：expenses.trip_id 是 ON DELETE CASCADE，一旦先刪掉 trip，
-- expenses.photo_urls 也跟著消失，就再也查不出該清哪些檔案，
-- 照片會變成 bucket 裡無法追蹤的孤兒（Storage 不受 FK 約束）。
DELETE FROM storage.objects
WHERE bucket_id = 'travel-images'
  AND name LIKE 'expenses/' || (SELECT id::text FROM _target) || '/%';


-- ── 步驟 4：解除 LINE 綁定狀態 ────────────────────────────────
-- FK 本身是 ON DELETE SET NULL，這裡明確處理是為了讓下方的驗證看得到結果
UPDATE public.line_user_states
SET current_trip_id = NULL,
    pending_trip_id = NULL
WHERE current_trip_id = (SELECT id FROM _target)
   OR pending_trip_id = (SELECT id FROM _target);


-- ── 步驟 5：刪除旅程本身 ──────────────────────────────────────
-- cascade 會一併帶走 expenses 與 line_trip_id_mapping
DELETE FROM public.trips WHERE id = (SELECT id FROM _target);


-- ── 步驟 6：驗證，以下每一欄都應該是 0 ────────────────────────
SELECT
    (SELECT count(*) FROM public.trips
     WHERE id = (SELECT id FROM _target))                        AS trips_left,
    (SELECT count(*) FROM public.expenses
     WHERE trip_id = (SELECT id FROM _target))                   AS expenses_left,
    (SELECT count(*) FROM public.line_trip_id_mapping
     WHERE trip_id = (SELECT id FROM _target))                   AS mappings_left,
    (SELECT count(*) FROM storage.objects
     WHERE bucket_id = 'travel-images'
       AND name LIKE 'expenses/' || (SELECT id::text FROM _target) || '/%') AS photos_left,
    (SELECT count(*) FROM public.line_user_states
     WHERE current_trip_id = (SELECT id FROM _target)
        OR pending_trip_id = (SELECT id FROM _target))            AS line_states_left;

COMMIT;
