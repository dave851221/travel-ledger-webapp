# CLAUDE.md

給 AI 代理（Claude Code / Gemini 等）在這個 repo 工作時的指引。這是唯一的入口文件。

## 文件索引

| 文件 | 內容 | 何時看 |
| :--- | :--- | :--- |
| **本檔** | 架構、慣例、開發規則、踩坑紀錄 | 動手改任何東西之前 |
| [`docs/SETUP.md`](docs/SETUP.md) | 從零架設、資料庫初始化、Edge Function 部署 | 建新環境、部署時 |
| [`docs/DB_MAINTENANCE.md`](docs/DB_MAINTENANCE.md) | 後台維運（**刪除旅程**、清理孤兒照片、重設 LINE 綁定） | 需要手動操作資料庫時 |
| [`docs/LINE_BOT.md`](docs/LINE_BOT.md) | LINE Bot 行為規格與自我介紹全文 | 改機器人邏輯或對話時 |
| [`docs/LINE_SCENARIOS.md`](docs/LINE_SCENARIOS.md) | LINE 記帳的完整使用情境、支援狀態、bug 清單與修正規劃 | 改 Bot 邏輯前後的回歸檢查表 |
| [`docs/ITINERARY_AUTHORING.md`](docs/ITINERARY_AUTHORING.md) | 如何新增一個旅程行程頁 | 要做新行程頁時 |
| [`docs/AI_TOOLING.md`](docs/AI_TOOLING.md) | 讓 AI 直接操作 Supabase（MCP 設定與風險） | 想請 AI 跑 SQL 或部署函式時 |
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
npm run fn:deploy # 部署兩支 Edge Function（已自動帶 --no-verify-jwt）
npm test          # Vitest（純函式，不含 UI）
npm run test:watch
npm run check:functions  # 用 Deno 對 Edge Function 做型別檢查
```

提交前請跑 `npm run lint && npm test && npm run check:functions && npm run build`
—— CI 這四關都會擋。測試涵蓋 `src/utils/` 的純函式、跨實作的契約比對、
LINE Bot 的 `line-webhook/guards.ts` 與它轉出的 `_shared/validate.ts`，
以及共用工具層 `_shared/tools/`（支出的驗證與更新、查詢過濾、工具 schema）；
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
- **`LiffEdit.tsx`**：獨立頁面，透過 LIFF 嵌在 LINE App 的 WebView 中，把資料餵給
  `ExpenseModal` 重用整個編輯器。三種進入方式，優先序 `id` > `n` > `data`：
  `?id=<expenseId>` 直接查 DB（每次開啟都是最新內容）、`?n=<nonce>` 從
  `line_chat_history` 的 `pending` 列取草稿、`?data=<base64url>` 是舊格式，
  **必須保留**，已經發出去的 LINE 卡片還帶著它。
- **`LiffPreference.tsx`**：同樣走 LIFF，編輯 `trips.ai_preference`
  （LINE Bot 解析文字與收據時參考的自由文字偏好，整趟旅程共用一份）。
  只覆寫單一欄位，不需要 nonce／postback。

### 財務計算引擎

`src/utils/finance.ts` 全面使用 **Decimal.js**。`calculateDistribution()` 處理餘數分配：
金額除不盡時，餘數指定給 `adjustment_member`，確保 `Σ(分攤) === 總額`。

結清演算法在 `src/utils/settlement.ts`（`calculateSettlements`）。

**匯率換算與餘額彙總**在 `getRate()` / `convertToBase()` / `calculateMemberBalances()`。
⚠️ **主幣別對自己的匯率一律是 1**，不管 `rates` 裡寫什麼 —— 這是網頁的 `useTripStats`
與 Bot 的「結算」算出相同金額的前提（以前兩邊各寫各的判斷，`rates[base] ≠ 1` 時會差一截）。
漏設匯率的幣別會被當成 1:1 並回報給呼叫端提醒使用者。

⚠️ **這兩套邏輯各有兩份實作**：前端在 `src/utils/`，LINE Bot 在
`supabase/functions/_shared/finance.ts`。無法直接共用同一個檔案 ——
前端走 npm 的 decimal.js，Edge Function 走 esm.sh 的 URL import。

**改任何一邊都必須同步另一邊**，但現在有 `src/utils/finance.parity.test.ts`
這支契約測試會用大量隨機輸入比對兩份實作（`calculateDistribution`、`calculateSettlements`、
`calculateMemberBalances`、`getRate`、`sumByCurrency`），漂移會直接讓 CI 失敗。
`_shared/deps.ts` 那層間接就是為了讓測試能在 Node 下載入 Deno 的模組。

### 共用工具層 `_shared/tools/`

**支出的驗證與寫入統一走 `_shared/tools/expenses.ts` 的 `prepareExpense` / `commitExpense`**
（更新走 `prepareExpenseUpdate` / `commitExpenseUpdate`，刪除／還原走 `deleteExpense` /
`restoreExpense`，查詢走 `listExpenses` / `resolveExpenseRef`）。
在它出現以前，同一段驗證在 `line-webhook` 裡有三份（OCR、文字、確認存入），
改了其中一份而忘了另外兩份是這個專案反覆出現的 bug 型態。

兩段式的分工要守住：`prepare*` **只算不寫**（LINE 的預覽卡片就跑在這個階段），
`commit*` **只寫不猜**（重跑一次分帳與 Σ 檢查才落地，因為兩者之間可能隔了一天，成員早就變了）。
`prepareExpense` 的 `reject` 有值時**仍然回傳正規化好的 expense** ——
收據幣別沒有匯率時（M10）要靠它把辨識結果存成 pending，使用者才不必重拍。

| 檔案 | 內容 |
| :--- | :--- |
| `types.ts` | `ToolContext`（db + trip + today + actorName）、`ScopedContext`（只要 db 與 trip id，刪除／查詢用）、`ExpenseInput`、`PreparedExpense`、`JsonSchema` |
| `schemas.ts` | 工具參數的 JSON Schema。**禁止** `additionalProperties`／`$ref`／`oneOf`／`anyOf`／STRING 的 `format`，`type` 一律小寫 —— Gemini 的 function declaration 不支援，帶了直接 400 |
| `expenses.ts` | 上面那八支函式 |
| `balance.ts` | `getBalance`／`getSettlementPlan`，包 `calculateMemberBalances`／`calculateSettlements` |
| `trip.ts` | `getTrip`（不輸出 `access_code`） |
| `registry.ts` | `TOOLS`、`runTool`、`toGeminiFunctionDeclarations`。同一份定義同時給 Gemini function calling 與未來 MCP 的 `tools/list` 用（見 [`docs/MCP_SERVER_DESIGN.md`](docs/MCP_SERVER_DESIGN.md)） |

這一層**不碰 `Deno.env`、不建 Supabase client**（client 由呼叫端放進 context），
所以 vitest 能直接測 —— `expenses.test.ts` 用假的 client 撐起 `from().select().eq()…` 這條鏈。
`registry.ts` 沒有被 `line-webhook` import（LINE 直接呼叫底層函式），
所以它在 `check:functions` 裡是**獨立的進入點**，不然沒人用到的工具永遠不會被型別檢查。

### 行程登錄檔模式

`src/features/itinerary/registry.ts` 把旅程 UUID 對應到自訂 React 元件，
每個旅程可以有手工打造的行程頁（飯店、時程、地圖等）。
新增方式見 [`docs/ITINERARY_AUTHORING.md`](docs/ITINERARY_AUTHORING.md)。

### 後端（Supabase）

- **資料庫**：`trips` 與 `expenses` 含 JSONB 欄位（`payer_data`、`split_data`、`rates`、
  `precision_config`）。軟刪除用 `deleted_at`（僅 expenses 有），結清紀錄以 `is_settlement` 標記
  —— **編輯既有支出時務必沿用原本的 `is_settlement`**，硬寫 `false` 會把結清變成一般支出、統計失真。
  結構定義在 [`supabase/schema/`](supabase/schema/)。
  **垃圾桶的 24 小時保留期由資料庫時鐘判斷**：RPC `list_trip_trash` / `list_expired_trash`
  在伺服器端以 `now()` 切出「保留期內」與「已過期」，`deleted_at` 則由 trigger
  `tr_expenses_stamp_deleted_at` 一律蓋成 `now()`（還原寫 `NULL` 不受影響）。
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

`supabase/functions/line-webhook/` 是一組模組，不再是單一檔案（原本 index.ts 有 2778 行）。
**`index.ts` 只剩約 110 行**：驗簽、解析事件、建 `EventContext`、分派。

| 檔案 | 行數 | 內容 |
| :--- | ---: | :--- |
| `index.ts` | ~110 | 進入點。驗簽 → 解析 → `buildEventContext` → 分派 |
| `config.ts` | ~45 | env、`WEBAPP_URL`、`RECEIPTS_BUCKET`、TTL、所有路由關鍵字表 |
| `db.ts` | ~12 | service-role 的 Supabase client 單例 |
| `util.ts` | ~95 | `runInBackground`、時區推測、`requiresAccessCode`、`isPendingExpired` |
| `line-api.ts` | ~100 | 驗簽、reply／push、成員名稱、`downloadLineContent` |
| `drafts.ts` | ~170 | 草稿的存取與失效（`line_chat_history` + `line_processed_actions`） |
| `messages.ts` | ~315 | 快速回覆、Flex 卡片、LIFF 網址、自我介紹全文 |
| `gemini.ts` | ~335 | 模型清單、response schema、system instruction、OCR／轉錄 |
| `context.ts` | ~145 | `EventContext` 與 `buildEventContext`（一則事件只查一次） |
| `types.ts` | ~350 | LINE 事件、postback、DB 列、Gemini 往來的型別 |
| `guards.ts` | ~435 | 與 LINE 有關的純函式（見下） |
| `handlers/postback.ts` | ~380 | undo / cur / del / save / cancel（寫入走 `_shared/tools/`） |
| `handlers/image.ts` | ~275 | 收據 OCR（驗證走 `prepareExpense`） |
| `handlers/audio.ts` | ~55 | 語音轉文字（回傳 transcript 給文字路徑） |
| `handlers/commands.ts` | ~640 | 群組觸發判斷 + 所有明確指令與快捷查詢 |
| `handlers/ai-text.ts` | ~465 | AI 核心（驗證走 `prepareExpense`） |

**import 方向是單向的，不要繞回去**：
`config → db → line-api → drafts / messages / gemini → context → handlers/* → index`。

沒有副作用的純函式分成兩處：

- **`_shared/validate.ts`** —— 純粹在驗證「AI 回傳的東西能不能信」，與 LINE 無關，
  未來接別的記帳管道也用得到：`extractJSON`、`toAmountMap`、`normalizeExpenseAmountMaps`、
  `normalizeName`、`resolveMember`、`resolveExpenseMembers`、`applyParticipantDefaults`、
  `resolveCategory`、`hasCurrencyHint`、`resolveCurrencyByRule`、`normalizeCurrency`、`normalizeDate`。
- **`line-webhook/guards.ts`** —— 跟 LINE 這個管道有關的那些：`detectRecordIntent`、
  `mentionsEditingExisting`、`stripSelfMentions`、`claimsCompletedAction`、
  `summarizeHistoryEntry`、`summarizeTripExpenses`、`pickExpenseByRef`、`matchExpensesByQuestion`。
  它同時**原樣轉出** `validate.ts` 的全部內容，所以 `guards.test.ts` 一行都不必改。

兩邊都由 `guards.test.ts` 看守 —— **改這些行為請連同測試一起改**。
`check:functions` 列了三個進入點（`line-webhook/index.ts`、`liff-notify/index.ts`、
`_shared/tools/registry.ts`），其餘模組透過 import 一起被檢查。
`guards.ts` 只 import `_shared/finance.ts`、`_shared/deps.ts`（Decimal）與 `_shared/validate.ts` ——
`vitest.config.ts` 的 alias 用 `/^(?:\.\.?\/)+(?:_shared\/)?deps\.ts$/` 涵蓋所有相對寫法
（`./deps.ts`、`../deps.ts`、`../_shared/deps.ts`、`../../deps.ts`）。
`_shared/types.ts` 是 Edge Function 端的 `TripRow` / `ExpenseRow`，欄位複製自
`src/types/index.ts`（不能 import 前端檔案）—— **改前端的 `Trip` / `Expense` 時記得同步**。

處理流程：

1. 以 `LINE_CHANNEL_SECRET` 驗證 HMAC-SHA256 簽章
2. **綁定**：使用者傳 `ID:A1B2C3` → 查 `line_trip_id_mapping` → 要求通行碼 →
   **驗證成功才**寫入 `line_user_states.current_trip_id`。
   切換旅程時原綁定會留著（`current_trip_id` 與 `pending_trip_id` 可同時有值），
   10 分鐘沒動作或輸入「取消綁定」就放棄；綁定／斷開成功都會 `supersedeAllDrafts()`
3. **文字訊息**：先比對快捷指令（直接查 DB），其餘交給 Gemini 回傳結構化 JSON
4. **圖片訊息**：從 LINE CDN 下載 → 上傳 Storage → Gemini OCR → Flex Message 預覽卡片
4b. **語音訊息**：下載 m4a → Gemini 逐字轉錄 → **當成使用者打的字**走上面第 3 點的流程
   （所以快捷指令、草稿修正也能用講的）。群組的提及模式不處理語音。
5. **Postback**：按鈕帶 `nonce`，寫入 `line_processed_actions` 防止重複送出。
   同一張表也用來讓草稿卡片失效（`action_type = 'superseded'`）——
   但**只失效 AI 用 `corrects_draft` 指名的那一張**，連續記多筆時每張卡都要留著
6. **群組**：預設僅在 @提及或訊息以「耀西」開頭時回應，可切換為全回應模式。
   群組成員共用同一份綁定與偏好（刻意的設計），但每次互動都會記錄實際發言者，
   對話歷史也以「發言者：內容」的形式餵進 prompt。
   `cleanText` 只移除「提及機器人自己」的那幾段（`stripSelfMentions`），`@其他人` 要留著。

7. **AI 記帳偏好**：存 `trips.ai_preference`，**整趟旅程共用一份**（不分 LINE 綁定、不分管道）。
   網頁的 `SettingsModal`、LIFF 的 `src/pages/LiffPreference.tsx`（`#/liff/preference?tripId=`）
   與文字指令 `設定:` 改的都是同一個欄位。舊的 `line_user_states.default_config` 已不再讀寫。

**AI 回傳的內容一律先驗證再落地**：成員名稱做模糊比對後對應回正式名稱、
幣別由 `resolveCurrencyByRule` 依 `currency_source` 決定後再比對旅程 `rates` 與 ISO 白名單、
分類比對旅程的分類清單、日期檢查格式與合理範圍。
金額類的查詢不靠 AI 算術：`summarizeTripExpenses` 在伺服器端用 Decimal 算好
各幣別合計、每人已付／應付／淨額、各分類合計、逐日合計與金額最大的 3 筆，
以【全趟彙總】放進 context。
付款人與分攤為空時補上與前端 `quickAdd` 一致的預設值。
任何被修正的欄位都會告知使用者，不會默默改掉。細節見 [`docs/LINE_BOT.md`](docs/LINE_BOT.md)，
使用情境與回歸檢查表見 [`docs/LINE_SCENARIOS.md`](docs/LINE_SCENARIOS.md)。

行為規格詳見 [`docs/LINE_BOT.md`](docs/LINE_BOT.md)。

**所需密鑰**：`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`GEMINI_API_KEY`、
`WEBAPP_URL`（`SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 由平台自動注入）。

---

## 重要慣例

- **幣別精確度**：每個旅程存 `precision_config`，格式 `{ "TWD": 0, "JPY": 0, "USD": 2 }`。
  一律使用 `finance.ts` 的 `formatAmount()`，不要直接呼叫 `.toFixed()`。
- **旅程時區**：`trips.timezone` 存 IANA 字串（例如 `Asia/Tokyo`），網頁設定頁可選。
  LINE Bot 判斷「今天」優先讀它；NULL 才退回從幣別推測（會猜錯，見 `docs/LINE_SCENARIOS.md` 的 F4）。
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

### 環境變數要整個 VS Code 重開才生效

`[Environment]::SetEnvironmentVariable(..., 'User')` 只會傳給設定之後才啟動的行程。
Claude Code 是 VS Code 擴充套件，繼承 VS Code 的環境 —— 只重啟 Claude Code 沒有用。
症狀是 MCP server 有起來但一直回 `Unauthorized`，看起來像權杖錯誤，其實是根本沒傳進去。
詳見 [`docs/AI_TOOLING.md`](docs/AI_TOOLING.md)。

### 排序加 limit 時要注意方向

`ORDER BY created_at ASC LIMIT n` 取的是**最舊的 n 筆**，不是最近的 n 筆。
LINE Bot 的對話歷史曾因此永遠停在最早的六筆，AI 完全看不到近期對話。
要「最近 n 筆」一律用 descending 取完再反轉。

### Windows 環境

`npm` / `npx` 容易遇到權限錯誤，必要時改用 `.cmd` 後綴。

### 密鑰與版控

`.env` 與 `supabase/.temp/` 曾被 commit 進 git（前者含 anon key，後者含 Postgres 連線字串）。
兩者現已 gitignore，但**舊 commit 仍看得到**，anon key 需要輪換。
新增任何含密鑰的檔案前請先確認 `.gitignore`。

---

## 部署

⚠️ **前端與 Edge Function 是兩條完全獨立的部署路徑。**
線上網頁不一定等於 `main` 的內容，排查「功能沒生效」時第一步就是分清楚問題在哪一邊
（對照表見 [`docs/ROADMAP.md`](docs/ROADMAP.md) 開頭）。
特別注意 **LIFF 編輯頁屬於前端**，改了要 push 才會生效。

- **前端**：推送到 `main` 觸發 `.github/workflows/deploy.yml`，自動部署到 GitHub Pages。
  Repo Secrets 需要 `VITE_SUPABASE_URL` 與 `VITE_SUPABASE_ANON_KEY`。
  （`VITE_LIFF_ID` 目前未設定，因此 LIFF 存檔後無法自動關閉視窗 —— 見 `.env.example`。）
- **Edge Function**：`supabase functions deploy line-webhook --no-verify-jwt`，
  Webhook URL 須在 LINE Developer Console 登錄。
- **環境變數**：本機 `.env`（見 `.env.example`）；Edge Function 密鑰用 `supabase secrets set`。
