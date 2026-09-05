// deps.ts 的 Node 版替身，只在 vitest 執行時透過 alias 生效（見 vitest.config.ts）。
// 正式部署時 Deno 只會看到 deps.ts，這個檔案不會被打包。

export { default as Decimal } from 'decimal.js';
export { createClient, type SupabaseClient } from '@supabase/supabase-js';
