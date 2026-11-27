-- ============================================================
-- 照片搬到 R2（app/10_photos.sql）—— pgTAP
-- trip_photos 只有 service role 碰得到；count_photos 算表＋Storage；add_trip_photo 擋上限。
-- ============================================================

BEGIN;
SELECT plan(10);

UPDATE app.plan_limits SET max_photos = 2 WHERE plan = 'free';

INSERT INTO auth.users (id, email, aud, role)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000a1', 'pa@test.local', 'authenticated', 'authenticated');

CREATE FUNCTION pg_temp.as_user(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON ids TO authenticated, service_role;

SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a1');
INSERT INTO ids SELECT 't', app.create_trip('照片', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲'])::text;

-- 一般使用者碰不到表、也叫不了占位函式
SELECT throws_ok($$ SELECT * FROM app.trip_photos $$, '42501', NULL, '登入的人讀不到 trip_photos');
SELECT throws_ok($$ SELECT app.add_trip_photo((SELECT v::uuid FROM ids WHERE k = 't'), 'expenses/' || (SELECT v FROM ids WHERE k = 't') || '/a.jpg', NULL) $$,
                 '42501', NULL, '登入的人叫不了 add_trip_photo');

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT lives_ok($$ SELECT app.add_trip_photo((SELECT v::uuid FROM ids WHERE k = 't'), 'expenses/' || (SELECT v FROM ids WHERE k = 't') || '/a.jpg', NULL) $$, '上限內可以占位');
SELECT throws_ok($$ INSERT INTO app.trip_photos (path, trip_id) VALUES ('evil/a.jpg', (SELECT v::uuid FROM ids WHERE k = 't')) $$,
                 '23514', NULL, '路徑格式不對就擋');
RESET ROLE;
SELECT is(app.count_photos((SELECT v::uuid FROM ids WHERE k = 't')), 1, 'count_photos 算到表上的照片');

-- 還留在 Storage 的檔案也算（本機沒設 R2、或還沒搬完）
INSERT INTO storage.objects (bucket_id, name) VALUES ('app-images', 'expenses/' || (SELECT v FROM ids WHERE k = 't') || '/b.jpg');
SELECT is(app.count_photos((SELECT v::uuid FROM ids WHERE k = 't')), 2, 'Storage 裡的也算');
-- 搬到一半：R2 有、Storage 也還有同一張，不重複算
INSERT INTO storage.objects (bucket_id, name) VALUES ('app-images', 'expenses/' || (SELECT v FROM ids WHERE k = 't') || '/a.jpg');
SELECT is(app.count_photos((SELECT v::uuid FROM ids WHERE k = 't')), 2, '兩邊都有的同一張只算一次');

SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT app.add_trip_photo((SELECT v::uuid FROM ids WHERE k = 't'), 'expenses/' || (SELECT v FROM ids WHERE k = 't') || '/c.jpg', NULL) $$,
                 'photo_limit', '滿了就擋');
SELECT throws_ok($$ SELECT app.add_trip_photo('00000000-0000-0000-0000-0000000000ff', 'expenses/00000000-0000-0000-0000-0000000000ff/c.jpg', NULL) $$,
                 'no_trip', '沒有這趟旅程');
RESET ROLE;

-- 刪旅程時表上的列跟著刪
DELETE FROM app.trips WHERE id = (SELECT v::uuid FROM ids WHERE k = 't');
SELECT is((SELECT count(*)::int FROM app.trip_photos), 0, '刪旅程時 trip_photos 跟著刪');

SELECT * FROM finish();
ROLLBACK;
