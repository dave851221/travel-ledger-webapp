# GEMINI.md - 旅遊記帳與行程網站專案索引與運作指南

本文件為 AI 代理在處理 **Travel Ledger WebApp** 專案時的核心入口。它定義了專案的文件地圖、運作規範以及開發經驗累積。

---

## 1. 核心開發規則 (Core Rules)
- **【重大規則】功能完成同步**: 
  每當一個功能模組開發完成且通過驗證，**必須**將該功能的實作重點、關鍵邏輯或注意事項更新回本文件的「3. 專案功能實作紀錄」中。這能確保後續 AI 在接手維護或擴充時，能精準掌握既有系統的特性，避免重複錯誤。
- **【重大規則】問題與錯誤紀錄**:
  在開發過程中若遇到任何非預期的 Bug、環境問題或邏輯死角，**必須**將問題現象、根本原因以及最終解決方案記錄於本文件的「4. AI 運作經驗紀錄」中。這旨在建立專案的「錯誤知識庫」，防止未來重蹈覆轍。
- **【重大規則】視覺化提示優先**: 
  嚴禁在 WebAPP 中直接調用原生 `alert()` 或 `confirm()`。必須使用專案已封裝的 `Modal` 組件（用於確認動作）或 `showToast`（用於通知訊息），以維持一致的高質感視覺風格。
- **文件管理**: 
  - 專案架構、進度與未來規劃統一維護於 `PROJECT_PLAN.md`。
  - 完成任務後，應同步更新 `PROJECT_PLAN.md` 中的「已完成項目」。

---

## 2. 文件索引 (Document Index)
當你需要執行特定任務時，請先參閱以下對應文件：

| 文件名稱 | 用途描述 | 適用時機 |
| :--- | :--- | :--- |
| **`PROJECT_PLAN.md`** | **專案單一事實來源**。包含架構、功能清單、待修復問題與未來規劃。 | 了解系統架構、確認已實作細節與後續待辦。 |
| **`README.md`** | **專案門面與 Git 手冊**。提供快速啟動與 Git 常用/救命指令。 | 執行 Git 操作、需要提交範例時。 |
| **`SETUP_GUIDE.md`** | **環境架設指南**。包含 Supabase 設定、環境變數與 Edge Functions 部署。 | 設定新環境、部署 Webhook 時。 |
| **`SQL_SETUP.sql`** | **核心資料庫腳本**。定義 WebApp 基礎表格與 RLS。 | 初始化或檢查資料庫結構時。 |
| **`SQL_LINE_UPDATE.sql`**| **LINE Bot 資料庫擴充**。定義與 LINE 綁定相關的表格與邏輯。 | 處理 LINE Bot 資料對接時。 |
| **`supabase/functions/line-webhook/linebot.md`** | **LINE Bot 專屬說明**。定義機器人行為、架構與自我介紹。 | 修改 LINE Bot 邏輯或對話設定時。 |

---

## 3. 專案功能實作紀錄 (Feature Log)
*本區塊記錄各項功能的關鍵技術細節，由 AI 於功能完成時動態更新。*

- **高精度分帳引擎**: 整合 `decimal.js` 並封裝於 `src/utils/finance.ts`。嚴禁使用原生浮點數。
- **公平餘數調整**: 支援手動指派承擔成員 (`adjustment_member`)，確保 `Σ(分帳) == 總額`。WebAPP 與 LINE Webhook Edge Function 皆共用此演算法，並於寫入 DB 前做最後防線檢測。
- **動態行程註冊**: 透過 `src/features/itinerary/registry.ts` 根據旅程 ID 掛載對應組件。
- **誤刪恢復**: 使用 `deleted_at` 欄位實現 24 小時軟刪除機制。垃圾桶功能實作於 `Dashboard.tsx`。
- **最佳結算演算法**: 實作於 `Dashboard.tsx` (`calculateSettlements`)，能計算出團隊成員間最小轉帳次數的結清路徑。
- **即時同步**: 透過 Supabase Real-time channel 監聽 `expenses` 表的更動，並重新拉取資料更新畫面。
- **LINE 雙重驗證與防呆**: 綁定流程結合 6 位數 `linebot_id` 與旅程 `access_code`。Webhook 實作了基於 `nonce` 的 `line_processed_actions` 表，防止使用者重複點擊按鈕寫入多筆相同帳務。
- **PWA 支援**: 實作了離線橫幅警告與發現新版本自動提醒的邏輯。

---

## 4. AI 運作經驗紀錄 (Operational Lessons)
### Windows 環境
- 執行 `npm`, `npx` 容易遇到權限錯誤，請使用 `.cmd` 後綴。
### Supabase Edge Functions
- **【重大教訓】部署 Webhook 必須加上 `--no-verify-jwt`**：
  Supabase Edge Function 預設會驗證請求中的 Supabase JWT Token。LINE Messaging API 的 Webhook 呼叫不帶此 Token，因此若部署時未加 `--no-verify-jwt`，LINE Bot 會對所有訊息完全無回應，且 Supabase Dashboard 的函式日誌會顯示 `401 Unauthorized`。
  - **正確指令**：`supabase functions deploy line-webhook --no-verify-jwt`
  - **本機 node_modules 版本**：`node_modules/.bin/supabase functions deploy line-webhook --no-verify-jwt`
  - **症狀**：LINE 訊息無反應，後台看到 POST 401。
  - **修復**：重新以正確指令部署即可，無需修改程式碼或 Secrets。
- 修改 Secrets 後需重新部署以生效。
### 型別安全
- `reduce` 累加金額時，必須顯式轉型並提供初始值：`reduce<number>((a, b) => a + (Number(b) || 0), 0)`。
### 安全與授權
- 目前前端採用單純的密碼驗證並快取於 `localStorage`，加上資料庫 RLS 是全面開放的狀態，屬於**不安全**的架構，僅適合高度信任的親友使用。若需正式上線，必須導入完整的 Auth JWT 驗證機制。
- **【重大教訓】RLS 與 Trigger 權限**: 
  當在一個表（如 `trips`）上設置 Trigger 並在其中寫入另一個表（如 `line_trip_id_mapping`）時，若後者開啟了 RLS 且權限不足（例如僅允許 `SELECT`），則寫入操作會失敗。解決方案是將 Trigger 函數設定為 `SECURITY DEFINER`，使其以函數擁有者的權限執行，並確保目標表的 RLS 策略包含所需的權限（如 `FOR ALL` 或 `INSERT`）。

### 檔案編輯 (File Editing)
- **【重大教訓】精準編輯檔案**: 過去曾發生在修改檔案（如 `index.ts`）時，因不夠精準導致程式碼結尾重複（例如多出額外的 `catch` 與 `return` 區塊），引發語法錯誤（如 `Expression expected`）導致部署失敗。未來在使用 `replace` 或其他編輯工具時，**務必極度精準地鎖定要替換的舊字串**，並在修改後仔細檢查變更範圍，避免破壞原本的程式碼結構。