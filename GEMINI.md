# GEMINI.md - 旅遊記帳與行程網站專案背景 (Travel Ledger WebApp Context)

本文件為 AI 代理在處理 **Travel Ledger WebApp** 專案時提供必要的背景資訊、架構說明與開發指令。

## 1. 專案總覽 (Project Overview)
**Travel Ledger WebApp** 是一個極致精確、具備高度隱私的旅遊財務管理系統。支援從 UI 直接管理多個旅程，具備專業的「多人付款/多人分帳」、「公平餘數調整（處理小數點誤差）」以及透過 Supabase 實現的即時資料同步功能。其設計核心在於解決旅遊中複雜的交叉墊付與跨幣別結算問題。

### 核心技術棧 (Core Tech Stack)
- **前端 (Frontend):** React 19 (Vite), TypeScript, Tailwind CSS (v4)
- **狀態與路由:** React Router v7
- **後端/資料庫 (Backend/Database):** Supabase (Postgres, Real-time, RLS 權限控制)
- **檔案儲存 (Storage):** Supabase Storage (收據與旅遊圖片)
- **財務運算 (Financial Logic):** `decimal.js` (確保高精度運算，杜絕浮點數誤差)
- **離線與效能 (Offline & Performance):**
    - `vite-plugin-pwa`: Service Worker 離線快取與 Manifest 支援 (支援「添加到主畫面」)
    - `browser-image-compression`: 前端圖片壓縮，上傳至雲端前自動優化體積
- **數據與視覺化 (Data & Visualization):**
    - `recharts`: 分類消費圓餅圖、成員消費佔比統計圖表
    - `papaparse`: CSV 資料導出（支援 utf-8 BOM 避免 Excel 亂碼）
- **工具庫 (Utilities):**
    - `lucide-react`: 現代化、向量化的系統圖示庫

## 2. 核心功能機制 (Core Functional Mechanisms)

### 財務結算演算法
- **公平餘數調整 (Fair Remainder Adjustment):** 當總額無法除盡時，系統會計算 0.01 的餘數差異，並允許手動或自動指派給特定成員 (`adjustment_member`) 負擔，確保 `Σ(分帳明細) == 總額`。
- **最小轉帳次數演算法 (Minimal Settlement):** 結清時自動計算最優化的還款路徑（Debtors to Creditors），將總轉帳次數降至最低。
- **冗餘顯示優化 (Redundancy Optimization):** 若旅程僅使用單一幣別，系統在結算頁面會自動隱藏「獨立幣別結算」區塊，僅顯示「總結算」，保持視覺簡潔。
- **手動結清紀錄 (Manual Settlement):** 除了自動計算外，允許使用者手動新增結清動作（誰付給誰多少錢），直接修正餘額狀態。

### UI 與互動設計
- **身分選定系統 (Identity Selection):** 使用者可從「我」的身分選單中設定自己。選定後，系統會自動在支出列表高亮「與我相關」的應付金額，並在統計卡片顯示「我墊付」與「我應付」。
- **動態行程註冊 (Dynamic Itinerary):** 透過 `src/features/itinerary/registry.ts` 偵測旅程 ID 並動態掛載對應的行程組件（如：`Nagoya2026`, `Osaka2025`）。
- **誤刪恢復機制 (Soft Delete):** 支出記錄刪除後進入 24 小時緩衝期 (`deleted_at`)。使用者可從「垃圾桶」視圖一鍵還原。
- **封存模式 (Archiving):** 當旅程標記為 `is_archived` 時，全站介面切換至唯讀狀態，隱藏所有編輯按鈕。

## 3. 架構與目錄結構 (Architecture & Directory Structure)
```text
src/
├── api/          # Supabase 客戶端配置與公用 API 封裝
├── assets/       # 靜態資源 (Images, Logos)
├── components/   # 原子級 UI 元件 (Button, Modal, Card, Toast)
├── context/      # 全域狀態管理 (如 TripContext)
├── features/     # 功能模組化開發
│   ├── ledger/   # 記帳核心、分帳運算、精度校正邏輯
│   ├── stats/    # Recharts 圓餅圖組件與數據格式化邏輯
│   └── itinerary/# 行程顯示、動態組件註冊表 (Registry)
├── hooks/        # 自定義 Hooks (useSplit, useExpenses, useLocalStorage)
├── pages/        # 主要頁面路由組件 (Dashboard, Home, TripPortal)
├── types/        # TypeScript 定義 (Trip, Expense, Category, Rate)
└── utils/        # 工具函式
    ├── finance.ts # decimal.js 封裝、金額格式化 (formatAmount)
    └── storage.ts # 圖片壓縮與 Supabase 上傳邏輯
```

## 4. 資料庫結構 (Database Schema)

### `trips` 表格
- `members`: `string[]` (成員名稱清單)
- `rates`: `JSON` (匯率設定，e.g. `{"USD": 32.5, "JPY": 0.22}`)
- `precision_config`: `JSON` (幣別小數點精度，e.g. `{"TWD": 0, "USD": 2}`)
- `base_currency`: `string` (主結算幣別)
- `access_code`: `string` (存取控制密碼)

### `expenses` 表格
- `payer_data`: `JSON` (付款明細，支援多人墊付，e.g. `{"UserA": 100, "UserB": 50}`)
- `split_data`: `JSON` (分帳明細，e.g. `{"UserA": 75, "UserB": 75}`)
- `is_settlement`: `boolean` (標記是否為結清紀錄，結清紀錄不計入消費統計)
- `photo_urls`: `string[]` (儲存於 Supabase Storage 的路徑清單)
- `deleted_at`: `timestamp` (用於 24h 復原機制)

詳細結構與 RLS 權限設定請參考 `SQL_SETUP.sql`。

## 5. 開發規範與指令 (Development Mandate)

### 文件管理規範
- **持續累積性:** 每次任務結束後，必須更新 `PROJECT_PLAN.md` 與 `TODO_LIST.md`。
- **嚴禁刪除:** 除非是修正錯誤，否則嚴禁刪除既有的有效資訊。文件內容應隨專案進度日益詳盡。

### 檔案編輯規範
- **精準性優先:** 嚴禁頻繁盲目使用 `replace`。在執行編輯前，必須先透過 `read_file` 確認目標代碼的精確狀態、縮排與上下文。
- **區塊修復:** 優先使用 `write_file` 進行邏輯區塊的完整修復，避免因正則匹配失敗導致代碼殘缺。

### 技術偏好與標準
- **語言偏好:** 文件與對話使用**繁體中文**，程式碼、註解與變數命名一律使用**英文**。
- **型別安全:** 務必維持 100% TypeScript 覆蓋率，嚴禁使用 `any`。
- **財務精度:** **絕對禁止使用 JS 原生浮點數運算金額**。所有加減乘除必須透過 `src/utils/finance.ts` 中的工具函數或 `decimal.js` 處理。
- **樣式規範:** 使用 Tailwind CSS (v4) 的 Utility classes。需確保全站原生支援 **Dark Mode** 且具備流暢的響應式設計 (Mobile-First)。

### 6. 建置與執行 (Commands)
- **開發模式:** `npm run dev` (Vite 伺服器)
- **生產建置:** `npm run build` (包含型別檢查與代碼壓縮)
- **程式碼檢查:** `npm run lint` (ESLint 規則檢查)
- **預覽建置:** `npm run preview` (測試生產包效能與 PWA 行為)

### 7. AI 運作經驗紀錄 (AI Operational Lessons)
#### Windows 環境指令執行 (CLI Workaround)
- **問題描述:** 在 Windows PowerShell 環境下，執行 `.ps1` 腳本（如預設的 `npm`, `npx`, `tsc`）常會因執行原則 (Execution Policy) 導致 `UnauthorizedAccess` 錯誤。
- **解決方案:** AI 在執行 shell 指令時，若遇到權限錯誤，應優先嘗試在指令後加上 `.cmd` 後綴（例如：使用 `npm.cmd run build` 取代 `npm run build`，或 `npx.cmd tsc` 取代 `npx tsc`）。這能繞過 PowerShell 的腳本限制。

#### 財務計算型別安全 (Financial Type Safety)
- **問題描述:** 使用 `reduce` 計算 `Record<string, number | string>` 類型數據時，TypeScript 易誤推斷累加器型別。
- **解決方案:** 務必顯式指定 `reduce<number>((a, b) => a + (Number(b) || 0), 0)`，確保結果始終為數字，避免後續算術運算（如 `Math.abs`）報錯。

