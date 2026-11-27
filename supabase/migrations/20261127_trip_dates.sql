-- ============================================================
-- 旅程日期（選填）：trips.start_date / end_date（舊版 public 與開放版 app 都加）
--
-- 一天的旅程只填 start_date；一段時間再加 end_date（含當天，不早於 start_date）。
-- 都沒填的旅程首頁照舊用建立時間。只新增欄位，不動既有資料。
-- 開放版的 create_trip 多兩個參數（舊的 8 參數版本拿掉，避免同名函式）。
-- 函式本體以 20261126_app_roles.sql 之後的版本為準（成員上限 app.max_members()）。
-- ============================================================

ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS end_date   DATE;
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_dates_check;
ALTER TABLE public.trips ADD CONSTRAINT trips_dates_check
    CHECK (end_date IS NULL OR (start_date IS NOT NULL AND end_date >= start_date));

ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS end_date   DATE;
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_dates_check;
ALTER TABLE app.trips ADD CONSTRAINT trips_dates_check
    CHECK (end_date IS NULL OR (start_date IS NOT NULL AND end_date >= start_date));

-- 開放版的欄位權限是逐欄開的：成員看得到、改得到日期
GRANT SELECT (start_date, end_date) ON app.trips TO authenticated;
GRANT UPDATE (start_date, end_date) ON app.trips TO authenticated;

DROP FUNCTION IF EXISTS app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB);
CREATE OR REPLACE FUNCTION app.create_trip(
    p_name          TEXT,
    p_members       TEXT[],
    p_my_name       TEXT,
    p_base_currency TEXT,
    p_categories    TEXT[],
    p_timezone      TEXT DEFAULT NULL,
    p_category      TEXT DEFAULT NULL,
    -- 幣別小數位數（例如 {"JPY": 0}），由前端依幣別決定；跟建立一起寫，不另外更新一次
    p_precision_config JSONB DEFAULT '{}'::jsonb,
    -- 旅程日期（選填），規則同 trips_dates_check
    p_start_date    DATE DEFAULT NULL,
    p_end_date      DATE DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_members TEXT[];
    v_me      TEXT;
    v_id      UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;

    -- 去重但保留輸入順序（DISTINCT 會依字母排序，成員順序就亂了）
    SELECT array_agg(n ORDER BY first_ord) INTO v_members
    FROM (
        SELECT app.clean_name(m) AS n, min(ord) AS first_ord
        FROM unnest(p_members) WITH ORDINALITY AS u(m, ord)
        GROUP BY 1
    ) s;
    v_me := app.clean_name(p_my_name);
    IF v_members IS NULL OR NOT (v_me = ANY (v_members)) THEN
        RAISE EXCEPTION 'my_name_not_in_members' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_members) > app.max_members() THEN
        RAISE EXCEPTION 'too_many_members' USING ERRCODE = '22023';
    END IF;

    INSERT INTO app.trips (name, members, categories, base_currency, timezone, category, created_by,
                           rates, precision_config, start_date, end_date)
    VALUES (btrim(p_name), v_members, coalesce(p_categories, '{}'), upper(btrim(p_base_currency)),
            p_timezone, p_category, v_uid,
            jsonb_build_object(upper(btrim(p_base_currency)), 1),
            CASE WHEN jsonb_typeof(p_precision_config) = 'object' THEN p_precision_config ELSE '{}'::jsonb END,
            p_start_date, CASE WHEN p_end_date = p_start_date THEN NULL ELSE p_end_date END)
    RETURNING id INTO v_id;

    INSERT INTO app.trip_members (trip_id, user_id, member_name, role)
    VALUES (v_id, v_uid, v_me, 'owner');

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.create_trip(TEXT, TEXT[], TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB, DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
