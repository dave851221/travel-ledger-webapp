-- ============================================================
-- 開放版（app schema）的權限測試 —— pgTAP
--
-- 執行：在本機 Supabase 跑 `supabase test db`（需要 Docker），見 docs/SECURITY.md。
-- 每一條都在問同一件事：「不該看到／改到的人，真的看不到／改不到嗎？」
-- 新增表或 RPC 時，在這裡補上對應的「別人做不到」測試。
-- ============================================================

BEGIN;
SELECT plan(52);

-- ── 測試用帳號：A 建立旅程、B 被邀請、C 是路人 ─────────────────
INSERT INTO auth.users (id, email, aud, role)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.local', 'authenticated', 'authenticated'),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'b@test.local', 'authenticated', 'authenticated'),
       ('cccccccc-0000-0000-0000-000000000003', 'c@test.local', 'authenticated', 'authenticated');

-- 切換身分的小工具（只存在這個 transaction 裡）
CREATE FUNCTION pg_temp.as_user(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.as_anon() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    EXECUTE 'SET LOCAL ROLE anon';
END $$;

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON ids TO anon, authenticated;

-- ── 1. 建立旅程 ────────────────────────────────────────────────
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO ids SELECT 'trip', app.create_trip('大阪', ARRAY['代杰', '賢佑', '代杰'], '代杰', 'jpy', ARRAY['餐飲', '交通'])::text;

SELECT is((SELECT members FROM app.trips WHERE id = (SELECT v::uuid FROM ids WHERE k = 'trip')),
          ARRAY['代杰', '賢佑'], '建立旅程：成員去重且保留順序');
SELECT is((SELECT role FROM app.trip_members WHERE user_id = auth.uid()), 'owner', '建立者是 owner');
SELECT is((SELECT base_currency FROM app.trips), 'JPY', '幣別轉大寫');
SELECT throws_ok($$ SELECT app.create_trip('x', ARRAY['甲'], '乙', 'TWD', '{}') $$,
                 'my_name_not_in_members', '自己的名字必須在成員裡');

INSERT INTO app.expenses (trip_id, category, description, amount, currency, payer_data, split_data, created_by)
SELECT v::uuid, '餐飲', '拉麵', 2000, 'JPY', '{"代杰": 2000}', '{"代杰": 1000, "賢佑": 1000}',
       'cccccccc-0000-0000-0000-000000000003'
FROM ids WHERE k = 'trip';
SELECT is((SELECT created_by FROM app.expenses), 'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
          'created_by 一律是登入的人，前端送的不算');

INSERT INTO ids SELECT 'invite', invite_token FROM app.trips;
INSERT INTO ids SELECT 'share', share_token FROM app.trips;
RESET ROLE;

-- ── 2. 路人 C 什麼都碰不到 ─────────────────────────────────────
SELECT pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*) FROM app.trips), 0::bigint, '路人看不到別人的旅程');
SELECT is((SELECT count(*) FROM app.expenses), 0::bigint, '路人看不到別人的帳');
SELECT is((SELECT count(*) FROM app.trip_members), 0::bigint, '路人看不到別人的成員');
SELECT throws_ok($$ INSERT INTO app.expenses (trip_id, category, description, amount, currency)
                    SELECT v::uuid, '餐飲', '偷記', 1, 'JPY' FROM ids WHERE k = 'trip' $$,
                 '42501', NULL, '路人不能在別人的旅程記帳');
UPDATE app.trips SET name = '被改了' WHERE id = (SELECT v::uuid FROM ids WHERE k = 'trip');
UPDATE app.expenses SET amount = 1 WHERE trip_id = (SELECT v::uuid FROM ids WHERE k = 'trip');
DELETE FROM app.expenses WHERE trip_id = (SELECT v::uuid FROM ids WHERE k = 'trip');
DELETE FROM app.trips WHERE id = (SELECT v::uuid FROM ids WHERE k = 'trip');
SELECT is((SELECT count(*) FROM app.list_trip_trash((SELECT v::uuid FROM ids WHERE k = 'trip'))), 0::bigint,
          '路人叫垃圾桶 RPC 也拿不到東西');
SELECT throws_ok($$ SELECT app.set_my_member((SELECT v::uuid FROM ids WHERE k = 'trip'), '代杰') $$,
                 'not_member', '路人不能把自己設成成員');
SELECT throws_ok($$ SELECT app.update_trip_members((SELECT v::uuid FROM ids WHERE k = 'trip'), ARRAY['x'], '{}') $$,
                 'not_admin', '路人不能改成員清單');
SELECT throws_ok($$ SELECT app.accept_invite((SELECT v::uuid FROM ids WHERE k = 'trip'), 'wrong', '路人') $$,
                 'invalid_invite', '錯的邀請碼加入不了');
SELECT is(app.invite_preview((SELECT v::uuid FROM ids WHERE k = 'trip'), 'wrong'), NULL,
          '錯的邀請碼看不到預覽');
SELECT throws_ok($$ SELECT app.get_trip_snapshot((SELECT v::uuid FROM ids WHERE k = 'trip'),
                                                 (SELECT v FROM ids WHERE k = 'share')) $$,
                 'no_access', '旅程設成只有成員時，分享連結無效');
RESET ROLE;
SELECT is((SELECT name FROM app.trips), '大阪', '路人的 UPDATE 沒有效果');
SELECT is((SELECT count(*) FROM app.expenses), 1::bigint, '路人的 DELETE 沒有效果');
SELECT is((SELECT amount FROM app.expenses), 2000::numeric, '路人的 UPDATE 改不到帳');

-- ── 3. 沒登入的人 ──────────────────────────────────────────────
SELECT pg_temp.as_anon();
SELECT throws_ok($$ SELECT count(*) FROM app.trips $$, '42501', NULL, '沒登入不能直接查 trips');
SELECT throws_ok($$ SELECT count(*) FROM app.expenses $$, '42501', NULL, '沒登入不能直接查 expenses');
SELECT throws_ok($$ SELECT app.create_trip('x', ARRAY['甲'], '甲', 'TWD', '{}') $$,
                 '42501', NULL, '沒登入不能建立旅程');
SELECT is((app.invite_preview((SELECT v::uuid FROM ids WHERE k = 'trip'), (SELECT v FROM ids WHERE k = 'invite')) ->> 'name'),
          '大阪', '有正確邀請碼，沒登入也能看邀請預覽');
RESET ROLE;

-- ── 4. B 用邀請連結加入 ────────────────────────────────────────
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($$ SELECT app.accept_invite((SELECT v::uuid FROM ids WHERE k = 'trip'),
                                            (SELECT v FROM ids WHERE k = 'invite'), '小美') $$,
                '正確的邀請碼可以加入');
SELECT is((SELECT members FROM app.trips), ARRAY['代杰', '賢佑', '小美'], '新名字加進成員清單');
SELECT is((SELECT role FROM app.trip_members WHERE user_id = auth.uid()), 'editor', '被邀請的人是 editor');
SELECT lives_ok($$ SELECT app.set_my_member((SELECT v::uuid FROM ids WHERE k = 'trip'), '賢佑') $$,
                '可以切換成其他成員');
SELECT throws_ok($$ SELECT app.set_my_member((SELECT v::uuid FROM ids WHERE k = 'trip'), '不存在') $$,
                 'unknown_member', '不能切換成不存在的成員');
SELECT is((SELECT count(*) FROM app.expenses), 1::bigint, '成員看得到帳');
SELECT throws_ok($$ SELECT view_password_hash FROM app.trips $$, '42501', NULL, '誰都讀不到密碼雜湊');
SELECT throws_ok($$ UPDATE app.trips SET visibility = 'link' $$, '42501', NULL, '不能直接改分享設定');
SELECT throws_ok($$ UPDATE app.trips SET members = ARRAY['x'] $$, '42501', NULL, '不能繞過 RPC 直接改成員清單');
SELECT throws_ok($$ SELECT app.set_trip_visibility((SELECT v::uuid FROM ids WHERE k = 'trip'), 'link') $$,
                 'not_admin', '一般成員不能改分享設定');
SELECT throws_ok($$ SELECT app.rotate_trip_token((SELECT v::uuid FROM ids WHERE k = 'trip'), 'invite') $$,
                 'not_admin', '一般成員不能重設邀請連結');
DELETE FROM app.trip_members WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT is((SELECT count(*) FROM app.trip_members), 2::bigint, 'editor 移除不了別人（RLS 擋掉，owner 還在）');
UPDATE app.trips SET rates = '{"JPY": 1, "TWD": 4.8}';
SELECT is((SELECT rates ->> 'TWD' FROM app.trips), '4.8', '一般成員可以改匯率');
SELECT throws_ok($$ UPDATE app.trips SET name = '偷改名' $$, 'not_admin', '一般成員不能改旅程名稱');
SELECT throws_ok($$ SELECT app.update_trip_members((SELECT v::uuid FROM ids WHERE k = 'trip'), ARRAY['代杰', '賢佑', '小美', '新人'], '{}') $$,
                 'not_admin', '一般成員不能改成員名單');
SELECT throws_ok($$ SELECT app.set_member_role((SELECT v::uuid FROM ids WHERE k = 'trip'), auth.uid(), 'admin') $$,
                 'not_owner', '一般成員不能把自己升成管理員');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$ SELECT app.set_member_role((SELECT v::uuid FROM ids WHERE k = 'trip'), 'bbbbbbbb-0000-0000-0000-000000000002', 'admin') $$,
                '建立者可以指定管理員');
RESET ROLE;
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($$ UPDATE app.trips SET name = '大阪' $$, '管理員可以改旅程名稱');
SELECT throws_ok($$ SELECT app.set_member_role((SELECT v::uuid FROM ids WHERE k = 'trip'), 'aaaaaaaa-0000-0000-0000-000000000001', 'editor') $$,
                 'not_owner', '管理員不能動建立者的角色');
RESET ROLE;

-- ── 5. 改名會連帶改帳與認領 ───────────────────────────────────
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$ SELECT app.update_trip_members((SELECT v::uuid FROM ids WHERE k = 'trip'),
                                                  ARRAY['代杰', '阿佑', '小美'], '{"賢佑": "阿佑"}') $$,
                '改名成功');
SELECT is((SELECT split_data FROM app.expenses), '{"代杰": 1000, "阿佑": 1000}'::jsonb, '帳裡的名字跟著改');
SELECT is((SELECT member_name FROM app.trip_members WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
          '阿佑', '認領這個名字的帳號跟著改');
SELECT throws_ok($$ SELECT app.update_trip_members((SELECT v::uuid FROM ids WHERE k = 'trip'),
                                                   ARRAY['代杰', '小美'], '{}') $$,
                 'member_claimed', '有人認領的名字不能直接移除');
SELECT throws_ok($$ DELETE FROM app.trip_members WHERE user_id = auth.uid() $$,
                 'last_owner', '最後一位 owner 不能離開');

-- ── 6. LINE 帳號對應只看得到自己的 ─────────────────────────────
RESET ROLE;
INSERT INTO app.line_identities (line_user_id, user_id) VALUES ('Uaaa', 'aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*) FROM app.line_identities), 0::bigint, '看不到別人的 LINE 帳號');
SELECT throws_ok($$ INSERT INTO app.line_identities (line_user_id, user_id) VALUES ('Ubbb', auth.uid()) $$,
                 '42501', NULL, '不能自己綁 LINE 帳號（只有 auth-line 能寫）');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

-- ── 7. 分享連結 ────────────────────────────────────────────────
SELECT lives_ok($$ SELECT app.set_trip_visibility((SELECT v::uuid FROM ids WHERE k = 'trip'), 'password', 'secret1') $$,
                'owner 可以設成密碼模式');
RESET ROLE;
SELECT pg_temp.as_anon();
SELECT throws_ok($$ SELECT app.get_trip_snapshot((SELECT v::uuid FROM ids WHERE k = 'trip'),
                                                 (SELECT v FROM ids WHERE k = 'share'), 'wrong') $$,
                 'wrong_password', '密碼錯看不到');
SELECT is(jsonb_array_length(app.get_trip_snapshot((SELECT v::uuid FROM ids WHERE k = 'trip'),
                                                   (SELECT v FROM ids WHERE k = 'share'), 'secret1') -> 'expenses'),
          1, '連結和密碼都對就看得到帳');
SELECT ok(NOT (app.get_trip_snapshot((SELECT v::uuid FROM ids WHERE k = 'trip'),
                                     (SELECT v FROM ids WHERE k = 'share'), 'secret1') -> 'trip') ? 'invite_token',
          '分享出去的資料不含邀請碼');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
