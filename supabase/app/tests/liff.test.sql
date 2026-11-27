-- ============================================================
-- 開放版 LIFF 讀草稿、佔用 nonce（app/08_liff.sql）—— pgTAP
-- ============================================================

BEGIN;
SELECT plan(9);

INSERT INTO auth.users (id, email, aud, role)
VALUES ('aaaaaaaa-0000-0000-0000-0000000000c1', 'lfa@test.local', 'authenticated', 'authenticated'),
       ('cccccccc-0000-0000-0000-0000000000c3', 'lfc@test.local', 'authenticated', 'authenticated');

CREATE FUNCTION pg_temp.as_user(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON ids TO authenticated;

SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000c1');
INSERT INTO ids SELECT 't', app.create_trip('LIFF 測試', ARRAY['甲'], '甲', 'TWD', ARRAY['餐飲'])::text;
RESET ROLE;

INSERT INTO app.line_user_states (line_user_id, current_trip_id) SELECT 'Cliff', v::uuid FROM ids WHERE k = 't';
INSERT INTO app.line_chat_history (line_user_id, role, content) VALUES ('Cliff', 'pending', 'not json');
INSERT INTO app.line_chat_history (line_user_id, role, content)
SELECT 'Cliff', 'pending', json_build_object('n', 'N1', 'tid', v, 'exp', json_build_object('d', '拉麵', 'a', 1200))::text FROM ids WHERE k = 't';

SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000c1');
SELECT is(app.liff_draft('Cliff', 'N1') -> 'draft' -> 'exp' ->> 'd', '拉麵', '成員讀得到草稿（壞掉的列跳過）');
SELECT is(app.liff_draft('Cliff', 'NOPE') -> 'draft', 'null'::jsonb, '找不到的 nonce 回 null');
SELECT is(app.liff_claim_nonce('Cliff', 'N1'), TRUE, '第一次佔用成功');
SELECT is(app.liff_claim_nonce('Cliff', 'N1'), FALSE, '第二次佔不到（不會重複存）');
SELECT is((app.liff_draft('Cliff', 'N1') ->> 'used')::boolean, TRUE, '佔用後顯示已處理');
SELECT lives_ok($$ SELECT app.liff_release_nonce('Cliff', 'N1') $$, '存檔失敗可以放掉');
SELECT is((app.liff_draft('Cliff', 'N1') ->> 'used')::boolean, FALSE, '放掉之後可以再存');
RESET ROLE;

SELECT pg_temp.as_user('cccccccc-0000-0000-0000-0000000000c3');
SELECT throws_ok($$ SELECT app.liff_draft('Cliff', 'N1') $$, 'not_member', '路人讀不到別人的草稿');
SELECT throws_ok($$ SELECT app.liff_claim_nonce('Cliff', 'N1') $$, 'not_member', '路人不能搶先佔用');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
