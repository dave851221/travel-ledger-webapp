#!/usr/bin/env node
/**
 * 把 supabase/schema/ 底下編號的 SQL 片段串成單一 bootstrap.generated.sql，
 * 讓「從零架設」可以一次貼進 Supabase SQL Editor 執行。
 *
 * 編號檔案是唯一事實來源；generated 檔案請勿手動編輯。
 *
 * 用法：npm run db:build
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'schema');
const outFile = join(schemaDir, 'bootstrap.generated.sql');

const parts = readdirSync(schemaDir)
  .filter((f) => /^\d{2}_.*\.sql$/.test(f))
  .sort();

if (parts.length === 0) {
  console.error(`找不到任何 NN_*.sql 片段於 ${schemaDir}`);
  process.exit(1);
}

const header = `-- =============================================================================
-- Travel Ledger WebApp — 完整資料庫初始化腳本
--
-- ⚠️ 自動產生，請勿手動編輯。
--    來源：supabase/schema/NN_*.sql
--    重新產生：npm run db:build
--
-- 用途：全新架設時，把整份貼進 Supabase SQL Editor 執行一次即可。
--       已在運作的資料庫請改走 supabase/migrations/。
--       兩者的關係見 docs/SETUP.md。
--
-- 本腳本可重複執行（idempotent）。
-- =============================================================================

`;

const body = parts
  .map((file) => {
    const sql = readFileSync(join(schemaDir, file), 'utf8').trimEnd();
    return `-- <<<<<<<<<< ${file} <<<<<<<<<<\n\n${sql}\n`;
  })
  .join('\n\n');

writeFileSync(outFile, `${header}${body}\n`, 'utf8');
console.log(`已產生 ${parts.length} 個片段 → supabase/schema/bootstrap.generated.sql`);
parts.forEach((p) => console.log(`  · ${p}`));
