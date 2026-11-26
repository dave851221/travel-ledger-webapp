#!/usr/bin/env node
/**
 * 把 supabase/schema/ 底下編號的 SQL 片段串成單一 bootstrap.generated.sql，
 * 讓「從零架設」可以一次貼進 Supabase SQL Editor 執行。
 *
 * 編號檔案是唯一事實來源；generated 檔案請勿手動編輯。
 *
 * 用法：npm run db:build
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ── 開放版（旅行小本本）的 app schema ───────────────────────────
// 同樣的做法：supabase/app/schema/NN_*.sql → supabase/app/app.generated.sql
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'app');
const appSchemaDir = join(appDir, 'schema');
const appParts = readdirSync(appSchemaDir)
  .filter((f) => /^\d{2}_.*\.sql$/.test(f))
  .sort();

const appHeader = `-- =============================================================================
-- 旅行小本本（開放版）— app schema 初始化腳本
--
-- ⚠️ 自動產生，請勿手動編輯。
--    來源：supabase/app/schema/NN_*.sql
--    重新產生：npm run db:build
--
-- 舊版（public schema）完全不受影響；兩版共用同一個 Supabase 專案。
-- 本腳本可重複執行（idempotent）。規則見 docs/SECURITY.md。
-- =============================================================================

`;

const appBody = appParts
  .map((file) => {
    const sql = readFileSync(join(appSchemaDir, file), 'utf8').trimEnd();
    return `-- <<<<<<<<<< app/${file} <<<<<<<<<<\n\n${sql}\n`;
  })
  .join('\n\n');

writeFileSync(join(appDir, 'app.generated.sql'), `${appHeader}${appBody}\n`, 'utf8');

// 本機 Supabase（local/supabase）的初始化：舊版 + 開放版接在一起，當成唯一一支 migration。
// 必須是 migration 而不是 seed：API 啟動時 app schema 就要存在，seed 跑得比較晚。
// Supabase CLI 讀不到工作目錄以外的檔案，所以放一份在 local/supabase/migrations/（已 gitignore）
const localSeed = join(dirname(fileURLToPath(import.meta.url)), '..', 'local', 'supabase', 'migrations', '00000000000000_bootstrap.generated.sql');
mkdirSync(dirname(localSeed), { recursive: true });
writeFileSync(localSeed,`${header}${body}\n\n${appHeader}${appBody}\n`, 'utf8');
console.log('已產生 → local/supabase/migrations/00000000000000_bootstrap.generated.sql（本機測試用）');
console.log(`已產生 ${appParts.length} 個片段 → supabase/app/app.generated.sql`);
appParts.forEach((p) => console.log(`  · ${p}`));
