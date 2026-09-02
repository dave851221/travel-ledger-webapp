# Travel Ledger WebApp

多人旅遊記帳 PWA。建立旅程、登錄支出、自動結算，並可透過 LINE Bot 用自然語言或收據照片記帳。

- **前端**：React 19 + Vite + TypeScript + Tailwind CSS v4
- **後端**：Supabase（Postgres、Storage、Realtime、Edge Functions）
- **AI**：Gemini（LINE Bot 的自然語言解析與收據 OCR）
- **金額運算**：decimal.js，全程避開浮點數誤差

## 功能

- 多人付款 / 多人分攤，除不盡時由指定成員承擔餘數
- 多幣別與每幣別小數位數設定，統計時自動折算回主幣別
- 最少轉帳次數的結清建議，支援一鍵結清與手動結清
- 收據照片上傳（瀏覽器端壓縮）與全螢幕相簿預覽
- 24 小時軟刪除垃圾桶
- 每個旅程可掛載手工打造的行程頁（飯店、時程、地圖）
- PWA 離線支援與版本更新提示

## 快速開始

```bash
npm install
cp .env.example .env    # 填入 Supabase URL 與 anon key
npm run dev
```

資料庫初始化與 LINE Bot 部署見 **[docs/SETUP.md](docs/SETUP.md)**。

## 指令

```bash
npm run dev       # 開發伺服器
npm run build     # 型別檢查 + 正式建置
npm run lint      # ESLint
npm run preview   # 預覽建置結果
npm run db:build  # 重新產生資料庫初始化腳本
```

## 文件

| 文件 | 內容 |
| :--- | :--- |
| [CLAUDE.md](CLAUDE.md) | 架構、慣例與開發規則（AI 代理的入口） |
| [docs/SETUP.md](docs/SETUP.md) | 從零架設與部署 |
| [docs/DB_MAINTENANCE.md](docs/DB_MAINTENANCE.md) | 後台維運，含刪除旅程的步驟 |
| [docs/LINE_BOT.md](docs/LINE_BOT.md) | LINE Bot 行為規格 |
| [docs/ITINERARY_AUTHORING.md](docs/ITINERARY_AUTHORING.md) | 新增行程頁 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 待辦與已知風險 |
| [docs/MCP_SERVER_DESIGN.md](docs/MCP_SERVER_DESIGN.md) | MCP server 設計構想 |

## 專案結構

```
src/
├── api/          Supabase client
├── components/   Modal、ExpenseModal、ExpenseDetailModal、SettingsModal
├── features/
│   └── itinerary/  行程頁登錄檔與各旅程元件
├── pages/        Home、TripPortal、Dashboard、LiffEdit
├── types/
└── utils/        finance（decimal.js）、category、date

supabase/
├── schema/       資料庫結構（唯一事實來源）+ 自動產生的 bootstrap
├── migrations/   既有資料庫的增量變更
├── scripts/      手動執行的維運腳本
└── functions/    line-webhook（LINE Bot）、liff-notify
```

> ⚠️ 本專案沒有使用者帳號系統，RLS 目前為完全開放狀態，僅適合信任的親友圈使用。
> 詳見 [docs/ROADMAP.md](docs/ROADMAP.md)。
