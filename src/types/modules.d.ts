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

declare module 'https://esm.sh/@supabase/supabase-js@2.39.3' {
  export { createClient, type SupabaseClient } from '@supabase/supabase-js';
}

// Deno 的 npm: specifier 同理；vitest 中換成 devDependency 的那一份（版本要一致）
declare module 'npm:@anthropic-ai/sdk@0.135.0' {
  export { default } from '@anthropic-ai/sdk';
}
