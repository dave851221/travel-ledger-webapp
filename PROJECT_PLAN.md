# 旅遊記帳與行程網站專案計畫 (Travel Ledger WebApp - 絕對完整累積版)

## 1. 專案目標
打造一個極致精確、具備高度隱私、可自定義且支援即時協作的旅遊財務管理系統。支援從 UI 直接管理多個旅程，具備專業的「多人付款/多人分帳」、「公平餘數調整」、「誤刪防護」與「離線支援」功能。

## 2. 技術選型
- **前端:** React (Vite) + TypeScript + Tailwind CSS (原生支援 Dark Mode)
- **資料庫/後端:** Supabase (Auth, DB, Storage, **Real-time 即時同步**)
- **財務運算:** **decimal.js** (確保小數點運算不失真，處理美金等非整數幣別)
- **離線支援:** Vite PWA Plugin (離線查看與操作)
- **工具庫:** 
    - **Recharts** (現代化動態統計圖表)
    - **browser-image-compression** (前端照片壓縮，節省流量與空間)
    - **PapaParse** (精準 CSV 資料匯出)
    - **Lucide React** (現代化圖示庫)
- **部署:** GitHub Pages + GitHub Actions

## 3. 目錄結構
```text
travel-ledger-webapp/
├── public/                # 靜態資源 (PWA Icons, Manifest)
├── src/
│   ├── api/               # Supabase API 客戶端與資料存取邏輯
│   ├── components/        # 原子級 UI 元件 (Button, Input, Modal, Card)
│   ├── context/           # TripContext: 儲存當前選定的旅程資訊與身分
│   ├── features/          # 主要功能模組
│   │   ├── ledger/        # 記帳、分帳運算、歷史紀錄
│   │   ├── stats/         # 統計圖表、清算指南
│   │   └── itinerary/     # 行程顯示 (預留插入點)
│   ├── hooks/             # 自定義 React Hooks (useSplit, useExpenses)
│   ├── layouts/           # 頁面佈局
│   ├── pages/             │   │   ├── Home.tsx       # 旅程列表首頁 (入口點)
│   │   ├── TripPortal.tsx # 密碼驗證頁面
│   │   ├── Dashboard.tsx  # 特定旅程主分頁 (記帳 + 統計)
│   │   └── TrashBin.tsx   # 垃圾桶 (24h 恢復區)
│   ├── types/             # TypeScript 型別定義
│   └── utils/             # 財務運算、格式化工具 (decimal.js logic)
├── PROJECT_PLAN.md
└── package.json
```

## 4. 資料架構規劃 (Supabase PostgreSQL)
### Table: `trips` (旅程清單)
- `id`: UUID (Primary Key)
- `name`: string (旅程名稱)
- `access_code`: string (4-6 位訪問密碼，簡單隱私防護)
- `members`: string[] (參與人員清單)
- `categories`: string[] (自定義分類清單)
- `base_currency`: string (主幣別)
- `rates`: JSON (該次旅程固定匯率設定)
- `precision_config`: JSON (定義各幣別保留位數, e.g., `{"TWD": 0, "USD": 2}`)
- `is_archived`: boolean (是否已封存，封存後僅供查看，不可新增、編輯、修改)
- `created_at`: timestamp

### Table: `expenses` (帳務紀錄)
- `id`: UUID
- `trip_id`: UUID (Foreign Key)
- `date`: date
- `category`: string
- `description`: string
- `amount`: numeric (總金額)
- `currency`: string (消費幣別)
- `payer_data`: JSON (多人付款明細, e.g., `{"UserA": 100, "UserB": 200}`)
- `split_data`: JSON (多人分帳明細, e.g., `{"UserA": 150, "UserB": 150}`)
- `adjustment_member`: string (手動指派承擔微小餘數的成員 ID)
- `photo_urls`: string[] (Supabase Storage 連結)
- `is_settlement`: boolean (是否為轉帳結清紀錄)
- `deleted_at`: timestamp (誤刪恢復機制，24 小時內可還原)

## 5. 核心功能細節
### A. 安全、隱私與多旅程管理
- **首頁入口:** 列出所有已建立的旅程連結。
- **訪問控制:** 進入特定旅程前需驗證 `access_code`。驗證成功後 Token 存入 `localStorage`。
- **UI 配置:** 在網頁介面直接新增/編輯旅程（人員、匯率、分類）。

### B. 高精確度分帳系統 (核心財務邏輯)
- **公平餘數處理 (The "Last Cent" Logic):** 
    - 使用 `decimal.js` 運算。當 `Σ(分帳) != 總額` 時，系統自動計算 0.01 差異。
    - 預設分配給第一人，但 UI 允許點擊成員頭像，自由指派餘數由誰承擔。
- **鎖定機制 (移植自 GAS):** 支援「百分比鎖定」與「金額鎖定」，系統自動平衡剩餘成員。
- **貨幣優化:** 自動顯示符號 ($/¥/£)，並動態調整輸入框小數點位數。

### C. 個人化視圖與即時同步
- **"Set as Me" 功能:** 使用者選定身分後，高亮顯示「我墊付」與「我應付」。
- **Real-time Sync:** Supabase 即時連動，一人記帳全家同步。

### D. 媒體、搜尋與篩選
- **照片壓縮:** 上傳前自動壓縮至 1MB 以下，支援多張照片並行上傳。
- **進階搜尋:** 支援描述關鍵字、分類、成員的多重篩選。

### E. 離線操作、Dark Mode 與還原
- **PWA 支援:** 離線查看與緩存。
- **Dark Mode:** 全站支援深色模式，保護夜間視力。
- **誤刪恢復:** 24 小時內可從垃圾桶一鍵還原。

### F. 資料匯出與結清
- **一鍵 CSV:** 導出該旅程專屬資料，嚴格隔離。
- **清算指南:** 實作「最少次數清算演算法」並提供一鍵生成結清紀錄功能。

### G. 行程網頁動態擴充機制 (Dynamic Itinerary)
- **設計邏輯**: 考慮到各旅程行程內容差異極大，採「隨插即用」模式。
- **實作方式**: 
    - 於 `src/features/itinerary/registry.ts` 維護一組 ID 對應表。
    - Dashboard 載入時偵測當前旅程 ID 是否有對應組件。
    - 若有，則解鎖「行程」分頁，否則隱藏。
- **開發位置**: 各別行程頁面放置於 `src/features/itinerary/trips/`。

### H. 封存與唯讀模式 (Archiving & Read-only)
- **邏輯控制**: 當 `trips.is_archived` 為 `true` 時：
    - Dashboard 隱藏「新增支出」、「編輯」、「刪除」以及「清算」按鈕。
    - 顯示「唯讀模式」提示標籤。
    - 確保歷史紀錄仍可供查詢與匯出。

## 6. 實施步驟
### 第一階段：基礎建設、隱私與 Dark Mode (已完成)
### 第二階段：Dashboard UI 佈局與分頁系統
1. 實作 `itinerary/registry.ts` 機構。
2. 建立 Dashboard 分頁系統 (支出、統計、結清、行程)。
3. 實作基礎統計資訊 (總支出、我墊付、我應付)。
### 第三階段：深度財務與分帳邏輯 (新增支出表單)
1. 整合 `decimal.js` 建立分帳運算引擎（鎖定邏輯與餘數處理）。
2. 實作高級記帳表單：支援多人付款、多人分攤與照片壓縮上傳。
### 第四階段：統計、結算與垃圾桶
1. 實作最少次數清算演算法與一鍵結清。
2. 實作 Recharts 統計儀表板與 `deleted_at` 還原機制。
### 第五階段：CSV 匯出與行程預留
1. 實作資料匯出模組。
2. 根據需求插入各別旅程的行程網頁。

## 7. 未來願景與擴充性 (Future Vision)
- **公費管理 (Kitty Pot):** 支援虛擬「公費」成員扣款與餘額追蹤。
- **AI 智慧記帳 & OCR:** 整合 AI 進行自然語言輸入與收據辨識自動填表。
- **多平台整合:** Line Bot / Telegram Bot 快速記帳介面。
