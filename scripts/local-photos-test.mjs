#!/usr/bin/env node
/**
 * 開放版照片（Edge Function tlb-photos）的本機流程測試。
 * 先跑：npm run db:local、npx supabase functions serve tlb-photos --workdir local --env-file local/supabase/.env --no-verify-jwt
 * .env 有 R2 金鑰時會真的傳到 R2（路徑在一趟測試旅程底下，最後整趟刪掉）；沒有就走本機 Storage。
 * 只連 http://127.0.0.1:54321。
 */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';

const env = Object.fromEntries(
  execSync('npx supabase status --workdir local -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/).filter(l => l.includes('=')).map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
    }),
);
const URL = env.API_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(URL || '')) { console.error('不是本機 Supabase，停止。'); process.exit(1); }
const KEY = env.ANON_KEY;
const FN = `${URL}/functions/v1/tlb-photos`;
const opts = { db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false } };

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failed += 1; };

async function user(email) {
  const c = createClient(URL, KEY, opts);
  const { data, error } = await c.auth.signUp({ email, password: 'test-password-1' });
  if (error) throw error;
  return { c, token: data.session.access_token };
}
const call = (token, body) => fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const upload = (token, tripId, bytes, type = 'image/jpeg', kind = 'expense') =>
  fetch(`${FN}?action=upload&tripId=${tripId}&kind=${kind}`, { method: 'POST', headers: { 'Content-Type': type, apikey: KEY, Authorization: `Bearer ${token}` }, body: bytes })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const stamp = Date.now();
const a = await user(`pa${stamp}@test.local`);
const b = await user(`pb${stamp}@test.local`);
const { data: tripId, error } = await a.c.rpc('create_trip', { p_name: '照片測試', p_members: ['甲'], p_my_name: '甲', p_base_currency: 'TWD', p_categories: ['餐飲'] });
if (error) throw error;

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const up = await upload(a.token, tripId, jpeg, 'image/jpeg', 'chat');
check(up.status === 200 && new RegExp(`^expenses/${tripId}/chat_[0-9a-f-]+\.jpg$`).test(up.body.path), `成員可以上傳（${up.status}）`);
const path = up.body.path;

check((await upload(b.token, tripId, jpeg)).status === 403, '不是成員不能上傳');
check((await fetch(`${FN}?action=upload&tripId=${tripId}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', apikey: KEY }, body: jpeg })).status === 401, '沒登入不能上傳');
check((await upload(a.token, tripId, jpeg, 'text/html')).status === 400, '不是圖片不收');

const signed = await call(a.token, { action: 'sign', paths: [path] });
const url = signed.body.urls?.[path];
check(signed.status === 200 && !!url, '成員拿得到簽名網址');
if (url) {
  const r = await fetch(url);
  const got = new Uint8Array(await r.arrayBuffer());
  check(r.ok && got.length === jpeg.length && got[0] === 0xff, `簽名網址讀得到照片（${r.status}）`);
}
const signedB = await call(b.token, { action: 'sign', paths: [path] });
check(signedB.status === 200 && !signedB.body.urls?.[path], '不是成員簽不到');

const { data: q } = await a.c.rpc('trip_usage', { p_trip_id: tripId });
check(q?.photos?.used === 1, `張數算到這張（${JSON.stringify(q?.photos)}）`);

check((await call(b.token, { action: 'remove', paths: [path] })).body.removed === 0, '不是成員刪不到');
check((await call(b.token, { action: 'remove_trip', tripId })).status === 403, '不是 owner 不能整趟刪');

const rm = await call(a.token, { action: 'remove', paths: [path] });
check(rm.body.removed === 1, '成員可以刪');
const { data: q2 } = await a.c.rpc('trip_usage', { p_trip_id: tripId });
check(q2?.photos?.used === 0, '刪掉後張數空出來');

const up2 = await upload(a.token, tripId, jpeg);
check(up2.status === 200, '再傳一張');
check((await call(a.token, { action: 'remove_trip', tripId })).status === 200, 'owner 可以整趟刪');
const s2 = await call(a.token, { action: 'sign', paths: [up2.body.path] });
const r2 = s2.body.urls?.[up2.body.path] ? await fetch(s2.body.urls[up2.body.path]) : null;
check(!r2 || r2.status === 404 || r2.status === 400, `整趟刪完照片不在了（${r2?.status}）`);

console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
