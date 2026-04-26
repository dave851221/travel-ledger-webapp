# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用指令

```bash
npm run dev       # 啟動 Vite 開發伺服器（0.0.0.0:5173）
npm run build     # tsc --noEmit + vite build
npm run lint      # 對整個專案執行 ESLint
npm run preview   # 本機預覽正式建置結果
```

專案目前沒有自動化測試，Lint 是主要的程式碼品質把關工具。

**Supabase Edge Function（LINE Bot）：**
```bash
supabase functions serve line-webhook    # 本機開發 Edge Function
supabase functions deploy line-webhook   # 部署至 Supabase
```

## 架構概覽

這是一個多人旅遊記帳的 PWA。使用者建立旅程、登錄支出、並進行結算。整合 LINE Bot 後，可透過聊天訊息或收據照片記帳。

### 前端（React + Vite + TypeScript）

- **路由：** 使用 HashRouter，base path 為 `/travel-ledger-webapp/`（對應 GitHub Pages 部署）
- **頁面流程：** `Home` → `TripPortal`（通行碼驗證關卡）→ `Dashboard`
- **`Dashboard.tsx`** 是主要應用程式頁面（1100+ 行），包含 5 個分頁：帳目、統計、結算、行程、回收桶。所有 Supabase 即時訂閱與旅程狀態皆在此管理。
- **`ExpenseModal.tsx`** 負責支出的新增與編輯，包含付款人/分攤比例鎖定機制、多幣別輸入，以及瀏覽器端圖片壓縮上傳。
- **`LiffEdit.tsx`** 是獨立頁面，透過 LIFF（LINE Frontend Framework）嵌入在 LINE 應用程式的 WebView 中，共用相同的支出編輯邏輯。

### 財務計算引擎

`src/utils/finance.ts` 全面使用 **Decimal.js**，絕不使用原生浮點數。`calculateDistribution()` 函式處理餘數分配演算法：當金額無法整除時，餘數會指定給 `adjustment_member`。前端與 LINE Bot Edge Function 必須保持此邏輯同步（Edge Function 透過 esm.sh 引入 Decimal.js 重新實作相同邏輯）。

### 行程登錄檔模式

`src/features/itinerary/registry.ts` 將旅程 UUID 對應至自訂 React 元件。每個旅程可擁有手工製作的行程頁面（飯店、時程等）。新增旅程元件時，在 `src/features/itinerary/trips/` 建立元件後，依 UUID 在 registry 中登錄。

### 後端（Supabase）

- **資料庫：** `trips` 與 `expenses` 資料表含有 JSONB 欄位（`payer_data`、`split_data`、`rates`、`precision_config`）。軟刪除使用 `deleted_at` 欄位；結算紀錄以 `is_settlement` 標記。
- **即時同步：** `trips` 與 `expenses` 皆透過 `supabase_realtime` 發布，Dashboard 訂閱即時更新。
- **儲存空間：** `travel-images` bucket，收據照片路徑為 `expenses/{tripId}/{messageId}.jpg`。
- **驗證機制：** 未使用 Supabase Auth，旅程以明文 `access_code` 保護，驗證狀態存於 localStorage。RLS 政策目前為開放狀態（`FOR ALL USING (true)`）。

### LINE Bot Edge Function（`supabase/functions/line-webhook/index.ts`）

基於 Deno 的無伺服器函式，由 LINE Messaging API Webhook 觸發：

1. 以 `LINE_CHANNEL_SECRET` 驗證 HMAC-SHA256 簽章
2. **綁定流程：** 使用者傳送 `ID:A1B2C3` → 透過 `line_trip_id_mapping` 解析旅程 → 要求輸入通行碼 → 將 `current_trip_id` 寫入 `line_user_states`
3. **文字訊息：** 傳送給 Gemini（對話模式），回傳結構化 JSON 以建立支出
4. **圖片訊息：** 從 LINE CDN 下載並上傳至 Supabase Storage，由 Gemini（OCR 模式）分析，以 LINE Flex Message 回傳含確認/取消按鈕的預覽
5. **Postback 動作：** 按鈕含有 `nonce`，寫入 `line_processed_actions` 防止重複送出
6. **群組聊天：** 僅在 @提及或出現關鍵字「耀西」時回應

**Edge Function 所需密鑰：** `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`GEMINI_API_KEY`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。

## 重要慣例

- **幣別精確度：** 每個旅程儲存 `precision_config`，格式為 `{ "TWD": 0, "JPY": 0, "USD": 2 }`。務必使用 `finance.ts` 中的 `formatAmount()`，不要直接呼叫 `.toFixed()`。
- **JSONB 欄位：** `payer_data` 與 `split_data` 格式為 `{ 成員名稱: 金額 }`，成員名稱為純字串（例如 `"代杰"`），而非 ID。
- **Postback 資料限制：** LINE postback data 上限為 300 bytes。Edge Function 建立 postback 時使用單字母縮寫鍵（`d`、`a`、`c`、`p`、`s`、`n`）以節省空間。
- **Tailwind CSS v4：** 使用 `@tailwindcss/postcss` plugin（非 v3 CLI），設定分別在 `tailwind.config.js` 與 `postcss.config.js`。
- **ESLint 平面設定：** 設定檔為 `eslint.config.js`（非 `.eslintrc`），提交前請執行 `npm run lint`。

## 部署方式

- **前端：** 透過 `.github/workflows/deploy.yml` 部署至 GitHub Pages，推送至 `main` 分支時自動觸發。
- **Edge Function：** 執行 `supabase functions deploy line-webhook` 部署，Webhook URL 須在 LINE Developer Console 中登錄。
- **環境變數：** `.env` 含 `VITE_SUPABASE_URL` 與 `VITE_SUPABASE_ANON_KEY`；Edge Function 密鑰透過 `supabase secrets set` 設定。
