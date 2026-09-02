# CLAUDE.md

給 AI 代理（Claude Code / Gemini 等）在這個 repo 工作時的指引。這是唯一的入口文件。

## 文件索引

| 文件 | 內容 | 何時看 |
| :--- | :--- | :--- |
| **本檔** | 架構、慣例、開發規則、踩坑紀錄 | 動手改任何東西之前 |
| [`docs/SETUP.md`](docs/SETUP.md) | 從零架設、資料庫初始化、Edge Function 部署 | 建新環境、部署時 |
| [`docs/DB_MAINTENANCE.md`](docs/DB_MAINTENANCE.md) | 後台維運（**刪除旅程**、清理孤兒照片、重設 LINE 綁定） | 需要手動操作資料庫時 |
| [`docs/LINE_BOT.md`](docs/LINE_BOT.md) | LINE Bot 行為規格與自我介紹全文 | 改機器人邏輯或對話時 |
| [`docs/ITINERARY_AUTHORING.md`](docs/ITINERARY_AUTHORING.md) | 如何新增一個旅程行程頁 | 要做新行程頁時 |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 待辦、已知風險、未來規劃 | 想知道什麼還沒做、哪裡有雷 |
| [`docs/MCP_SERVER_DESIGN.md`](docs/MCP_SERVER_DESIGN.md) | MCP server 設計構想 | 規劃 LINE 以外的記帳管道時 |

---

## 常用指令

```bash
npm run dev       # Vite 開發伺服器（--host，區域網路可連）
npm run build     # tsc -b + vite build
npm run lint      # ESLint 掃整個專案
npm run preview   # 本機預覽正式建置結果
npm run db:build  # 由 supabase/schema/ 重新產生 bootstrap.generated.sql
npm test          # Vitest（純函式，不含 UI）
npm run test:watch
npm run check:functions  # 用 Deno 對 Edge Function 做型別檢查
```

提交前請跑 `npm run lint && npm test && npm run check:functions && npm run build`
—— CI 這四關都會擋。測試只涵蓋 `src/utils/` 的純函式與跨實作的契約比對，
沒有元件層級的測試。

`tsc` 只看得到 `src/`，Edge Function 是 Deno 程式碼，必須用 `check:functions`
才檢查得到 —— 這個專案踩過「部署後靜默失效」的坑，別跳過這一關。

**Supabase Edge Function：**

```bash
supabase functions serve line-webhook                       # 本機開發
supabase functions deploy line-webhook --no-verify-jwt      # 部署（旗標必填！）
```

---

## 核心開發規則

- **禁用原生 `alert()` / `confirm()`。** 一律使用專案封裝的 `Modal` 元件（確認動作）
  或 `showToast`（通知訊息），以維持一致的視覺風格。
  （註：`Home.tsx` 的建立旅程錯誤處理目前仍在用 `alert`，是待修正的例外。）
- **金額運算一律走 `decimal.js`**，絕不使用原生浮點數。詳見下方「財務計算引擎」。
- **改資料庫結構要動兩個地方**：`supabase/schema/NN_*.sql`（跑 `npm run db:build` 重新產生 bootstrap）
  以及一支新的 `supabase/migrations/`。詳見 [`docs/SETUP.md`](docs/SETUP.md)。
- **編輯檔案務必精準。** 曾發生因為替換字串不夠精確，導致 `index.ts` 結尾多出重複的
  `catch` / `return` 區塊、語法錯誤而部署失敗。修改後請確認變更範圍。
- 完成功能後，把會影響後續維護的關鍵資訊更新回本檔或對應的 `docs/` 文件。

---

## 架構概覽

多人旅遊記帳 PWA。建立旅程 → 登錄支出 → 結算。整合 LINE Bot 後可透過聊天訊息或收據照片記帳。

### 前端（React 19 + Vite + TypeScript + Tailwind v4）

- **路由**：HashRouter，base path `/travel-ledger-webapp/`（對應 GitHub Pages）
- **頁面流程**：`Home` → `TripPortal`（通行碼關卡）→ `Dashboard`
- **`Dashboard.tsx`** 是主畫面，目前約 **1460 行**，包含 **6 個分頁**：
  帳目（ledger）、統計（stats）、結算（settlement）、行程（itinerary）、
  回收桶（recycle）、其他旅程（siblings，同 `category` 的旅程）。
  所有 Supabase 即時訂閱、旅程狀態、六個 Modal 與 30 個 `useState` 都在這一個元件裡。
  **這是專案最大的技術債**，新增功能時優先考慮抽成獨立元件而非繼續往裡面塞。
- **`ExpenseModal.tsx`**：支出新增與編輯。付款人/分攤的鎖定機制、多幣別、
  瀏覽器端圖片壓縮上傳。網頁與 LIFF 共用同一個元件。
- **`SettingsModal.tsx`**：旅程設定（成員、匯率、精度、分類、預設值、CSV 匯出、LINE 短碼）。
  **所有旅程層級的寫入都在這裡**，Dashboard 只負責重新抓取。
- **`LiffEdit.tsx`**：獨立頁面，透過 LIFF 嵌在 LINE App 的 WebView 中，
  把 URL 裡 base64url 編碼的草稿餵給 `ExpenseModal` 重用整個編輯器。

### 財務計算引擎

`src/utils/finance.ts` 全面使用 **Decimal.js**。`calculateDistribution()` 處理餘數分配：
金額除不盡時，餘數指定給 `adjustment_member`，確保 `Σ(分攤) === 總額`。

結清演算法在 `src/utils/settlement.ts`（`calculateSettlements`）。

⚠️ **這兩套邏輯各有兩份實作**：前端在 `src/utils/`，LINE Bot 在
`supabase/functions/_shared/finance.ts`。無法直接共用同一個檔案 ——
前端走 npm 的 decimal.js，Edge Function 走 esm.sh 的 URL import。

**改任何一邊都必須同步另一邊**，但現在有 `src/utils/finance.parity.test.ts`
這支契約測試會用大量隨機輸入比對兩份實作，漂移會直接讓 CI 失敗。
`_shared/deps.ts` 那層間接就是為了讓測試能在 Node 下載入 Deno 的模組。

### 行程登錄檔模式

`src/features/itinerary/registry.ts` 把旅程 UUID 對應到自訂 React 元件，
每個旅程可以有手工打造的行程頁（飯店、時程、地圖等）。
新增方式見 [`docs/ITINERARY_AUTHORING.md`](docs/ITINERARY_AUTHORING.md)。

### 後端（Supabase）

- **資料庫**：`trips` 與 `expenses` 含 JSONB 欄位（`payer_data`、`split_data`、`rates`、
  `precision_config`）。軟刪除用 `deleted_at`（僅 expenses 有），結清紀錄以 `is_settlement` 標記。
  結構定義在 [`supabase/schema/`](supabase/schema/)。
- **即時同步**：`trips` 與 `expenses` 都在 `supabase_realtime` 發布中，Dashboard 訂閱更新。
- **儲存空間**：`travel-images` bucket，路徑 `expenses/{tripId}/{檔名}`。
  這個前綴慣例被 `supabase/scripts/delete_trip.sql` 依賴，勿隨意更動。
- **驗證機制**：未使用 Supabase Auth。通行碼驗證透過 RPC `verify_trip_code(p_trip_id, p_code)`
  在伺服器端完成，`access_code` 不會傳到瀏覽器。結果以 `auth_{tripId}` 存在 localStorage。
  **RLS 目前全面開放（`FOR ALL USING (true)`），實際上沒有保護作用** —— 見 [`docs/ROADMAP.md`](docs/ROADMAP.md)。
- **旅程密碼為選填**：`access_code` 為 `NULL` 或全空白即代表免密碼旅程。
  判斷一律用 trim 後是否為空字串，寫入時空值統一存成 `NULL`
  （前端 `access_code.trim() || null`，Edge Function `requiresAccessCode()`）。
  免密碼時：`TripPortal` 透過 RPC `trip_requires_code()` 得知後直接放行；
  LINE Bot 收到 `ID:XXXXXX` 後直接完成綁定，不再要求通行碼。
- **刪除旅程沒有前端功能**，只能從後台執行，見 [`docs/DB_MAINTENANCE.md`](docs/DB_MAINTENANCE.md)。

### LINE Bot Edge Function

`supabase/functions/line-webhook/index.ts`（約 1300 行，Deno）：

1. 以 `LINE_CHANNEL_SECRET` 驗證 HMAC-SHA256 簽章
2. **綁定**：使用者傳 `ID:A1B2C3` → 查 `line_trip_id_mapping` → 要求通行碼 →
   寫入 `line_user_states.current_trip_id`
3. **文字訊息**：先比對快捷指令（直接查 DB），其餘交給 Gemini 回傳結構化 JSON
4. **圖片訊息**：從 LINE CDN 下載 → 上傳 Storage → Gemini OCR → Flex Message 預覽卡片
5. **Postback**：按鈕帶 `nonce`，寫入 `line_processed_actions` 防止重複送出
6. **群組**：預設僅在 @提及或訊息以「耀西」開頭時回應，可切換為全回應模式。
   群組成員共用同一份綁定與偏好（刻意的設計），但每次互動都會記錄實際發言者。

**AI 回傳的內容一律先驗證再落地**：成員名稱做模糊比對後對應回正式名稱、
幣別比對旅程 `rates` 與 ISO 白名單、日期檢查格式與合理範圍。
任何被修正的欄位都會告知使用者，不會默默改掉。細節見 [`docs/LINE_BOT.md`](docs/LINE_BOT.md)。

行為規格詳見 [`docs/LINE_BOT.md`](docs/LINE_BOT.md)。

**所需密鑰**：`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`GEMINI_API_KEY`、
`WEBAPP_URL`（`SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 由平台自動注入）。

---

## 重要慣例

- **幣別精確度**：每個旅程存 `precision_config`，格式 `{ "TWD": 0, "JPY": 0, "USD": 2 }`。
  一律使用 `finance.ts` 的 `formatAmount()`，不要直接呼叫 `.toFixed()`。
- **JSONB 欄位**：`payer_data` 與 `split_data` 是 `{ 成員名稱: 金額 }`，
  key 是**純字串顯示名稱**（例如 `"代杰"`）而非 ID。因此改成員名稱時必須把所有支出的
  JSONB 一起改寫（`SettingsModal.tsx` 已有實作）。
- **`Trip.category` 與 `Trip.categories` 是兩回事**：前者是旅程自己的分組（首頁分組用），
  後者是這趟旅程的支出分類清單。
- **`photo_urls` 存的是 Storage 路徑而非完整 URL**，每個顯示的地方都要自行加上
  `${VITE_SUPABASE_URL}/storage/v1/object/public/travel-images/` 前綴。
- **Postback 資料上限 300 bytes**：Edge Function 用單字母縮寫鍵（`d`、`a`、`c`、`p`、`s`、`n`），
  但真正的解法是 nonce 間接法 —— 完整內容存在 `line_chat_history`，postback 只帶 nonce。
- **Tailwind CSS v4**：用 `@tailwindcss/postcss` plugin（非 v3 CLI），
  設定在 `tailwind.config.js` 與 `postcss.config.js`。
- **ESLint 平面設定**：設定檔是 `eslint.config.js`（非 `.eslintrc`）。
- **型別安全**：`reduce` 累加金額時要顯式轉型並給初始值：
  `reduce<number>((a, b) => a + (Number(b) || 0), 0)`。

---

## 踩坑紀錄

### 部署 Edge Function 必須加 `--no-verify-jwt`

Supabase Edge Function 預設會驗證請求裡的 Supabase JWT。LINE Messaging API 的 webhook
呼叫不帶這個 token，所以少了旗標會一律收到 **401 Unauthorized**，
Bot 對所有訊息**完全無反應**，而且前端看不到任何錯誤 —— 只有 Supabase 的函式日誌會顯示 401。

```bash
supabase functions deploy line-webhook --no-verify-jwt
node_modules/.bin/supabase functions deploy line-webhook --no-verify-jwt   # 本機版本
```

修復只需用正確指令重新部署，不用改程式碼或密鑰。
`supabase/config.toml` 也設了 `[functions.line-webhook] verify_jwt = false` 作為第二道保險，
但**部署時仍請明確加旗標**。

### RLS 與 Trigger 的權限

在 `trips` 上設 trigger 並在裡面寫入 `line_trip_id_mapping` 時，若後者開了 RLS 而權限不足，
寫入會失敗。解法是把 trigger 函式設為 `SECURITY DEFINER`，讓它以函式擁有者的權限執行，
並確保目標表的 RLS 政策包含所需權限。

### Windows 環境

`npm` / `npx` 容易遇到權限錯誤，必要時改用 `.cmd` 後綴。

### 密鑰與版控

`.env` 與 `supabase/.temp/` 曾被 commit 進 git（前者含 anon key，後者含 Postgres 連線字串）。
兩者現已 gitignore，但**舊 commit 仍看得到**，anon key 需要輪換。
新增任何含密鑰的檔案前請先確認 `.gitignore`。

---

## 部署

- **前端**：推送到 `main` 觸發 `.github/workflows/deploy.yml`，自動部署到 GitHub Pages。
  Repo Secrets 需要 `VITE_SUPABASE_URL` 與 `VITE_SUPABASE_ANON_KEY`。
- **Edge Function**：`supabase functions deploy line-webhook --no-verify-jwt`，
  Webhook URL 須在 LINE Developer Console 登錄。
- **環境變數**：本機 `.env`（見 `.env.example`）；Edge Function 密鑰用 `supabase secrets set`。
