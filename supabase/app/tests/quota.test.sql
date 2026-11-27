-- ============================================================
-- 用量上限與 AI 防濫用（app/05_quota.sql）—— pgTAP
-- 測試時把免費方案調小（2 筆／2 次 AI／1 張照片），整個 transaction 最後 ROLLBACK。
-- ============================================================

BEGIN;
SELECT plan(26);

UPDATE app.plan_limits SET max_entries = 2, max_ai_calls = 2, max_photos = 1 WHERE plan = 'free';
UPDATE app.ai_settings SET user_per_minute = 2, user_per_day = 100, global_daily_calls = 1000, enabled = TRUE;

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
SELECT throws_ok($$ UPDATE app.ai_settings SET enabled = TRUE $$, '42501', NULL, '動不了全站 AI 開關');
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
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'user:aaaa', 'text') ->> 'reason', 'rate_minute',
          '同一個人一分鐘內太多次就擋（被擋的不算這趟的次數）');
SELECT is((SELECT count(*)::int FROM app.ai_calls WHERE trip_id = (SELECT v::uuid FROM ids WHERE k = 't2')), 1,
          '被頻率限制擋下的沒有扣這趟');
SELECT throws_ok($$ SELECT app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'evil; drop', 'text') $$,
                 'invalid_actor', '奇怪的 actor 不收');
UPDATE app.ai_settings SET enabled = FALSE;
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'line:Uccc', 'text') ->> 'reason', 'ai_disabled',
          '總開關關掉就全部停');
UPDATE app.ai_settings SET enabled = TRUE, global_daily_calls = 3;
SELECT is(app.consume_ai((SELECT v::uuid FROM ids WHERE k = 't2'), 'line:Uccc', 'text') ->> 'reason', 'ai_disabled',
          '全站今天的次數用完就停');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
