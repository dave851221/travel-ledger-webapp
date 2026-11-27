-- ============================================================
-- 開發者後台（app/09_admin.sql）—— pgTAP
-- ============================================================

BEGIN;
SELECT plan(13);

INSERT INTO auth.users (id, email, aud, role)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin@test.local', 'authenticated', 'authenticated'),
       ('bbbbbbbb-0000-0000-0000-0000000000bd', 'user@test.local', 'authenticated', 'authenticated');
INSERT INTO app.site_admins (user_id) VALUES ('aaaaaaaa-0000-0000-0000-0000000000ad');

CREATE FUNCTION pg_temp.as_user(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON ids TO authenticated, service_role;

-- 一般使用者建一趟、什麼後台功能都碰不到
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-0000000000bd');
INSERT INTO ids SELECT 't', app.create_trip('後台測試', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲'])::text;
SELECT is(app.is_site_admin(), FALSE, '一般使用者不是管理員');
SELECT throws_ok($$ SELECT app.admin_overview() $$, 'not_admin', '一般使用者看不到總覽');
SELECT throws_ok($$ SELECT app.admin_trips() $$, 'not_admin', '一般使用者看不到旅程清單');
SELECT throws_ok($$ SELECT app.admin_update_trip((SELECT v::uuid FROM ids WHERE k = 't'), 'paid', 0, 0, 0, FALSE) $$,
                 'not_admin', '一般使用者不能自己解鎖');
SELECT throws_ok($$ SELECT app.admin_set_paid(auth.uid(), TRUE) $$, 'not_admin', '一般使用者不能把自己標成付費');
SELECT throws_ok($$ SELECT count(*) FROM app.site_admins $$, '42501', NULL, '看不到管理員名單');
RESET ROLE;

SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000ad');
SELECT is(app.is_site_admin(), TRUE, '管理員');
SELECT ok((app.admin_overview() ->> 'trips')::int >= 1, '總覽有數字');
SELECT ok(jsonb_array_length(app.admin_trips('後台')) = 1, '可以搜尋旅程');
SELECT lives_ok($$ SELECT app.admin_update_trip((SELECT v::uuid FROM ids WHERE k = 't'), 'paid', 10, 5, 0, TRUE) $$, '解鎖、加量、暫停 AI');
SELECT is((app.admin_trips('後台') -> 0 -> 'limits' ->> 'max_ai_calls')::int, 305, '上限＝解鎖方案＋加量');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't'), 'user:x', 'text') ->> 'reason', 'suspended', '暫停的旅程不叫 AI');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM app.admin_log), 1, '操作有留紀錄');

SELECT * FROM finish();
ROLLBACK;
