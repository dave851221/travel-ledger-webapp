-- ============================================================
-- 旅程密碼改為「選填」
--   access_code 為 NULL 或全空白  → 該旅程免密碼，任何人皆可直接進入
--   access_code 有值               → 維持原本的密碼驗證流程
-- ============================================================

-- 1. 解除 NOT NULL 限制
ALTER TABLE public.trips ALTER COLUMN access_code DROP NOT NULL;

-- 2. 既有的空白密碼一律正規化為 NULL，避免出現兩種「無密碼」表示法
UPDATE public.trips SET access_code = NULL WHERE btrim(access_code) = '';

-- 3. 密碼驗證函式：免密碼旅程一律放行
--    先 DROP 再 CREATE，避免與舊版簽章共存導致 PostgREST 無法決定要呼叫哪一個
DROP FUNCTION IF EXISTS public.verify_trip_code(UUID, TEXT);
DROP FUNCTION IF EXISTS public.verify_trip_code(TEXT, TEXT);

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

    -- 旅程不存在
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- 免密碼旅程：不論輸入什麼都放行
    IF btrim(coalesce(v_code, '')) = '' THEN
        RETURN TRUE;
    END IF;

    RETURN v_code = coalesce(p_code, '');
END;
$$;

-- 4. 讓前端能在「不取得密碼本身」的前提下，查詢旅程是否需要密碼
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
        TRUE  -- 查無旅程時保守地要求密碼
    );
$$;

GRANT EXECUTE ON FUNCTION public.verify_trip_code(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_requires_code(UUID)     TO anon, authenticated;

-- 5. 通知 PostgREST 重新載入 schema，讓新的 RPC 立即可用
NOTIFY pgrst, 'reload schema';
