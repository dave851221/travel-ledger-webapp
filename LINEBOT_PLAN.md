# LINE Bot 自然語言記帳整合計畫 (LINEBOT_PLAN)

## 1. 專案目標
開發一個整合 LINE Messaging API、Supabase Edge Functions 與 **Gemini Pro** 的智慧記帳助手。讓使用者能透過自然語言（文字或語音）在旅遊途中快速記帳，並維持與網頁版完全一致的精確分帳邏輯與資料格式。

---

## 2. 核心架構與職責分工

### 2.1 網頁端 (Web Management)
*   **職責：** 建立旅程、管理成員、設定匯率、查看統計、進行結算、刪除/編輯錯誤資料。
*   **新增功能：** 在旅程設定頁面顯示專屬的 6 位數 `linebot_id`。

### 2.2 LINE 端 (Fast Entry)
*   **職責：** 快速錄入支出、設定個人預設記帳偏好、即時預覽 AI 解析結果。
*   **安全：** 綁定時須通過該旅程的 `access_code` 驗證，機制與網頁版一致。

### 2.3 後端 (Supabase Edge Functions)
*   **職責：** 接收 LINE Webhook、調用 **Gemini Pro API**、引用 `decimal.js` 計算精確分帳、處理資料庫讀寫。

---

## 3. 資料架構設計 (Database Schema)

### 3.1 `line_trip_id_mapping` (新表)
用於管理 `trip_id` 與對外顯示的短碼。
*   `trip_id`: UUID (Primary Key, Foreign Key to `trips.id`)
*   `linebot_id`: String (6 位隨機英數，具唯一性指標)
*   `created_at`: Timestamp

### 3.2 `line_user_states` (新表)
記錄 LINE 使用者目前綁定的旅程與狀態。
*   `line_user_id`: String (Primary Key, LINE 原始 ID)
*   `current_trip_id`: UUID (已成功綁定的旅程 ID)
*   `pending_trip_id`: UUID (輸入 ID 後，等待輸入密碼驗證中的旅程 ID)
*   `default_config`: Text (使用者的個人預設 Prompt)
*   `last_active_at`: Timestamp

---

## 4. 實作階段 (Phased Implementation)

### 第一階段：資料庫與網頁顯示 (Database & Web UI) - [已完成]
*   [x] **SQL 部署：**
    *   建立 `line_trip_id_mapping` 與 `line_user_states`。
    *   撰寫 PostgreSQL Function 與 Trigger，確保建立新旅程時自動生成 `linebot_id`。
*   [x] **網頁更新：**
    *   在 `SettingsModal.tsx` 新增區塊，獲取並顯示該旅程的 `linebot_id`。
    *   實作具備 Fallback 機制的「複製 ID」功能。
*   **驗證項目：** 建立新旅程後，確認資料庫有對應代碼，且網頁設定選單能正確顯示並成功複製。

### 第二階段：準備工作 (User Manual Setup) - [等待使用者執行]
*   [ ] **LINE Developer Console：**
    *   建立 Messaging API Channel。
    *   取得 `Channel Access Token`。
    *   取得 `Channel Secret`。
*   [ ] **Google AI Studio：**
    *   申請 **Gemini Pro API Key**。
*   [ ] **Supabase 環境變數設定：**
    *   在 Supabase Dashboard 設定以下 Secret：
        *   `LINE_CHANNEL_ACCESS_TOKEN`
        *   `LINE_CHANNEL_SECRET`
        *   `GEMINI_API_KEY`
*   **驗證項目：** 所有 API Key 準備就緒。

### 第三階段：LINE Webhook 與 雙重驗證綁定 (Connection & Auth)
*   [ ] **基礎 Webhook：** 建立 Edge Function 處理 LINE 訊息。
*   [ ] **驗證邏輯實作：**
    1.  輸入 `ID:XXXXXX` -> 檢查代碼，若存在則進入「待驗證密碼」狀態 (`pending_trip_id`)，Bot 詢問密碼。
    2.  輸入 `密碼` -> 比對 `trips.access_code`。
    3.  驗證成功 -> 正式綁定 `current_trip_id`，**主動告知目前所有成員的名字**。
    *   輸入 `斷開`：解除當前綁定，允許切換到另一個 `linebot_id`。
*   **驗證項目：** 模擬綁定流程，確認若密碼錯誤則無法綁定，正確則能成功看見成員清單。

### 第四階段：AI 智慧解析核心 (AI Engine - Gemini Pro)
*   [ ] **Prompt 工程：**
    *   使用 **Gemini Pro** 處理複雜語句。
    *   將「目前成員清單」、「使用者預設 Prompt」、「目標 JSON 格式」餵給 AI。
    *   **精度對齊：** Edge Function 引入 `decimal.js` 邏輯，處理分帳餘數，確保與 `src/utils/finance.ts` 一致。
*   [ ] **資訊追問機制：** 若 AI 判斷缺少關鍵資訊，則回傳追問文字。
*   **驗證項目：** 輸入「拉麵 3000 日幣，小明墊的，我跟小明平分」，AI 能拆解出符合 `expenses` 表的 JSON。

### 第五階段：Flex Message 與 互動優化 (Interactive UX)
*   [ ] **Flex Message 預覽：** 解析成功後，回傳 Flex Message 顯示：
    *   品項、金額(含幣別)、付款人明細、分帳明細。
    *   提供 `[✅ 確認存入]` 按鈕。
*   [ ] **預設設定指令：** 實作 `設定 [我的預設語句]` 功能（存入 `line_user_states.default_config`）。
*   **驗證項目：** 點擊「確認存入」後，網頁版 Dashboard 應立即同步出現該筆支出。

---

## 5. 技術注意事項

### 5.1 財務邏輯一致性
*   Edge Function 必須確保引用相同的 `decimal.js` 運算邏輯。
*   餘數承擔人 (`adjustment_member`) 預設邏輯需與網頁版同步。

### 5.2 Gemini Pro 額度管理
*   **提醒：** 務必確保 API 調用指向 `gemini-1.5-pro` 以發揮最高效能。

### 5.3 互動細節補充
*   **斷開/切換：** 使用者輸入新的 `ID:YYYYYY` 應自動覆蓋舊綁定，並重新觸發密碼詢問。
*   **資訊完整性：** AI 在解析時，若 `split_data` 加總不等於 `amount`，必須觸發追問或自動校正邏輯。
