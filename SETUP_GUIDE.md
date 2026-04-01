# Travel Ledger WebApp - 架設與維護指南 (Setup Guide)

本文件為開發者或 AI 代理提供如何從零架設此專案並進行後續維護的詳細說明。

## 1. 環境需求 (Prerequisites)
- **Node.js**: v18.0.0 或更高版本
- **npm**: v9.0.0 或更高版本
- **Supabase 帳號**: 用於託管資料庫與檔案儲存空間

## 2. 快速開始 (Quick Start)

### A. 複製專案與安裝依賴
```bash
# 安裝依賴套件
npm install
```

### B. 設定環境變數
在根目錄建立 `.env` 檔案，並填入您的 Supabase 憑證：
```env
VITE_SUPABASE_URL=你的_SUPABASE_URL
VITE_SUPABASE_ANON_KEY=你的_SUPABASE_ANON_KEY
```

### C. 資料庫設定 (Supabase SQL)
請在 Supabase 的 SQL Editor 執行專案根目錄下的 `SQL_SETUP.sql`。該檔案包含：
- `trips` 與 `expenses` 資料表結構。
- 必要的 RLS (Row Level Security) 權限設定（目前設定為匿名存取，可視需求調整）。
- Storage Bucket `travel-images` 的建立說明。

### D. 啟動開發伺服器
```bash
npm run dev
```

## 3. 專案維護說明 (Maintenance)

### 如何擴充新的行程網頁？
1. 在 `src/features/itinerary/trips/` 建立新的 React 組件 (例如 `Osaka2026.tsx`)。
2. 在 `src/features/itinerary/registry.ts` 中將該組件與旅程的 UUID 進行註冊：
   ```typescript
   import Osaka2026 from './trips/Osaka2026';
   export const itineraryRegistry: Record<string, React.FC> = {
     'your-trip-uuid-here': Osaka2026,
   };
   ```

### 核心財務邏輯 (Finance Logic)
- 本專案嚴格禁止使用 JS 原生浮點數。
- 金額計算請統一使用 `src/utils/finance.ts` 中的工具函式，其底層由 `decimal.js` 驅動。

### PWA 更新
- 若修改了靜態資源或 Service Worker 邏輯，請確保 `vite.config.ts` 中的 `VitePWA` 配置正確。
- 部署後，使用者端會透過 `src/App.tsx` 中的 `useRegisterSW` 偵測並提示更新。

## 4. 版本控管建議 (Git)
### 建議忽略的檔案 (.gitignore)
- `node_modules/`
- `.env` (內含敏感 Key)
- `dist/` (編譯輸出)
- `.DS_Store`

### 必要的檔案
- `src/` (所有原始碼)
- `public/` (圖示與 Manifest)
- `package.json` & `package-lock.json`
- `vite.config.ts` & `tsconfig.json`
- `SQL_SETUP.sql` (資料庫結構)
- `PROJECT_PLAN.md` & `TODO_LIST.md` (開發紀錄)

## 5. LINE Bot 整合與部署 (Edge Functions)

### A. Supabase CLI 初始化 (第一次架設時)
若您的電腦尚未安裝或連結 Supabase，請執行以下步驟：
1. **安裝 CLI**: `npm install supabase --save-dev`
2. **登入帳號**: `npx supabase login` (會跳出瀏覽器要求授權)
3. **連結專案**: `npx supabase link --project-ref [您的_PROJECT_ID]` (Project ID 可在專案設定的 General 中找到)

### B. 環境變數設定 (Supabase Secrets)
請在 Supabase Dashboard 的 Edge Functions 設定中加入以下 Secrets：
- `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging API 的 Access Token。
- `LINE_CHANNEL_SECRET`: LINE Basic Settings 中的 Channel Secret。
- `GEMINI_API_KEY`: Google AI Studio 申請的 Gemini Pro API Key。

### C. 部署 Edge Function
在本地開發端執行：
```bash
# 部署 Webhook (務必加上 --no-verify-jwt 參數)
npx supabase functions deploy line-webhook --no-verify-jwt
```

### D. 設定 Webhook URL
1. 到 LINE Developers 控制台，進入您的 Channel -> Messaging API。
2. 在 **Webhook URL** 填入部署後的網址：`https://[PROJECT_ID].supabase.co/functions/v1/line-webhook`。
3. 開啟 **Use webhook** 選項。
4. 點擊 **Verify** 測試連通性。

## 6. 部署 (Deployment - WebApp)
專案已配置好支援 GitHub Pages 的生產環境打包。詳細步驟請參考 Git 教學說明。
