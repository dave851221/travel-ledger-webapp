#!/usr/bin/env node
/**
 * 把開放版既有的照片從 Supabase Storage（app-images）搬到 Cloudflare R2（2026-11-27）。
 *
 *   node scripts/migrate-photos-r2.mjs           複製還沒搬的（R2 放一份、app.trip_photos 記一列），Storage 那份先留著
 *   node scripts/migrate-photos-r2.mjs --delete  刪掉 Storage 裡已經搬好的（網頁與函式都換成 R2 之後再跑）
 *
 * 兩段分開跑，中間網頁不會有照片消失的空檔；張數不會重複算（count_photos 會略過表上已有的）。
 * 需要：環境變數 SUPABASE_ACCESS_TOKEN（Management API，拿 service key 與跑 SQL）；
 *       local/supabase/.env 的 R2_ACCOUNT_ID／R2_ACCESS_KEY_ID／R2_SECRET_ACCESS_KEY（R2_BUCKET 預設 tlb-photos）。
 * 不印出任何金鑰。可以重跑。
 */
import { readFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';

const REF = 'cdrjtthstteyruqmyrss';
const del = process.argv.includes('--delete');
const env = Object.fromEntries(readFileSync('local/supabase/.env', 'utf8').split(/\r?\n/)
  .map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2].replace(/^"|"$/g, '')]));
const M = { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: M, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error(`sql ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`, { headers: M })).json();
const key = (keys.find?.(k => k.name === 'service_role') || {}).api_key;
if (!key) { console.error('拿不到 service key（SUPABASE_ACCESS_TOKEN？）'); process.exit(1); }
const S = { Authorization: `Bearer ${key}`, apikey: key };
const STORAGE = `https://${REF}.supabase.co/storage/v1/object`;

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

if (del) {
  const rows = await sql(`select o.name from storage.objects o where o.bucket_id = 'app-images'
    and exists (select 1 from app.trip_photos p where p.path = o.name)`);
  console.log('Storage 裡已經搬好、要刪的', rows.length);
  let ok = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const r = await fetch(`${STORAGE}/app-images`, { method: 'DELETE', headers: { ...S, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: rows.slice(i, i + 100).map(x => x.name) }) });
    if (r.ok) ok += rows.slice(i, i + 100).length; else console.log('刪除失敗', r.status, (await r.text()).slice(0, 120));
  }
  console.log('已刪', ok);
  process.exit(0);
}

const r2 = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
const base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET || 'tlb-photos'}`;
const rows = await sql(`select o.name, o.owner_id, o.created_at, o.metadata->>'mimetype' as type
  from storage.objects o
  where o.bucket_id = 'app-images' and o.name ~ '^expenses/[0-9a-f-]{36}/[^/]+$'
    and split_part(o.name, '/', 2)::uuid in (select id from app.trips)
    and not exists (select 1 from app.trip_photos p where p.path = o.name)`);
console.log('要搬的', rows.length);
let ok = 0, fail = 0;
const done = [];
for (let i = 0; i < rows.length; i += 6) {
  await Promise.all(rows.slice(i, i + 6).map(async (row) => {
    try {
      const enc = row.name.split('/').map(encodeURIComponent).join('/');
      const g = await fetch(`${STORAGE}/authenticated/app-images/${enc}`, { headers: S });
      if (!g.ok) throw new Error(`download ${g.status}`);
      const body = new Uint8Array(await g.arrayBuffer());
      const p = await r2.fetch(`${base}/${enc}`, { method: 'PUT', body, headers: { 'Content-Type': row.type || 'image/jpeg' } });
      if (!p.ok) throw new Error(`r2 put ${p.status}`);
      done.push(row);
      ok++;
    } catch (e) {
      fail++;
      if (fail < 5) console.log('失敗', row.name, String(e));
    }
  }));
  // 每批記一次表（有些 owner 已經不存在：created_by 留空）
  if (done.length > 0) {
    const values = done.splice(0).map(r => `(${quote(r.name)}, ${quote(r.name.split('/')[1])}::uuid, ${r.owner_id ? quote(r.owner_id) + '::uuid' : 'NULL'}, ${quote(r.created_at)}::timestamptz)`).join(',');
    await sql(`insert into app.trip_photos (path, trip_id, created_by, created_at)
      select v.path, v.trip_id, (select id from auth.users where id = v.created_by), v.created_at
      from (values ${values}) as v(path, trip_id, created_by, created_at)
      on conflict (path) do nothing`);
  }
}
console.log('搬好', ok, '失敗', fail);
