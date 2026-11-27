-- ============================================================
-- app/08_liff — 開放版 LIFF 編輯頁讀草稿、防重複存檔
--
-- 舊版的 LIFF 頁直接讀寫 public.line_chat_history／line_processed_actions（對匿名開放）。
-- 開放版那兩張表只有 service role 能碰（06_line.sql），LIFF 頁改走這三支 RPC：
-- 一律先找到那張草稿（line_user_id ＋ nonce），確認呼叫的人是草稿那趟（tid）的成員，才讀／寫。
-- ============================================================

-- 找出一張草稿（最近 30 張 pending 裡 n = nonce 的那張）；找不到回 NULL。成員檢查由呼叫端做。
CREATE OR REPLACE FUNCTION app.liff_find_draft(p_source_id TEXT, p_nonce TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    r RECORD;
    d JSONB;
BEGIN
    FOR r IN SELECT content FROM app.line_chat_history
             WHERE line_user_id = p_source_id AND role = 'pending'
             ORDER BY created_at DESC LIMIT 30 LOOP
        BEGIN
            d := r.content::jsonb;
        EXCEPTION WHEN others THEN
            CONTINUE;
        END;
        IF d ->> 'n' = p_nonce THEN
            RETURN d;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.liff_find_draft(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- 草稿所屬的旅程；不是成員就丟 not_member
CREATE OR REPLACE FUNCTION app.liff_draft_trip(p_draft JSONB)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_trip UUID;
BEGIN
    BEGIN
        v_trip := (p_draft ->> 'tid')::uuid;
    EXCEPTION WHEN others THEN
        v_trip := NULL;
    END;
    IF v_trip IS NULL OR NOT app.is_member(v_trip) THEN
        RAISE EXCEPTION 'not_member' USING ERRCODE = '42501';
    END IF;
    RETURN v_trip;
END;
$$;
REVOKE ALL ON FUNCTION app.liff_draft_trip(JSONB) FROM PUBLIC, anon, authenticated;

-- LIFF 編輯頁打開草稿：{ used: 已經按過確認／取消, draft: 草稿內容 }；找不到草稿 draft 是 null
CREATE OR REPLACE FUNCTION app.liff_draft(p_source_id TEXT, p_nonce TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    d JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    d := app.liff_find_draft(p_source_id, p_nonce);
    IF d IS NULL THEN
        RETURN jsonb_build_object('used', FALSE, 'draft', NULL);
    END IF;
    PERFORM app.liff_draft_trip(d);
    RETURN jsonb_build_object(
        'used', EXISTS (SELECT 1 FROM app.line_processed_actions WHERE nonce = p_nonce),
        'draft', d);
END;
$$;
REVOKE ALL ON FUNCTION app.liff_draft(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.liff_draft(TEXT, TEXT) TO authenticated;

-- 存檔前佔用 nonce（跟 LINE 上的「確認存入」「取消」搶同一把鎖）；佔到回 TRUE
CREATE OR REPLACE FUNCTION app.liff_claim_nonce(p_source_id TEXT, p_nonce TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    d JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    d := app.liff_find_draft(p_source_id, p_nonce);
    IF d IS NULL THEN
        RETURN FALSE;
    END IF;
    PERFORM app.liff_draft_trip(d);
    INSERT INTO app.line_processed_actions (nonce, line_user_id, action_type)
    VALUES (p_nonce, p_source_id, 'save')
    ON CONFLICT (nonce) DO NOTHING;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app.liff_claim_nonce(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.liff_claim_nonce(TEXT, TEXT) TO authenticated;

-- 存檔失敗時放掉 nonce，不然那張卡片之後再也存不進去
CREATE OR REPLACE FUNCTION app.liff_release_nonce(p_source_id TEXT, p_nonce TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    d JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
    END IF;
    d := app.liff_find_draft(p_source_id, p_nonce);
    IF d IS NULL THEN
        RETURN;
    END IF;
    PERFORM app.liff_draft_trip(d);
    DELETE FROM app.line_processed_actions
    WHERE nonce = p_nonce AND line_user_id = p_source_id AND action_type = 'save';
END;
$$;
REVOKE ALL ON FUNCTION app.liff_release_nonce(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.liff_release_nonce(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
