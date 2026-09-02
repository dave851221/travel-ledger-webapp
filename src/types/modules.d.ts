declare module 'papaparse';

/**
 * Supabase Edge Function 走 Deno 的 URL import，TypeScript 無法解析。
 * supabase/functions/_shared/ 底下的模組會被 finance.parity.test.ts 引用，
 * 所以要讓 tsc 認得這個 specifier；實際執行時：
 *   - 部署到 Deno   → 真的從 esm.sh 載入
 *   - vitest 測試中 → 由 vitest.config.ts 的 alias 換成本機的 decimal.js
 */
declare module 'https://esm.sh/decimal.js@10.4.3' {
  export { default } from 'decimal.js';
}
