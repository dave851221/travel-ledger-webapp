-- ============================================================
-- 成員改名 —— 成員清單與所有支出 JSONB 的 key 在同一個 transaction 裡改完
--
-- payer_data／split_data 的 key 是成員的顯示名稱，所以改名時每一筆支出都要改寫。
-- 以前是前端先存 trips 再一筆一筆 update 支出，中途斷線就會留下一半還是舊名字的支出，
-- 那些錢從結算裡消失（只有成員清單裡的人會被計算），而且畫面上完全看不出來。
--
-- p_renames 是 { 舊名: 新名 }，所有改名「同時」套用，A、B 互換名字也不會互相覆蓋。
-- 垃圾桶內的支出一起改，還原之後才對得上。
-- 不需要 SECURITY DEFINER：trips／expenses 的 RLS 本來就對 anon 開放。
-- ============================================================
DROP FUNCTION IF EXISTS public.rename_trip_members(UUID, TEXT[], JSONB);

CREATE FUNCTION public.rename_trip_members(p_trip_id UUID, p_members TEXT[], p_renames JSONB)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_old TEXT[];
BEGIN
    IF p_renames IS NULL OR jsonb_typeof(p_renames) <> 'object' THEN
        RAISE EXCEPTION 'p_renames must be a JSON object';
    END IF;

    UPDATE public.trips SET members = p_members WHERE id = p_trip_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'trip % not found', p_trip_id;
    END IF;

    v_old := ARRAY(SELECT jsonb_object_keys(p_renames));
    IF cardinality(v_old) = 0 THEN
        RETURN;
    END IF;

    UPDATE public.expenses e
    SET payer_data = (
            SELECT coalesce(jsonb_object_agg(coalesce(p_renames ->> t.k, t.k), t.v), '{}'::jsonb)
            FROM jsonb_each(e.payer_data) AS t(k, v)
        ),
        split_data = (
            SELECT coalesce(jsonb_object_agg(coalesce(p_renames ->> t.k, t.k), t.v), '{}'::jsonb)
            FROM jsonb_each(e.split_data) AS t(k, v)
        ),
        adjustment_member = coalesce(p_renames ->> e.adjustment_member, e.adjustment_member)
    WHERE e.trip_id = p_trip_id
      AND (e.payer_data ?| v_old OR e.split_data ?| v_old OR e.adjustment_member = ANY (v_old));
END;
$$;

GRANT EXECUTE ON FUNCTION public.rename_trip_members(UUID, TEXT[], JSONB) TO anon, authenticated;

-- 通知 PostgREST 重新載入 schema，讓新的 RPC 立即可用
NOTIFY pgrst, 'reload schema';
