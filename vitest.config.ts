import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      // Edge Function 走 Deno 的 URL import，Node 無法解析。
      // 把 deps.ts 換成 npm 版的替身，共用財務模組就能在 vitest 下被測試，
      // 用來與前端的實作做契約比對。
      //
      // 兩種寫法都要涵蓋：`./deps.ts`（_shared 內部）與
      // `../_shared/deps.ts`（line-webhook/guards.ts 為了算彙總而引用 Decimal）。
      {
        find: /^(?:\.\/|\.\.\/_shared\/)deps\.ts$/,
        replacement: fileURLToPath(
          new URL('./supabase/functions/_shared/deps.node.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    // 只測純函式，不需要 DOM
    environment: 'node',
    include: ['src/**/*.test.ts', 'supabase/**/*.test.ts'],
  },
});
