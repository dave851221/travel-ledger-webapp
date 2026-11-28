-- 分享頁顯示完整功能、行程色系與呈現方式（David 2026-11-28）
--   · trips.itinerary_color / itinerary_style（管理員才能改；行程試算表也改成管理員才能換）
--   · get_trip_snapshot 多帶日期、行程試算表與外觀；share_access_ok 給 Edge Function 驗分享連結

-- 行程頁的色系與呈現方式（David 2026-11-28）：管理員以上才能改（trips_guard_update 擋）；值對應 src/features/itinerary/themes.ts
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS itinerary_color TEXT;
ALTER TABLE app.trips ADD COLUMN IF NOT EXISTS itinerary_style TEXT;
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_itinerary_look_check;
ALTER TABLE app.trips ADD CONSTRAINT trips_itinerary_look_check
    CHECK ((itinerary_color IS NULL OR itinerary_color ~ '^[a-z]{2,20}$') AND (itinerary_style IS NULL OR itinerary_style ~ '^[a-z]{2,20}$'));
GRANT SELECT (itinerary_color, itinerary_style) ON app.trips TO authenticated;
GRANT UPDATE (itinerary_color, itinerary_style) ON app.trips TO authenticated;

CREATE OR REPLACE FUNCTION app.get_trip_snapshot(p_trip_id UUID, p_token TEXT, p_password TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_trip app.trips%ROWTYPE;
BEGIN
    SELECT * INTO v_trip FROM app.trips WHERE id = p_trip_id;
    IF NOT FOUND OR coalesce(p_token, '') = '' OR v_trip.share_token <> p_token
       OR v_trip.visibility = 'members' THEN
        RAISE EXCEPTION 'no_access' USING ERRCODE = '42501';
    END IF;
    IF v_trip.visibility = 'password' THEN
        IF p_password IS NULL OR extensions.crypt(p_password, v_trip.view_password_hash) <> v_trip.view_password_hash THEN
            RAISE EXCEPTION 'wrong_password' USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'trip', jsonb_build_object(
            'id', v_trip.id, 'name', v_trip.name, 'members', v_trip.members,
            'categories', v_trip.categories, 'category', v_trip.category,
            'base_currency', v_trip.base_currency, 'timezone', v_trip.timezone,
            'rates', v_trip.rates, 'precision_config', v_trip.precision_config,
            'is_archived', v_trip.is_archived, 'visibility', v_trip.visibility,
            'start_date', v_trip.start_date, 'end_date', v_trip.end_date,
            'default_currency', v_trip.default_currency, 'default_category', v_trip.default_category,
            -- 分享頁也看得到行程（試算表由 tlb-itinerary 讀，它會再驗一次分享連結）
            'itinerary_sheet', v_trip.itinerary_sheet,
            'itinerary_color', v_trip.itinerary_color, 'itinerary_style', v_trip.itinerary_style,
            'created_at', v_trip.created_at
        ),
        'expenses', coalesce((
            SELECT jsonb_agg(to_jsonb(e) - 'created_by' ORDER BY e.date, e.created_at)
            FROM app.expenses e
            WHERE e.trip_id = p_trip_id AND e.deleted_at IS NULL
        ), '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION app.get_trip_snapshot(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_trip_snapshot(UUID, TEXT, TEXT) TO anon, authenticated;

-- 分享連結對不對（給 Edge Function 用：分享頁的照片簽名網址、試算表行程）。規則同 get_trip_snapshot。
CREATE OR REPLACE FUNCTION app.share_access_ok(p_trip_id UUID, p_token TEXT, p_password TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_trip app.trips%ROWTYPE;
BEGIN
    SELECT * INTO v_trip FROM app.trips WHERE id = p_trip_id;
    IF NOT FOUND OR coalesce(p_token, '') = '' OR v_trip.share_token <> p_token OR v_trip.visibility = 'members' THEN
        RETURN FALSE;
    END IF;
    IF v_trip.visibility = 'password' THEN
        RETURN p_password IS NOT NULL AND extensions.crypt(p_password, v_trip.view_password_hash) = v_trip.view_password_hash;
    END IF;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION app.share_access_ok(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.share_access_ok(UUID, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION app.trips_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    -- service role（Edge Function）與 SECURITY DEFINER 的 RPC 不受限（它們自己檢查過了）
    IF auth.uid() IS NULL OR current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    IF NOT app.is_admin(OLD.id) AND (
           NEW.name IS DISTINCT FROM OLD.name
        OR NEW.category IS DISTINCT FROM OLD.category
        OR NEW.base_currency IS DISTINCT FROM OLD.base_currency
        OR NEW.timezone IS DISTINCT FROM OLD.timezone
        OR NEW.is_archived IS DISTINCT FROM OLD.is_archived
        OR NEW.itinerary_sheet IS DISTINCT FROM OLD.itinerary_sheet
        OR NEW.itinerary_color IS DISTINCT FROM OLD.itinerary_color
        OR NEW.itinerary_style IS DISTINCT FROM OLD.itinerary_style
    ) THEN
        RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
