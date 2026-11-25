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
      // autoUpdate：新版本裝好就直接換上並重新整理（使用者要求，2026-10-30）。
      // 正在填的表單會被清掉，這是接受的代價；離線佇列存在 localStorage，不受影響。
      // 曾改成 prompt（按橫幅才換），結果大家都停在舊版。
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // The recap video encoder (~1.7 MB) is only fetched when someone makes a video; don't make every install download it
        globIgnores: ['**/vendor-video-*.js'],
        // Ensure Supabase storage images are handled correctly or cached if needed
        runtimeCaching: [
          // Google Fonts：以前每次開啟都要先連到 Google 拿 CSS 才畫得出畫面（國外網路慢時整頁空白好幾秒）。
          // CSS 先用快取、背景更新；字型檔網址帶版本雜湊、內容不會變，直接用快取。
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              // Noto Sans TC 依 unicode-range 切成上百個小檔，三種字重
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 只快取不帶查詢字串的網址。回顧影片用 `?recap=1` 以 CORS 抓原圖：相簿的 <img> 是 no-cors，
            // 快取裡存的是 opaque 回應，CORS 請求拿到它會直接失敗（影片裡的照片就變成全黑）。
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/v1\/object\/public\/[^?]*$/i,
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
        // 回顧影片的編碼器（mediabunny）只在有人產生影片時才下載；改名成 vendor-video-* 好讓 PWA 不預先快取它。
        // 只改檔名不動分塊（manualChunks 會讓首頁 preload 它）。
        chunkFileNames(chunk) {
          // Vite normalises module ids to forward slashes (Windows too). A chunk may also hold a
          // bundler stub such as `__vite-browser-external`, which has no path.
          // heic-to (HEIC → JPEG for the closing photo, ~3 MB) is just as optional
          const isVideo = (id: string) => /\/node_modules\/(?:@mediabunny\/|mediabunny\/|heic-to\/)/.test(id);
          const ids = chunk.moduleIds;
          const video = ids.some(isVideo) && ids.every(id => isVideo(id) || !id.includes('/'));
          return video ? 'assets/vendor-video-[hash].js' : 'assets/[name]-[hash].js';
        },
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
