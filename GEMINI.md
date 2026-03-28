# GEMINI.md - 旅遊記帳與行程網站專案背景 (Travel Ledger WebApp Context)

本文件為 AI 代理在處理 **Travel Ledger WebApp** 專案時提供必要的背景資訊與指令。

## 專案總覽 (Project Overview)
**Travel Ledger WebApp** 是一個極致精確、具備高度隱私的旅遊財務管理系統。支援從 UI 直接管理多個旅程，具備專業的「多人付款/多人分帳」、「公平餘數調整（處理小數點誤差）」以及透過 Supabase 實現的即時資料同步功能。

### 核心技術棧 (Core Tech Stack)
- **前端 (Frontend):** React 19 (Vite), TypeScript, Tailwind CSS (v4)
- **後端/資料庫 (Backend/Database):** Supabase (Postgres, Real-time, Storage)
- **路由 (Routing):** React Router v7
- **財務運算 (Financial Logic):** `decimal.js` (確保高精度運算)
- **工具庫 (Utilities):**
    - `lucide-react`: 現代化圖示庫
    - `browser-image-compression`: 前端圖片壓縮
    - `papaparse`: CSV 資料匯出與匯入
    - `recharts`: 動態統計圖表（開發預定）

## 架構與目錄結構 (Architecture & Directory Structure)
```text
src/
├── api/          # Supabase 客戶端與資料存取邏輯 (Data access logic)
├── components/   # 原子級 UI 元件 (Button, Modal, Card 等)
├── context/      # TripContext (儲存當前旅程狀態)
├── features/     # 功能模組 (Ledger, Stats, Itinerary)
├── hooks/        # 自定義 Hooks (useSplit, useExpenses)
├── pages/        # 主要頁面 (Home, TripPortal, Dashboard)
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
- **語言偏好:** 文件與對話使用**繁體中文**，程式碼與註解一律使用**英文**。
- **型別安全 (Type Safety):** 務必使用 TypeScript。在 `src/types/index.ts` 或各功能資料夾中定義介面。
- **財務精度 (Financial Precision):** 絕對禁止使用 JavaScript 原生浮點數處理金額。請透過 `src/utils/` 中的 `decimal.js` 工具進行運算。
- **樣式 (Styling):** 使用 Tailwind CSS (v4)。優先使用 Utility classes 而非自定義 CSS。
- **元件 (Components):** 使用 Functional components 搭配 Hooks。
- **API 調用:** 統一使用 `src/api/supabase.ts` 中定義的 Supabase 客戶端。
- **隱私防護:** 每個旅程透過 `access_code` 進行存取控制。在渲染敏感旅程資料前務必檢查驗證狀態。

## 資料庫結構 (Database Schema)
主要表格包含：
- `trips`: 儲存旅程元資料、成員以及幣別設定。
- `expenses`: 儲存交易詳情，包含以 JSON 格式儲存的多人付款與分帳數據。

詳細結構與 RLS 權限設定請參考 `SQL_SETUP.sql`。
