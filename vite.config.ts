import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer, defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * build 結束後把每趟旅程的行程輸出成 `dist/itinerary/<tripId>.json`，給 LINE Bot 讀
 * （見 src/features/itinerary/export.ts）。行程檔是 TS／TSX，要靠 Vite 的 SSR 載入才跑得動。
 */
function itineraryJson(): Plugin {
  let outDir = 'dist'
  return {
    name: 'itinerary-json',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      const server = await createServer({
        configFile: false,
        logLevel: 'error',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
        esbuild: { jsx: 'automatic' },
      })
      try {
        const mod = await server.ssrLoadModule('/src/features/itinerary/export.ts')
        const plans = mod.exportItineraries() as Record<string, unknown>
        const dir = path.join(outDir, 'itinerary')
        await mkdir(dir, { recursive: true })
        await Promise.all(Object.entries(plans).map(([tripId, json]) =>
          writeFile(path.join(dir, `${tripId}.json`), JSON.stringify(json))))
        console.log(`[itinerary-json] wrote ${Object.keys(plans).length} itineraries to ${dir}`)
      } finally {
        await server.close()
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/travel-ledger-webapp/',
  plugins: [
    react(),
    itineraryJson(),
    VitePWA({
      // prompt：新版本裝好後先等著，由 App.tsx 的橫幅讓使用者自己按「立即更新」。
      // autoUpdate 會直接重新整理頁面，剛打開 App、正在填支出表單時內容會被清掉。
      registerType: 'prompt',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Ensure Supabase storage images are handled correctly or cached if needed
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/v1\/object\/public\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-images-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 Days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
      manifest: {
        name: '旅遊小本本',
        short_name: '旅遊小本本',
        description: '多人旅遊記帳：一起記帳、多幣別換算，自動算出誰該給誰多少。',
        theme_color: '#14213d',
        background_color: '#edf0f4',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          // The tile is full-bleed navy, so it survives the maskable safe-zone crop
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  build: {
    // 解決分包過大問題，使用函式格式確保在所有 Vite 版本中相容
    rollupOptions: {
      output: {
        // 比對套件目錄而不是子字串：以前 `id.includes('react')` 會把 lucide-react 與
        // 圖表套件的 react-redux 一起塞進首頁必載的 vendor-react。
        // 圖表相關的不指定，讓它跟著延遲載入的統計分頁走。
        manualChunks(id) {
          // Vite 會把模組 id 正規化成正斜線（Windows 也一樣）
          const pkg = id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
          if (!pkg) return;
          if (['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'].includes(pkg)) return 'vendor-react';
          if (['decimal.js', 'lucide-react'].includes(pkg)) return 'vendor-utils';
          if (pkg === '@supabase/supabase-js' || pkg.startsWith('@supabase/')) return 'vendor-supabase';
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
})
