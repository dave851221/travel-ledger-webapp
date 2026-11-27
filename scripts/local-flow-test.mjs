#!/usr/bin/env node
/**
 * 開放版的整段流程測試，打本機 Supabase（npm run db:local 之後）：
 * 兩個帳號 + 一個路人 + 沒登入的人，從前端會用到的同一套 supabase-js 呼叫走一遍。
 * 跟 supabase/app/tests 的 pgTAP 互補：那邊直接在資料庫裡驗 RLS，這邊驗「透過 API」也一樣擋得住。
 *
 * 用法：node scripts/local-flow-test.mjs
 * 只會連 http://127.0.0.1:54321，連不到就停止 —— 絕不碰正式資料庫。
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
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(URL || '')) {
  console.error('不是本機 Supabase，停止。');
  process.exit(1);
}
const KEY = env.ANON_KEY;
const opts = { db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false } };

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed += 1;
};

async function user(email) {
  const c = createClient(URL, KEY, opts);
  const { error } = await c.auth.signUp({ email, password: 'test-password-1' });
  if (error) throw error;
  return c;
}

const run = Date.now();
const A = await user(`a${run}@test.local`);
const B = await user(`b${run}@test.local`);
const C = await user(`c${run}@test.local`);
const anon = createClient(URL, KEY, opts);

// ── A 建立旅程、記一筆、傳照片 ────────────────────────────────────
const { data: tripId, error: createErr } = await A.rpc('create_trip', {
  p_name: '測試旅程', p_members: ['甲', '乙'], p_my_name: '甲', p_base_currency: 'JPY',
  p_categories: ['餐飲'], p_precision_config: { JPY: 0 },
});
check(!createErr && typeof tripId === 'string', '建立旅程');
const { data: tripA } = await A.from('trips').select('id, name, members, precision_config, invite_token, share_token, visibility').eq('id', tripId).single();
check(tripA?.precision_config?.JPY === 0, '精度跟建立一起寫進去');
check(tripA?.visibility === 'members', '預設只有成員能看');

const { data: exp, error: expErr } = await A.from('expenses').insert({
  trip_id: tripId, category: '餐飲', description: '拉麵', amount: 2000, currency: 'JPY',
  payer_data: { 甲: 2000 }, split_data: { 甲: 1000, 乙: 1000 },
}).select('id, created_by').single();
check(!expErr && !!exp?.id, '成員可以記帳');

const photoPath = `expenses/${tripId}/test.png`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const { error: upErr } = await A.storage.from('app-images').upload(photoPath, png, { contentType: 'image/png' });
check(!upErr, '成員可以上傳照片到私有 bucket');
const { data: signedA } = await A.storage.from('app-images').createSignedUrls([photoPath], 60);
check(!!signedA?.[0]?.signedUrl, '成員拿得到照片的簽名網址');
const pub = await fetch(`${URL}/storage/v1/object/public/app-images/${photoPath}`);
check(!pub.ok, '私有照片沒有公開網址');

// ── 路人 C ───────────────────────────────────────────────────────
const { data: cTrips } = await C.from('trips').select('id').eq('id', tripId);
check((cTrips ?? []).length === 0, '路人查不到旅程');
const { data: cExp } = await C.from('expenses').select('id').eq('trip_id', tripId);
check((cExp ?? []).length === 0, '路人查不到帳');
const { error: cIns } = await C.from('expenses').insert({ trip_id: tripId, category: '餐飲', description: 'x', amount: 1, currency: 'JPY' });
check(!!cIns, '路人不能在別人的旅程記帳');
const { data: cSigned } = await C.storage.from('app-images').createSignedUrls([photoPath], 60);
check(!cSigned?.[0]?.signedUrl, '路人拿不到照片的簽名網址');
const { error: cUp } = await C.storage.from('app-images').upload(`expenses/${tripId}/evil.png`, png, { contentType: 'image/png' });
check(!!cUp, '路人不能上傳照片到別人的旅程');
const { error: cJoin } = await C.rpc('accept_invite', { p_trip_id: tripId, p_token: 'wrong', p_member_name: '路人' });
check(!!cJoin, '錯的邀請碼加入不了');

// ── 沒登入的人 ───────────────────────────────────────────────────
const { data: preview } = await anon.rpc('invite_preview', { p_trip_id: tripId, p_token: tripA.invite_token });
check(preview?.name === '測試旅程' && !('invite_token' in (preview ?? {})), '有邀請碼，沒登入也能看邀請預覽（只有名稱與成員）');
const { error: anonTrips } = await anon.from('trips').select('id');
check(!!anonTrips, '沒登入不能直接查資料表');
const { error: snapMembers } = await anon.rpc('get_trip_snapshot', { p_trip_id: tripId, p_token: tripA.share_token, p_password: null });
check(!!snapMembers, '只有成員模式時，分享連結無效');

// ── B 用邀請連結加入 ─────────────────────────────────────────────
const { error: joinErr } = await B.rpc('accept_invite', { p_trip_id: tripId, p_token: tripA.invite_token, p_member_name: '乙' });
check(!joinErr, 'B 用邀請連結加入並認領「乙」');
const { data: bExp } = await B.from('expenses').select('id, created_by').eq('trip_id', tripId);
check((bExp ?? []).length === 1, 'B 加入後看得到帳');
const { data: bSigned } = await B.storage.from('app-images').createSignedUrls([photoPath], 60);
check(!!bSigned?.[0]?.signedUrl, 'B 加入後拿得到照片');
const { error: bVis } = await B.rpc('set_trip_visibility', { p_trip_id: tripId, p_visibility: 'link', p_password: null });
check(!!bVis, 'editor 不能改分享設定');
const { error: bSwitch } = await B.rpc('set_my_member', { p_trip_id: tripId, p_member_name: '甲' });
check(!bSwitch, 'B 可以切換成其他成員');
const { data: bMe } = await B.from('trip_members').select('member_name, role').eq('trip_id', tripId);
check((bMe ?? []).length === 2, 'B 看得到兩位成員的加入紀錄');

// ── 分享連結 ─────────────────────────────────────────────────────
await A.rpc('set_trip_visibility', { p_trip_id: tripId, p_visibility: 'link', p_password: null });
const { data: snap } = await anon.rpc('get_trip_snapshot', { p_trip_id: tripId, p_token: tripA.share_token, p_password: null });
check(snap?.expenses?.length === 1 && !('share_token' in (snap?.trip ?? {})), '有連結就能看：沒登入看得到帳，且不含連結字串');
check(!JSON.stringify(snap).includes(exp.created_by ?? 'none'), '分享出去的資料不含帳號 id');
const { error: wrongToken } = await anon.rpc('get_trip_snapshot', { p_trip_id: tripId, p_token: 'nope', p_password: null });
check(!!wrongToken, '錯的分享連結看不到');
await A.rpc('set_trip_visibility', { p_trip_id: tripId, p_visibility: 'password', p_password: 'secret1' });
const { error: noPw } = await anon.rpc('get_trip_snapshot', { p_trip_id: tripId, p_token: tripA.share_token, p_password: null });
check(!!noPw && noPw.message.includes('wrong_password'), '密碼模式：沒密碼看不到');
const { data: withPw } = await anon.rpc('get_trip_snapshot', { p_trip_id: tripId, p_token: tripA.share_token, p_password: 'secret1' });
check(withPw?.expenses?.length === 1, '密碼模式：密碼對就看得到');
const { data: rotated } = await A.rpc('rotate_trip_token', { p_trip_id: tripId, p_kind: 'share' });
const { error: oldLink } = await anon.rpc('get_trip_snapshot', { p_trip_id: tripId, p_token: tripA.share_token, p_password: 'secret1' });
check(!!rotated && !!oldLink, '重設分享連結後舊連結失效');

// ── 改名 ─────────────────────────────────────────────────────────
const { error: bRename } = await B.rpc('update_trip_members', { p_trip_id: tripId, p_members: ['甲', '乙', '丙'], p_renames: {} });
check(!!bRename, '一般成員不能改成員名單');
const { error: renameErr } = await A.rpc('update_trip_members', { p_trip_id: tripId, p_members: ['阿甲', '乙'], p_renames: { 甲: '阿甲' } });
check(!renameErr, '建立者可以改名');
const { data: renamed } = await A.from('expenses').select('payer_data').eq('id', exp.id).single();
check(renamed?.payer_data?.['阿甲'] === 2000, '帳裡的名字跟著改');
const { data: aMe } = await A.from('trip_members').select('member_name').eq('trip_id', tripId).eq('user_id', (await A.auth.getUser()).data.user.id).single();
check(aMe?.member_name === '阿甲', '認領那個名字的帳號跟著改名');

// ── 收尾：A 刪掉旅程 ─────────────────────────────────────────────
await A.storage.from('app-images').remove([photoPath]);
const { error: delErr } = await A.from('trips').delete().eq('id', tripId);
check(!delErr, 'owner 可以刪除旅程');

console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
