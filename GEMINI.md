# GEMINI.md - 旅遊記帳與行程網站專案背景 (Travel Ledger WebApp Context)

本文件為 AI 代理在處理 **Travel Ledger WebApp** 專案時提供必要的背景資訊與指令。

## 專案總覽 (Project Overview)
**Travel Ledger WebApp** 是一個極致精確、具備高度隱私的旅遊財務管理系統。支援從 UI 直接管理多個旅程，具備專業的「多人付款/多人分帳」、「公平餘數調整（處理小數點誤差）」以及透過 Supabase 實現的即時資料同步功能。

### 核心技術棧 (Core Tech Stack)
- **前端 (Frontend):** React 19 (Vite), TypeScript, Tailwind CSS (v4)
- **後端/資料庫 (Backend/Database):** Supabase (Postgres, Real-time, Storage)
- **路由 (Routing):** React Router v7
- **財務運算 (Financial Logic):** `decimal.js` (確保高精度運算)
- **離線與效能 (Offline & Performance):**
    - `vite-plugin-pwa`: Service Worker 離線快取與 Manifest 支援
    - `browser-image-compression`: 前端圖片壓縮，上傳前自動優化
- **數據與視覺化 (Data & Visualization):**
    - `recharts`: 分類消費圓餅圖與統計圖表
    - `papaparse`: CSV 資料導出（支援 utf-8 BOM 避免亂碼）
- **工具庫 (Utilities):**
    - `lucide-react`: 現代化圖示庫

## 核心功能機制 (Core Functional Mechanisms)
- **公平餘數調整 (Fair Remainder Adjustment):** 當總額無法除盡時，系統會計算 0.01 的餘數差異，並允許手動或自動指派給特定成員 (`adjustment_member`) 負擔，確保 `Σ(分帳) == 總額`。
- **身分選定系統 (Identity Selection):** 提供「設定我為...」功能，高亮顯示與使用者相關的墊付與應付資訊。
- **最小轉帳次數演算法 (Minimal Settlement):** 結清時自動計算最優化的還款路徑，將轉帳次數降至最低。
- **動態行程註冊 (Dynamic Itinerary):** 透過 `src/features/itinerary/registry.ts` 偵測旅程 ID 並動態掛載對應的行程組件。
- **誤刪恢復與垃圾桶 (Soft Delete):** 支出記錄刪除後進入 24 小時緩衝期 (`deleted_at`)，可從垃圾桶視圖一鍵還原。
- **封存與唯讀模式 (Archiving):** 當旅程標記為 `is_archived` 時，介面會切換至唯讀狀態，隱藏所有編輯功能。

## 架構與目錄結構 (Architecture & Directory Structure)
```text
src/
├── api/          # Supabase 客戶端與資料存取邏輯 (Data access logic)
├── components/   # 原子級 UI 元件 (Button, Modal, Card 等)
├── context/      # TripContext (儲存當前旅程狀態與身分)
├── features/     # 功能模組
│   ├── ledger/   # 記帳、分帳運算核心邏輯
│   ├── stats/    # Recharts 圓餅圖與消費統計
│   └── itinerary/# 行程顯示與動態註冊 (Registry)
├── hooks/        # 自定義 Hooks (useSplit, useExpenses)
├── pages/        # 主要頁面 (Home, TripPortal, Dashboard, TrashBin)
├── types/        # TypeScript 型別定義 (Trip, Expense 等)
└── utils/        # 工具函式 (decimal.js 運算邏輯, 格式化工具)
```

## 建置與執行 (Building and Running)
### 先決條件 (Prerequisites)
- Node.js & npm
- Supabase 專案 (需要 URL 與 Anon Key)

### 指令 (Commands)
- **開發模式 (Development):** `npm run dev` (啟動 Vite 伺服器並支援 `--host`)
- **建置 (Build):** `npm run build` (型別檢查並進行生產環境建置)
- **程式碼檢查 (Linting):** `npm run lint` (執行 ESLint 檢查)
- **預覽 (Preview):** `npm run preview` (預覽生產環境建置結果)

### 環境變數 (Environment Variables)
請在根目錄建立 `.env` 檔案並填入以下內容：
```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## 開發規範 (Development Conventions)
- **文件管理規範 (Documentation Mandate):** 每次對話或任務結束後，必須主動評估並更新 `PROJECT_PLAN.md` 與 `TODO_LIST.md`。這些文件必須具備**累積性**，內容應日益詳盡完整，**嚴禁刪除既有的有效資訊或過度精簡**，僅允許修正錯誤或補充新細節。
- **檔案編輯規範 (Code Editing Mandate):** **嚴禁頻繁使用 `replace` 操作**，因其在複雜格式下極易出錯。**強制要求使用 `write_file` 進行覆寫或極其精準的區塊修復**，且在修復前必須先透過 `read_file` 確認目標代碼的精確狀態與上下文。
- **語言偏好:** 文件與對話使用**繁體中文**，程式碼與註解一律使用**英文**。
- **型別安全 (Type Safety):** 務必使用 TypeScript。在 `src/types/index.ts` 或各功能資料夾中定義介面。
- **財務精度 (Financial Precision):** 絕對禁止使用 JavaScript 原生浮點數處理金額。請透過 `src/utils/` 中的 `decimal.js` 工具進行運算。分帳運算必須確保 `precision_config` 與 `adjustment_member` 的正確應用。
- **樣式 (Styling):** 使用 Tailwind CSS (v4)。優先使用 Utility classes 而非自定義 CSS。全站原生支援 Dark Mode。
- **元件 (Components):** 使用 Functional components 搭配 Hooks。
- **API 調用:** 統一使用 `src/api/supabase.ts` 中定義的 Supabase 客戶端。
- **隱私防護:** 每個旅程透過 `access_code` 進行存取控制。在渲染敏感旅程資料前務必檢查驗證狀態。

## 資料庫結構 (Database Schema)
主要表格包含：
- `trips`: 儲存旅程元資料。
    - `members`: `string[]` 成員清單
    - `rates`: `JSON` 匯率設定 (e.g. `{"USD": 32.5}`)
    - `precision_config`: `JSON` 幣別精度 (e.g. `{"TWD": 0, "USD": 2}`)
- `expenses`: 儲存交易詳情。
    - `payer_data`: `JSON` 付款明細 (e.g. `{"UserA": 100}`)
    - `split_data`: `JSON` 分帳明細 (e.g. `{"UserA": 50, "UserB": 50}`)
    - `deleted_at`: `timestamp` 支援 24h 恢復機制

詳細結構與 RLS 權限設定請參考 `SQL_SETUP.sql`。
