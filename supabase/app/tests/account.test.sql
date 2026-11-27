-- ============================================================
-- 刪除帳號（app/07_account.sql）—— pgTAP
-- ============================================================

BEGIN;
SELECT plan(13);

UPDATE app.quota_settings SET free_trip_creations = 2;

INSERT INTO auth.users (id, email, aud, role)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1', 'da@test.local', 'authenticated', 'authenticated'),
       ('bbbbbbbb-0000-0000-0000-0000000000f2', 'db@test.local', 'authenticated', 'authenticated'),
       ('cccccccc-0000-0000-0000-0000000000f3', 'dc@test.local', 'authenticated', 'authenticated');
INSERT INTO app.line_identities (line_user_id, user_id) VALUES ('Udel1', 'aaaaaaaa-0000-0000-0000-0000000000f1');

CREATE FUNCTION pg_temp.as_user(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON ids TO authenticated;

-- A 建兩趟：solo 只有自己、shared 有 B
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000f1');
INSERT INTO ids SELECT 'solo', app.create_trip('自己的', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲'])::text;
INSERT INTO ids SELECT 'shared', app.create_trip('一起的', ARRAY['甲', '乙'], '甲', 'TWD', ARRAY['餐飲'])::text;
INSERT INTO app.expenses (trip_id, category, description, amount, currency)
SELECT v::uuid, '餐飲', '拉麵', 100, 'TWD' FROM ids WHERE k = 'shared';
RESET ROLE;
INSERT INTO app.trip_members (trip_id, user_id, member_name, role)
SELECT v::uuid, 'bbbbbbbb-0000-0000-0000-0000000000f2', '乙', 'editor' FROM ids WHERE k = 'shared';

SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000f1');
SELECT is(jsonb_array_length(app.account_deletion_preview() -> 'delete'), 1, '預覽：只剩自己的旅程會刪掉');
SELECT is(jsonb_array_length(app.account_deletion_preview() -> 'leave'), 1, '預覽：有別人的旅程會交出去');
SELECT throws_ok($$ SELECT app.delete_my_account('delete') $$, 'not_confirmed', '沒打「刪除帳號」不能刪');
SELECT lives_ok($$ SELECT app.delete_my_account('刪除帳號') $$, '打對了就刪');
RESET ROLE;

SELECT is((SELECT count(*)::int FROM auth.users WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000f1'), 0, '帳號刪掉了');
SELECT is((SELECT count(*)::int FROM app.line_identities WHERE line_user_id = 'Udel1'), 0, 'LINE 對應也刪掉（可以重新綁定）');
SELECT is((SELECT count(*)::int FROM app.trips WHERE id = (SELECT v::uuid FROM ids WHERE k = 'solo')), 0, '只剩自己的旅程整趟刪掉');
SELECT is((SELECT role FROM app.trip_members WHERE user_id = 'bbbbbbbb-0000-0000-0000-0000000000f2'), 'owner', '一起的旅程交給 B');
SELECT is((SELECT count(*)::int FROM app.expenses WHERE trip_id = (SELECT v::uuid FROM ids WHERE k = 'shared')), 1, '帳都留著');

-- 同一個 LINE 重新註冊：建立過的趟數接著算
INSERT INTO auth.users (id, email, aud, role) VALUES ('dddddddd-0000-0000-0000-0000000000f4', 'dd@test.local', 'authenticated', 'authenticated');
INSERT INTO app.line_identities (line_user_id, user_id) VALUES ('Udel1', 'dddddddd-0000-0000-0000-0000000000f4');
SELECT pg_temp.as_user('dddddddd-0000-0000-0000-0000000000f4');
SELECT is((app.my_trip_allowance() ->> 'created')::int, 1, '重新註冊後，舊帳號還留著的旅程照樣算（只剩自己的那趟已刪掉，空出名額）');
SELECT lives_ok($$ SELECT app.create_trip('再一趟', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲']) $$, '空出來的名額可以用');
SELECT throws_ok($$ SELECT app.create_trip('再兩趟', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲']) $$, 'trip_limit',
                 '刪帳號重來也拿不到額外的免費名額');
SELECT throws_ok($$ SELECT count(*) FROM app.deleted_identity_trips $$, '42501', NULL, '使用者看不到刪除紀錄');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
