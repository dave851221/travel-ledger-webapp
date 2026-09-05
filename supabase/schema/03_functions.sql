-- ============================================================
-- 03_functions — 資料庫函式
-- ============================================================

-- 通行碼驗證（SECURITY DEFINER：讓 access_code 不必離開資料庫）
-- access_code 為 NULL 或全空白代表免密碼，一律回傳 TRUE
DROP FUNCTION IF EXISTS public.verify_trip_code(UUID, TEXT);
DROP FUNCTION IF EXISTS public.verify_trip_code(TEXT, TEXT);  -- 早期版本的簽章

CREATE FUNCTION public.verify_trip_code(p_trip_id UUID, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT access_code INTO v_code FROM public.trips WHERE id = p_trip_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    IF btrim(coalesce(v_code, '')) = '' THEN
        RETURN TRUE;
    END IF;
    RETURN v_code = coalesce(p_code, '');
END;
$$;

-- 這個旅程需不需要輸入通行碼？供 TripPortal 決定是否顯示密碼欄
-- 查無此旅程時回傳 TRUE（fail closed）
DROP FUNCTION IF EXISTS public.trip_requires_code(UUID);

CREATE FUNCTION public.trip_requires_code(p_trip_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT coalesce(
        (SELECT btrim(coalesce(access_code, '')) <> '' FROM public.trips WHERE id = p_trip_id),
        TRUE
    );
$$;

GRANT EXECUTE ON FUNCTION public.verify_trip_code(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_requires_code(UUID)     TO anon, authenticated;

-- 產生 6 位短碼，字元集排除容易混淆的 0/1/I/O
CREATE OR REPLACE FUNCTION public.generate_linebot_id()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    chars  TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result TEXT := '';
    i      INTEGER := 0;
BEGIN
    FOR i IN 1..6 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$;

-- 新旅程建立時自動配一組短碼。
-- 必須是 SECURITY DEFINER：line_trip_id_mapping 有 RLS，
-- 以呼叫者權限寫入會失敗（這是踩過的坑，見 CLAUDE.md）
CREATE OR REPLACE FUNCTION public.trigger_generate_line_mapping()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.line_trip_id_mapping (trip_id, linebot_id)
    VALUES (NEW.id, public.generate_linebot_id())
    ON CONFLICT (trip_id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- 這兩支只給 trips 的 INSERT trigger 內部使用，不是對外 API，
-- 撤銷 PostgREST 會用到的角色的執行權限，避免被當成 RPC 呼叫。
-- PostgreSQL 在觸發器觸發時不檢查 EXECUTE 權限，因此不影響自動配發短碼。
REVOKE ALL ON FUNCTION public.generate_linebot_id()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_generate_line_mapping() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 垃圾桶保留期（24 小時）—— 一律以資料庫時鐘判斷
--
-- 以前是前端拿 `new Date()` 減 `deleted_at`，裝置時間不準就會提早清空或永遠不清。
-- 改成這兩支 RPC 之後，「還在保留期內」與「已過期」都由 now() 決定。
-- 不需要 SECURITY DEFINER：expenses 的 RLS 本來就對 anon 開放，
-- 以呼叫者權限執行即可，避免多開一個繞過 RLS 的入口。
-- ============================================================

-- 保留期內的垃圾桶內容（供畫面顯示）
DROP FUNCTION IF EXISTS public.list_trip_trash(UUID);

CREATE FUNCTION public.list_trip_trash(p_trip_id UUID)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT *
    FROM public.expenses
    WHERE trip_id = p_trip_id
      AND deleted_at IS NOT NULL
      AND deleted_at > now() - interval '24 hours'
    ORDER BY deleted_at DESC;
$$;

-- 已過保留期的垃圾桶內容（供前端永久刪除；photo_urls 是為了先清 Storage）
DROP FUNCTION IF EXISTS public.list_expired_trash(UUID);

CREATE FUNCTION public.list_expired_trash(p_trip_id UUID)
RETURNS TABLE(id UUID, photo_urls TEXT[])
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT e.id, e.photo_urls
    FROM public.expenses e
    WHERE e.trip_id = p_trip_id
      AND e.deleted_at IS NOT NULL
      AND e.deleted_at <= now() - interval '24 hours';
$$;

GRANT EXECUTE ON FUNCTION public.list_trip_trash(UUID)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_expired_trash(UUID) TO anon, authenticated;

-- 軟刪除的時間戳一律蓋成資料庫時間。
-- 寫入端有三個（前端 useTrash.softDelete、Edge Function、LIFF），
-- 各自送自己的時鐘，上面兩支 RPC 的判斷才會失準。
-- 只在「從 NULL 變成有值」時覆寫，還原（寫回 NULL）不受影響。
CREATE OR REPLACE FUNCTION public.stamp_deleted_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        NEW.deleted_at := now();
    END IF;
    RETURN NEW;
END;
$$;

-- 通知 PostgREST 重新載入 schema，讓新建立/變更的 RPC 立即可用
NOTIFY pgrst, 'reload schema';
