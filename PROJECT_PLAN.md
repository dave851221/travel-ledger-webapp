# Travel Ledger WebApp - 專案全指南 (Integrated Project Plan)

本文件整合了專案架構、開發進度、功能清單以及未來規劃，是本專案的單一事實來源 (Source of Truth)。

---

## 1. 專案總覽 (Project Overview)
打造一個極致精確、可自定義且支援即時協作的旅遊財務管理系統。具備專業的「多人付款/多人分帳」、「公平餘數調整」、PWA 離線支援，以及透過 AI 實現的 LINE Bot 自然語言快速記帳功能。

### 核心技術棧 (Core Tech Stack)
- **前端:** React 19 (Vite) + TypeScript + Tailwind CSS (v4)
- **路由:** React Router v7 (`HashRouter`)
- **圖表與圖示:** Recharts, Lucide React
- **後端/資料庫:** Supabase (Auth, DB, Storage, Real-time, Edge Functions)
- **財務運算:** `decimal.js` (確保高精度運算，杜絕浮點數誤差)
- **AI 引擎:** Gemini 1.5 Pro / Flash Lite (用於 LINE Bot 自然語言解析)
- **離線與效能:** `vite-plugin-pwa`, `browser-image-compression`

---

## 2. 系統架構與功能清單 (Architecture & Features)

### 2.1 基礎設施與 PWA
- **PWA 支援**: 包含安裝至主畫面提示、版本更新通知 Banner (`useRegisterSW`)，以及網路斷線時的離線狀態警告 (`navigator.onLine`)。
- **Real-time 同步**: 使用 Supabase 頻道監聽 `expenses` 表的變更，確保多位使用者同時操作時，畫面能即時更新。

### 2.2 首頁與旅程管理 (`Home.tsx`, `TripPortal.tsx`)
- **旅程建立**: 支援輸入名稱、成員清單 (逗號分隔)、主幣別 (TWD/JPY/USD/EUR) 及 4-6 位存取密碼 (`access_code`)。預設載入 6 大分類。
- **旅程列表**: 顯示所有旅程卡片，包含匯率資訊、成員人數、建立日期與「已封存 (唯讀)」狀態標籤。
- **門禁系統**: 進入特定旅程前需在 `TripPortal.tsx` 輸入 `access_code`。驗證成功後將狀態寫入 `localStorage` (`auth_{id}`)。

### 2.3 財務主控台 (`Dashboard.tsx`)
主控台分為五大頁籤 (Tab)，支援響應式設計與行動版底部導覽列：
1. **支出紀錄 (Ledger)**
   - **搜尋與過濾**: 支援文字搜尋 (描述、類別、成員) 與類別標籤快速篩選。
   - **分組顯示**: 依日期降冪分組，可摺疊收納，並顯示單日各幣別總花費。
   - **明細卡片**: 顯示金額、分類、付款人與分攤人。特殊處理「結清紀錄」使其視覺上有所區別。支援點擊照片開啟全螢幕輪播預覽。
2. **統計分析 (Stats)**
   - **總覽數據**: 頂部卡片顯示「總支出」、「我墊付」、「我應付」，並自動以 `rates` 匯率折算回主幣別。
   - **分類圓餅圖**: 使用 Recharts 顯示各分類佔比與總額。
   - **個人消費明細表**: 詳細列出每位成員在各分類的應付總額。
3. **結清指南 (Settlement)**
   - **最佳化結算演算法**: 自動計算成員間的淨結餘 (Balances)，並推算出「最少轉帳次數」的結清路徑 (誰該給誰多少錢)。
   - **一鍵結清與手動結清**: 支援點擊按鈕直接產生對應的「結清類型」支出紀錄，並扣除相應帳務。
4. **垃圾桶 (Recycle Bin)**
   - **軟刪除機制**: 刪除的支出會壓上 `deleted_at` 標記。垃圾桶僅顯示 24 小時內刪除的紀錄，並支援一鍵還原。
5. **行程規劃 (Itinerary)**
   - 動態載入專屬行程組件 (透過 `src/features/itinerary/registry.ts`)。

### 2.4 核心財務引擎 (`src/utils/finance.ts`)
- **高精度運算**: 全面使用 `decimal.js` 進行金額的加減乘除，防止 JavaScript 原生浮點數誤差 (如 `0.1 + 0.2`)。
- **公平餘數演算法 (`calculateDistribution`)**: 負責處理除不盡的金額。支援「鎖定金額 (Locked Data)」與「餘數承擔者 (Adjustment Member)」，確保分攤總和絕對等於總金額。
- **CSV 匯出**: 提供將支出明細匯出為 CSV 檔案的功能。

### 2.5 LINE Bot 整合 (`SQL_LINE_UPDATE.sql`, `line-webhook/index.ts`)
- **短碼綁定系統**: 自動為每個旅程產生 6 位數去混淆英數短碼 (`linebot_id`)。使用者輸入 `ID:短碼` 後，需再輸入旅程密碼進行雙重驗證綁定。
- **使用者狀態機 (`line_user_states`)**: 記錄 LINE 使用者的當前旅程、綁定中旅程與個人化指令偏好 (`default_config`)。
- **自然語言記帳 (Gemini AI)**: 
  - 解析使用者的隨意輸入 (例如：「午餐 500 小明付的」)，並結合資料庫的歷史對話上下文 (`line_chat_history`) 產出標準 JSON 格式。
  - 防呆機制：若旅程已封存，AI 會拒絕記帳指令。
- **Flex Message 與防重複提交**: 
  - 記帳前會回傳精美的 Flex Message 預覽卡片，要求使用者點擊確認。
  - 使用 `nonce` 與 `line_processed_actions` 資料表，防止使用者連點按鈕造成重複記帳。
  - **重要設計**: 邊緣運算 (Edge Function) 內部也實作了一套與 Webapp 相同的 `calculateDistribution` 演算法，在存入資料庫前進行最後的總額精確度校驗，若校驗失敗會拒絕寫入。

---

## 3. 開發進度 (Development Progress)

### ✅ 已完成項目 (Completed Milestones)
- [x] **基礎建設**: Vite + Tailwind v4 + Supabase 整合。
- [x] **隱私入口**: 首頁旅程列表與 `access_code` 密碼驗證。
- [x] **身分系統**: 「設定我為...」功能，高亮與我相關的支出。
- [x] **核心財務引擎**: 整合 `decimal.js`，實作多人付款/分帳與公平餘數指派。
- [x] **媒體管理**: 支援多圖壓縮上傳與全螢幕相簿預覽。
- [x] **誤刪恢復**: 24 小時緩衝期垃圾桶機制 (軟刪除)。
- [x] **統計與結算**: Recharts 分類圓餅圖、最小轉帳次數演算法、手動/一鍵結清。
- [x] **離線支援**: PWA 離線查看與版本更新通知。
- [x] **LINE Bot 整合**: SQL 短碼產生、雙重驗證綁定、Gemini AI 解析、防重複提交與邊緣運算精度校驗。
- [x] **收據 OCR 與照片同步**: 透過 LINE 上傳收據照片，AI 自動辨識品項/金額/日期，並同步壓縮上傳至 Supabase Storage，網頁版可即時查看。

### 🚧 進行中項目 (In Progress)
- 目前核心功能皆已實作完成，進入維護與問題修復階段。

---

## 4. 待確認 / 修復的問題清單 (Review Items)
*以下為原始碼分析過程中發現的潛在風險與問題，需逐一 Review 並決定是否修正。處理完成後方可移除。*

1. **[安全性] 前端身分驗證薄弱 (Auth Bypass)**
   - **問題**: `TripPortal.tsx` 僅將密碼驗證結果存在 `localStorage.getItem('auth_{id}')`。由於資料庫 RLS 設定為 `FOR ALL USING (true)`，任何知道 Trip ID 的人只要在瀏覽器開發者工具手動設定 localStorage，即可繞過密碼並具備讀寫權限。
   - **建議**: 應考慮導入 Supabase JWT 或將存取碼驗證移至後端/Edge Function，配合 RLS 策略確保資料安全。
2. **[邏輯] 垃圾桶 24 小時判斷依賴客戶端時間**
   - **問題**: `Dashboard.tsx` 在過濾 `deleted_at` 時，使用 `new Date()` (客戶端時間) 與資料庫時間做相減。若使用者設備時間不準，可能導致提早清空或一直保留。
   - **建議**: 考慮在 Supabase 建立一個 View 或在查詢時直接交由資料庫過濾 `deleted_at > NOW() - INTERVAL '24 HOURS'`。
3. **[UX/體驗] 登出與身分快取**
   - **問題**: 使用者身分 `currentUser` 存在 `localStorage`。如果清空快取，使用者將會失去其身分設定，需重新選擇。目前沒有大問題，但可考慮是否有更好的作法。

---

## 5. 未來規劃 (Future Works)

### 短期目標 (Short-term)
- 處理上述「待確認 / 修復的問題清單」。

### 長期願景 (Long-term)
- **行程規劃整合**: 將記帳與每日行程（景點導航）更緊密結合。
- **多帳號整合**: 正式導入 Supabase Auth 使用者系統，取代單純的 `access_code`。
