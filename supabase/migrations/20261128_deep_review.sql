-- ============================================================
-- 2026-11-28 深入 review（見 supabase/app/schema/01_tables.sql、07_account.sql、10_photos.sql）
--   1. 文字與陣列的大小上限（trips_size_check、expenses_size_check）
--   2. 照片張數不再算「沒存成帳的孤兒照片」（超過兩天）
--   3. 刪帳號時把他綁的 LINE 聊天一起解除
-- ============================================================

-- ── 文字與陣列的大小上限（2026-11-28 深入 review）─────────────────
-- 開放給陌生人用之後，一個免費帳號也能把超長的品名、偏好、JSON 塞進資料庫（免費方案只有 500 MB），
-- AI 記帳偏好更是每次叫 AI 都整段送出。數字都遠大於正常使用（品名平常 20 字內、偏好目前最長約 8000 字）；
-- 網頁輸入框與 Edge Function 用同樣的上限（品名超過會被截斷，不會整筆存不進去）。
ALTER TABLE app.trips DROP CONSTRAINT IF EXISTS trips_size_check;
ALTER TABLE app.trips ADD CONSTRAINT trips_size_check CHECK (
        (ai_preference IS NULL OR char_length(ai_preference) <= 10000)
    AND (category IS NULL OR char_length(category) <= 60)
    AND cardinality(categories) <= 100
    AND char_length(array_to_string(categories, '')) <= 2000
    AND cardinality(coalesce(default_payer, '{}')) <= 150
    AND cardinality(coalesce(default_split_members, '{}')) <= 150
    AND octet_length(rates::text) <= 8000
    AND octet_length(precision_config::text) <= 8000
);
ALTER TABLE app.expenses DROP CONSTRAINT IF EXISTS expenses_size_check;
ALTER TABLE app.expenses ADD CONSTRAINT expenses_size_check CHECK (
        char_length(description) <= 200
    AND char_length(category) <= 60
    AND char_length(currency) <= 10
    AND (adjustment_member IS NULL OR char_length(adjustment_member) <= 40)
    AND cardinality(coalesce(photo_urls, '{}')) <= 100
    AND cardinality(coalesce(receipt_photo_urls, '{}')) <= 100
    AND octet_length(array_to_string(coalesce(photo_urls, '{}'), '')) <= 20000
    AND octet_length(array_to_string(coalesce(receipt_photo_urls, '{}'), '')) <= 20000
    AND octet_length(payer_data::text) <= 20000
    AND octet_length(split_data::text) <= 20000
);

-- 照片張數：這張表＋還留在 Storage app-images 的檔案（已經搬到 R2、表上有的不重複算）。
-- 正式環境搬完之後 app-images 是空的；本機沒設 R2 金鑰時照片還是放 app-images，張數一樣算得到。
-- 只算「有帳目用到的」（含垃圾桶裡的）與兩天內剛傳的（LINE 還沒按確認的草稿、正在填的表單）：
-- 傳了照片卻沒存（草稿放著不管、表單關掉）留下的孤兒照片，過兩天就不再占名額（2026-11-28 深入 review）。
CREATE OR REPLACE FUNCTION app.count_photos(p_trip_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH used AS (
        SELECT DISTINCT u.path
        FROM app.expenses e, unnest(e.photo_urls) AS u(path)
        WHERE e.trip_id = p_trip_id
    )
    SELECT (SELECT count(*) FROM app.trip_photos p
            WHERE p.trip_id = p_trip_id
              AND (p.created_at > now() - interval '2 days' OR p.path IN (SELECT path FROM used)))::int
         + (SELECT count(*) FROM storage.objects o
            WHERE o.bucket_id = 'app-images' AND o.name LIKE 'expenses/' || p_trip_id::text || '/%'
              AND NOT EXISTS (SELECT 1 FROM app.trip_photos p WHERE p.path = o.name)
              AND (o.created_at > now() - interval '2 days' OR o.name IN (SELECT path FROM used)))::int;
$$;
REVOKE ALL ON FUNCTION app.count_photos(UUID) FROM PUBLIC, anon, authenticated;

-- 刪除自己的帳號。p_confirm 必須是「刪除帳號」四個字（前端要使用者自己打），避免誤呼叫
CREATE OR REPLACE FUNCTION app.delete_my_account(p_confirm TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_created INTEGER;
    v_paid    BOOLEAN;
    r         RECORD;
    v_next    UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    IF p_confirm IS DISTINCT FROM '刪除帳號' THEN
        RAISE EXCEPTION 'not_confirmed' USING ERRCODE = '22023';
    END IF;

    FOR r IN SELECT trip_id, role FROM app.trip_members WHERE user_id = v_uid LOOP
        SELECT o.user_id INTO v_next FROM app.trip_members o
        WHERE o.trip_id = r.trip_id AND o.user_id <> v_uid
        ORDER BY (o.role = 'owner') DESC, (o.role = 'admin') DESC, o.joined_at
        LIMIT 1;
        IF v_next IS NULL THEN
            DELETE FROM app.trips WHERE id = r.trip_id;           -- 只剩自己：整趟刪掉
        ELSIF r.role = 'owner' THEN
            UPDATE app.trip_members SET role = 'owner' WHERE trip_id = r.trip_id AND user_id = v_next;
        END IF;
    END LOOP;

    -- 建立過、而且還留著的旅程數（只剩自己的已經刪掉，空出名額）與有沒有付過費：跟著登入方式留下來（只存雜湊）
    SELECT (a ->> 'created')::int, (a ->> 'paid')::boolean INTO v_created, v_paid FROM app.trip_allowance(v_uid) a;
    INSERT INTO app.deleted_identity_trips (identity_hash, trips_created, paid)
    SELECT h, v_created, v_paid FROM unnest(app.identity_hashes(v_uid)) h
    ON CONFLICT (identity_hash) DO UPDATE
        SET trips_created = GREATEST(app.deleted_identity_trips.trips_created, EXCLUDED.trips_created),
            paid = app.deleted_identity_trips.paid OR EXCLUDED.paid,
            deleted_at = now();

    -- 他綁到旅程的 LINE 聊天（一對一與群組）一起解除，跟被移出旅程一樣。
    -- 不能只靠 trip_members 的 unbind trigger：刪 auth.users 時 bound_by 的 SET NULL 可能先跑，trigger 就比對不到了
    UPDATE app.line_user_states SET current_trip_id = NULL, bound_by = NULL WHERE bound_by = v_uid;

    -- trip_members、line_identities、profiles、auth.identities 都會跟著刪（ON DELETE CASCADE）
    DELETE FROM auth.users WHERE id = v_uid;
END;
$$;
REVOKE ALL ON FUNCTION app.delete_my_account(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.delete_my_account(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
