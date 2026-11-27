-- ============================================================
-- app/06_line — 旅行喵喵（LINE 機器人 tlb-line-webhook）的對話狀態
--
-- 與舊版 public 的 line_* 表同名、同欄位（機器人程式兩版共用，見 _shared/appMode.ts），差別：
--   · 綁定旅程不用通行碼，要「LINE 帳號已連到網站帳號、而且是那趟的成員」（bind_line_chat）
--   · bound_by：誰把這個聊天綁到這趟（帳號 id），之後被移出旅程就自動失效
--   · 沒有 line_trip_id_mapping（不用 6 碼代碼）
-- 全部只有 service role 能讀寫：網站的使用者碰不到別人的聊天紀錄。
-- ============================================================

CREATE TABLE IF NOT EXISTS app.line_user_states (
    line_user_id     TEXT PRIMARY KEY,            -- groupId / roomId / userId
    current_trip_id  UUID REFERENCES app.trips(id) ON DELETE SET NULL,
    pending_trip_id  UUID REFERENCES app.trips(id) ON DELETE SET NULL,  -- 開放版不用，留著讓程式共用
    pending_at       TIMESTAMPTZ,
    default_config   TEXT,
    mention_required BOOLEAN NOT NULL DEFAULT TRUE,
    last_active_at   TIMESTAMPTZ DEFAULT now(),
    created_at       TIMESTAMPTZ DEFAULT now(),
    followup_user_id TEXT,
    followup_until   TIMESTAMPTZ,
    photos_muted     BOOLEAN NOT NULL DEFAULT FALSE,
    bound_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app.line_chat_history (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    line_user_id    TEXT NOT NULL REFERENCES app.line_user_states(line_user_id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    speaker_user_id TEXT,
    speaker_name    TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_line_chat_history_user_idx ON app.line_chat_history (line_user_id);
CREATE INDEX IF NOT EXISTS app_line_chat_history_created_idx ON app.line_chat_history (created_at);

CREATE TABLE IF NOT EXISTS app.line_bot_messages (
    message_id   TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_line_bot_messages_created_idx ON app.line_bot_messages (created_at);

CREATE TABLE IF NOT EXISTS app.line_webhook_events (
    event_id   TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.line_processed_actions (
    nonce        TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES app.line_user_states(line_user_id) ON DELETE CASCADE,
    action_type  TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE app.line_user_states       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_chat_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_bot_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_webhook_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.line_processed_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.line_user_states, app.line_chat_history, app.line_bot_messages,
              app.line_webhook_events, app.line_processed_actions FROM anon, authenticated;
GRANT ALL ON app.line_user_states, app.line_chat_history, app.line_bot_messages,
             app.line_webhook_events, app.line_processed_actions TO service_role;

-- ── LINE 使用者 → 網站帳號 → 在這趟的名字 ─────────────────────
-- 回傳 NULL：這個 LINE 還沒連到網站帳號、或不是這趟的成員
CREATE OR REPLACE FUNCTION app.line_member(p_line_user_id TEXT, p_trip_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object('user_id', tm.user_id, 'member_name', tm.member_name, 'role', tm.role)
    FROM app.line_identities li
    JOIN app.trip_members tm ON tm.user_id = li.user_id AND tm.trip_id = p_trip_id
    WHERE li.line_user_id = p_line_user_id
    LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.line_member(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.line_member(TEXT, UUID) TO service_role;

-- 這個 LINE 使用者可以綁哪些旅程（他是成員、沒封存），最近建立的在前
CREATE OR REPLACE FUNCTION app.line_bindable_trips(p_line_user_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'linked', EXISTS (SELECT 1 FROM app.line_identities WHERE line_user_id = p_line_user_id),
        'trips', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.created_at DESC)
            FROM app.line_identities li
            JOIN app.trip_members tm ON tm.user_id = li.user_id
            JOIN app.trips t ON t.id = tm.trip_id AND NOT t.is_archived
            WHERE li.line_user_id = p_line_user_id
        ), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION app.line_bindable_trips(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.line_bindable_trips(TEXT) TO service_role;

-- 把一個 LINE 聊天（群組或一對一）綁到旅程：發言的人必須是那趟的成員
CREATE OR REPLACE FUNCTION app.bind_line_chat(p_source_id TEXT, p_line_user_id TEXT, p_trip_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_member JSONB := app.line_member(p_line_user_id, p_trip_id);
    v_trip   RECORD;
BEGIN
    IF v_member IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_member');
    END IF;
    SELECT name, members, is_archived INTO v_trip FROM app.trips WHERE id = p_trip_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_trip');
    END IF;
    IF v_trip.is_archived THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'archived');
    END IF;
    INSERT INTO app.line_user_states (line_user_id, current_trip_id, bound_by)
    VALUES (p_source_id, p_trip_id, (v_member ->> 'user_id')::uuid)
    ON CONFLICT (line_user_id) DO UPDATE
        SET current_trip_id = EXCLUDED.current_trip_id, bound_by = EXCLUDED.bound_by,
            pending_trip_id = NULL, pending_at = NULL;
    RETURN jsonb_build_object('ok', TRUE, 'name', v_trip.name, 'members', to_jsonb(v_trip.members));
END;
$$;
REVOKE ALL ON FUNCTION app.bind_line_chat(TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.bind_line_chat(TEXT, TEXT, UUID) TO service_role;

-- 綁定的人被移出旅程（或自己離開）：他綁的聊天跟著解除，免得被踢的人還能從 LINE 記帳
CREATE OR REPLACE FUNCTION app.unbind_line_on_leave()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE app.line_user_states SET current_trip_id = NULL, bound_by = NULL
    WHERE current_trip_id = OLD.trip_id AND bound_by = OLD.user_id;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app.unbind_line_on_leave() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_unbind_line_on_leave ON app.trip_members;
CREATE TRIGGER tr_app_unbind_line_on_leave
    AFTER DELETE ON app.trip_members
    FOR EACH ROW EXECUTE FUNCTION app.unbind_line_on_leave();

-- 機器人用 service role 上傳照片，storage 的上傳政策管不到，自己先問張數（line-webhook/quota.ts）
GRANT EXECUTE ON FUNCTION app.photo_quota_ok(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
