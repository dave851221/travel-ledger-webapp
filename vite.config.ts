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

// 開放版（旅行小本本）：建置時設環境變數 VITE_APP_MODE=public（見 src/config/mode.ts）。
// 開發與封測期放在同一個 GitHub Pages 網站的 /next/ 底下。
const IS_PUBLIC_BUILD = process.env.VITE_APP_MODE === 'public';
const BASE = IS_PUBLIC_BUILD ? '/travel-ledger-webapp/next/' : '/travel-ledger-webapp/';
const PRODUCT = IS_PUBLIC_BUILD ? '旅行小本本' : '旅遊小本本';
// 開放版的圖示是旅行喵喵的頭貼（David 提供的美術，public/art/avatar.png 縮出來的 public/cat-*），舊版照舊是車票
const ICON = IS_PUBLIC_BUILD
  ? { favicon: 'cat-favicon.png', faviconType: 'image/png', apple: 'cat-apple-touch-icon.png', pwa192: 'cat-pwa-192.png', pwa512: 'cat-pwa-512.png', maskable: 'cat-pwa-maskable.png' }
  : { favicon: 'favicon.svg', faviconType: 'image/svg+xml', apple: 'apple-touch-icon.png', pwa192: 'pwa-192.png', pwa512: 'pwa-512.png', maskable: 'pwa-512.png' };

/** 開放版的 index.html：產品名稱、圖示、分享卡片網址換成旅行小本本 */
function publicHtml(): Plugin {
  return {
    name: 'public-html',
    transformIndexHtml: { order: 'pre', handler(html) {
      if (!IS_PUBLIC_BUILD) return html;
      return html
        .replaceAll('旅遊小本本', '旅行小本本')
        .replace('type="image/svg+xml" href="/favicon.svg"', `type="${ICON.faviconType}" href="/${ICON.favicon}"`)
        .replace('href="/apple-touch-icon.png"', `href="/${ICON.apple}"`)
        .replace('content="https://dave851221.github.io/travel-ledger-webapp/"', 'content="https://dave851221.github.io/travel-ledger-webapp/next/"');
    } },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    itineraryJson(),
    publicHtml(),
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
        // 舊版的 Service Worker 管整個 /travel-ledger-webapp/，開放版放在 /next/ 底下：
        // 不讓開的話，舊版會把 /next/ 的頁面也回成舊版的 index.html
        navigateFallbackDenylist: IS_PUBLIC_BUILD ? [] : [/^\/travel-ledger-webapp\/next\//],
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
        name: PRODUCT,
        short_name: PRODUCT,
        description: '多人旅遊記帳：一起記帳、多幣別換算，自動算出誰該給誰多少。',
        theme_color: '#14213d',
        background_color: '#edf0f4',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: ICON.pwa192, sizes: '192x192', type: 'image/png' },
          { src: ICON.pwa512, sizes: '512x512', type: 'image/png' },
          // The tile is full-bleed navy, so it survives the maskable safe-zone crop
          { src: ICON.maskable, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: ICON.favicon, sizes: 'any', type: ICON.faviconType },
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
