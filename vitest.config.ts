import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      // Edge Function 走 Deno 的 URL import，Node 無法解析。
      // 把 deps.ts 換成 npm 版的替身，共用財務模組就能在 vitest 下被測試，
      // 用來與前端的實作做契約比對。
      {
        find: /^\.\/deps\.ts$/,
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
