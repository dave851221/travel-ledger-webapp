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
      registerType: 'autoUpdate',
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
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
              return 'vendor-react';
            }
            if (id.includes('decimal.js') || id.includes('papaparse') || id.includes('lucide-react')) {
              return 'vendor-utils';
            }
            if (id.includes('recharts')) {
              return 'vendor-charts';
            }
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
})
