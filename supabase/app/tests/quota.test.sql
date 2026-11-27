-- ============================================================
-- 用量上限與 AI 防濫用（app/05_quota.sql）—— pgTAP
-- 測試時把免費方案調小（2 筆／2 次 AI／1 張照片），整個 transaction 最後 ROLLBACK。
-- ============================================================

BEGIN;
SELECT plan(30);

UPDATE app.plan_limits SET max_entries = 2, max_ai_calls = 2, max_photos = 1 WHERE plan = 'free';
UPDATE app.quota_settings SET ai_enabled = TRUE, free_trip_creations = 3;

INSERT INTO auth.users (id, email, aud, role)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', 'qa@test.local', 'authenticated', 'authenticated'),
       ('cccccccc-0000-0000-0000-00000000000c', 'qc@test.local', 'authenticated', 'authenticated');

CREATE FUNCTION pg_temp.as_user(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON ids TO authenticated, service_role;

SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
INSERT INTO ids SELECT 't1', app.create_trip('額度一', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲'])::text;
INSERT INTO ids SELECT 't2', app.create_trip('額度二', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲'])::text;

-- ── 1. 記帳筆數 ────────────────────────────────────────────────
INSERT INTO app.expenses (id, trip_id, category, description, amount, currency)
SELECT ('00000000-0000-0000-0000-00000000000' || n)::uuid, (SELECT v::uuid FROM ids WHERE k = 't1'), '餐飲', 'x' || n, 100, 'TWD'
FROM generate_series(1, 2) n;
SELECT is((SELECT count(*)::int FROM app.expenses), 2, '上限內可以記');
SELECT throws_ok($$ INSERT INTO app.expenses (trip_id, category, description, amount, currency)
                   VALUES ((SELECT v::uuid FROM ids WHERE k = 't1'), '餐飲', '第三筆', 100, 'TWD') $$,
                 'entry_limit', '超過筆數上限就擋');
SELECT lives_ok($$ INSERT INTO app.expenses (trip_id, category, description, amount, currency, is_settlement)
                   VALUES ((SELECT v::uuid FROM ids WHERE k = 't1'), '結清', '結清', 100, 'TWD', TRUE) $$,
                '結清不算筆數，滿了也能記');
SELECT lives_ok($$ UPDATE app.expenses SET description = '改名' WHERE id = '00000000-0000-0000-0000-000000000001' $$,
                '滿了還是可以改既有的帳');
UPDATE app.expenses SET deleted_at = now() WHERE id = '00000000-0000-0000-0000-000000000001';
SELECT lives_ok($$ INSERT INTO app.expenses (trip_id, category, description, amount, currency)
                   VALUES ((SELECT v::uuid FROM ids WHERE k = 't1'), '餐飲', '刪一筆再記', 100, 'TWD') $$,
                '刪掉一筆就空出位置');
SELECT throws_ok($$ UPDATE app.expenses SET deleted_at = NULL WHERE id = '00000000-0000-0000-0000-000000000001' $$,
                 'entry_limit', '滿了不能從垃圾桶救回');
SELECT throws_ok($$ UPDATE app.expenses SET is_settlement = FALSE WHERE is_settlement $$,
                 'entry_limit', '不能把結清改成一般帳來繞過上限');

-- ── 2. 一般成員改不到方案、看不到 AI 紀錄 ─────────────────────
SELECT is((SELECT plan FROM app.trips WHERE id = (SELECT v::uuid FROM ids WHERE k = 't1')), 'free', '看得到自己的方案');
SELECT throws_ok($$ UPDATE app.trips SET plan = 'paid' $$, '42501', NULL, '不能自己改成付費');
SELECT throws_ok($$ UPDATE app.trips SET extra_ai_calls = 999 $$, '42501', NULL, '不能自己加量');
SELECT throws_ok($$ SELECT count(*) FROM app.ai_calls $$, '42501', NULL, '看不到 AI 呼叫紀錄');
SELECT throws_ok($$ UPDATE app.quota_settings SET ai_enabled = TRUE $$, '42501', NULL, '動不了全站設定');
SELECT throws_ok($$ SELECT app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't1'), 'user:x', 'text') $$,
                 '42501', NULL, '前端不能自己扣 AI 次數');
SELECT is((app.trip_usage((SELECT v::uuid FROM ids WHERE k = 't1')) -> 'entries' ->> 'used')::int, 2, '成員看得到用量');
RESET ROLE;
SELECT pg_temp.as_user('cccccccc-0000-0000-0000-00000000000c');
SELECT throws_ok($$ SELECT app.trip_usage((SELECT v::uuid FROM ids WHERE k = 't1')) $$, 'not_member', '路人看不到用量');
RESET ROLE;

-- ── 3. 照片張數 ────────────────────────────────────────────────
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
SELECT lives_ok($$ INSERT INTO storage.objects (bucket_id, name, owner_id)
                   VALUES ('app-images', 'expenses/' || (SELECT v FROM ids WHERE k = 't1') || '/a.jpg', auth.uid()::text) $$,
                '上限內可以上傳照片');
SELECT throws_ok($$ INSERT INTO storage.objects (bucket_id, name, owner_id)
                    VALUES ('app-images', 'expenses/' || (SELECT v FROM ids WHERE k = 't1') || '/b.jpg', auth.uid()::text) $$,
                 'photo_limit', '超過照片上限就擋');
RESET ROLE;

-- ── 4. AI 次數（Edge Function 用 service role 呼叫）──────────
SET LOCAL ROLE service_role;
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't1'), 'user:aaaa', 'receipt') ->> 'ok', 'true', '第 1 次可以');
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't1'), 'line:Ubbb', 'text') ->> 'ok', 'true', '第 2 次可以（不同人共用這趟）');
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't1'), 'user:aaaa', 'text') ->> 'reason', 'trip_limit', '這趟用完了');
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'user:aaaa', 'text') ->> 'ok', 'true', '別趟不受影響');
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'user:aaaa', 'text') ->> 'ok', 'true',
          '同一個人連續叫也只看這趟的次數（不限每個人）');
SELECT is((SELECT count(*)::int FROM app.ai_calls WHERE trip_id = (SELECT v::uuid FROM ids WHERE k = 't2')), 2,
          '每次都扣這趟');
SELECT throws_ok($$ SELECT app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'evil; drop', 'text') $$,
                 'invalid_actor', '奇怪的 actor 不收');
UPDATE app.quota_settings SET ai_enabled = FALSE;
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'line:Uccc', 'text') ->> 'reason', 'ai_disabled',
          '總開關關掉就全部停');
UPDATE app.quota_settings SET ai_enabled = TRUE;
RESET ROLE;

-- ── 5. 建立旅程的上限（測試設成 3 趟；已經建了 t1、t2）──────────
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
SELECT lives_ok($$ INSERT INTO ids SELECT 't3', app.create_trip('三', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲'])::text $$,
                '上限內可以建立');
SELECT throws_ok($$ SELECT app.create_trip('四', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲']) $$,
                 'trip_limit', '沒付過費的帳號超過上限就不能建立');
DELETE FROM app.trips WHERE id = (SELECT v::uuid FROM ids WHERE k = 't3');
SELECT lives_ok($$ SELECT app.create_trip('四', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲']) $$,
                '刪掉旅程會空出名額（David 2026-11-27）');
SELECT is((app.my_trip_allowance() ->> 'created')::int, 3, '看得到自己現在有幾趟');
RESET ROLE;
INSERT INTO app.paid_accounts (user_id) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a');
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
SELECT lives_ok($$ SELECT app.create_trip('五', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲']) $$, '付過費就不限');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
