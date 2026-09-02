import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'supabase/schema/bootstrap.generated.sql']),

  // 前端（瀏覽器 + React）
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },

  // Supabase Edge Functions（Deno，不是瀏覽器，也沒有 React）
  {
    files: ['supabase/functions/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.deno },
    },
    rules: {
      // 這裡處理的是 LINE webhook 事件、Gemini 回應與未產生型別的 Supabase 查詢結果，
      // 都是外部來源的未定型 payload。降為 warning 讓它保持可見但不擋 CI；
      // 真正的型別定義排在 Edge Function 模組化重構時一併處理（見 docs/ROADMAP.md）。
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // 建置腳本與設定檔（Node）
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
])
