-- ============================================================
-- 旅行喵喵的綁定（app/06_line.sql）—— pgTAP
-- ============================================================

BEGIN;
SELECT plan(11);

INSERT INTO auth.users (id, email, aud, role)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000a1', 'la@test.local', 'authenticated', 'authenticated'),
       ('bbbbbbbb-0000-0000-0000-0000000000b1', 'lb@test.local', 'authenticated', 'authenticated');

CREATE FUNCTION pg_temp.as_user(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON ids TO authenticated, service_role;

SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1');
INSERT INTO ids SELECT 't', app.create_trip('綁定測試', ARRAY['甲', '乙'], '甲', 'TWD', ARRAY['餐飲'])::text;
SELECT throws_ok($$ SELECT count(*) FROM app.line_user_states $$, '42501', NULL, '網站使用者看不到機器人的聊天狀態');
SELECT throws_ok($$ SELECT app.bind_line_chat('Cgroup', 'Ua1', (SELECT v::uuid FROM ids WHERE k = 't')) $$,
                 '42501', NULL, '網站使用者不能自己呼叫綁定');
RESET ROLE;

INSERT INTO app.line_identities (line_user_id, user_id) VALUES
    ('Ua1', 'aaaaaaaa-0000-0000-0000-0000000000a1'),
    ('Ub1', 'bbbbbbbb-0000-0000-0000-0000000000b1');
INSERT INTO app.trip_members (trip_id, user_id, member_name, role)
SELECT v::uuid, 'bbbbbbbb-0000-0000-0000-0000000000b1', '乙', 'editor' FROM ids WHERE k = 't';

SET LOCAL ROLE service_role;
SELECT is(app.line_bindable_trips('Unobody') ->> 'linked', 'false', '沒連網站帳號的 LINE：linked=false');
SELECT is(jsonb_array_length(app.line_bindable_trips('Ua1') -> 'trips'), 1, '列出自己是成員的旅程');
SELECT is(app.line_member('Ub1', (SELECT v::uuid FROM ids WHERE k = 't')) ->> 'member_name', '乙', 'LINE 對到帳上的名字');
SELECT is(app.bind_line_chat('Cgroup', 'Unobody', (SELECT v::uuid FROM ids WHERE k = 't')) ->> 'reason', 'not_member',
          '不是成員不能綁（就算拿到旅程 id）');
SELECT is(app.bind_line_chat('Cgroup', 'Ub1', (SELECT v::uuid FROM ids WHERE k = 't')) ->> 'ok', 'true', '成員可以綁');
SELECT is((SELECT current_trip_id FROM app.line_user_states WHERE line_user_id = 'Cgroup'),
          (SELECT v::uuid FROM ids WHERE k = 't'), '群組綁到這趟');
RESET ROLE;

-- 綁定的人被移出旅程：他綁的聊天跟著解除
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1');
DELETE FROM app.trip_members WHERE user_id = 'bbbbbbbb-0000-0000-0000-0000000000b1';
RESET ROLE;
SELECT is((SELECT current_trip_id FROM app.line_user_states WHERE line_user_id = 'Cgroup'), NULL, '綁定的人被移除後解除綁定');

SET LOCAL ROLE service_role;
UPDATE app.trips SET is_archived = TRUE WHERE id = (SELECT v::uuid FROM ids WHERE k = 't');
SELECT is(app.bind_line_chat('Cgroup', 'Ua1', (SELECT v::uuid FROM ids WHERE k = 't')) ->> 'reason', 'archived', '封存的旅程不能綁');
SELECT is(jsonb_array_length(app.line_bindable_trips('Ua1') -> 'trips'), 0, '封存的旅程不列出');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
