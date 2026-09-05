# 待辦、已知風險與未來規劃

架構與慣例見 [`CLAUDE.md`](../CLAUDE.md)。這裡只記錄「還沒做的事」與「知道但暫時不修的事」。

---

## 已知風險

### 0. 前端與 Edge Function 是分開部署的（接手時先確認）

**GitHub Pages 上的網頁不一定等於 `main` 的內容。** 前端要 push 到 `main` 才會部署，
Edge Function 則是另外用 `npm run fn:deploy` —— 兩者完全獨立。

排查「功能沒生效」時先分清楚問題在哪一邊：

| 現象 | 屬於 |
| :--- | :--- |
| 網頁畫面、統計、快速記帳、垃圾桶 | 前端（需 push 到 main） |
| **LIFF 編輯頁**、**LIFF 記帳偏好頁** | 前端（需 push 到 main） |
| Bot 的文字／收據處理、驗證、Flex 卡片、發言者名稱 | Edge Function（`npm run fn:deploy`） |

確認線上版本：MCP 的 `list_edge_functions`，或 Supabase Dashboard。

### 1. 前端身分驗證形同虛設（安全性，高）

RLS 政策全部是 `FOR ALL USING (true)`（見 [`supabase/schema/05_policies.sql`](../supabase/schema/05_policies.sql)），
而通行碼驗證的結果只寫在 `localStorage` 的 `auth_{tripId}`。因此：

- 任何人只要有 anon key 和 trip UUID，就能直接讀寫全部旅程與帳目，完全繞過通行碼。
- 在瀏覽器開發者工具手動塞一個 `auth_{id}` 就能進入任何旅程的 Dashboard。
- anon key 曾被 commit 進 git，仍留在歷史紀錄中。

`verify_trip_code` / `trip_requires_code` 這兩支 `SECURITY DEFINER` RPC 只保證了
「`access_code` 本身不會傳到瀏覽器」，並沒有保護資料。

**現況判斷**：僅適合高度信任的親友圈使用。要正式對外必須：

1. 導入 Supabase Auth，或
2. 所有寫入改走 `SECURITY DEFINER` RPC 並在裡面驗證 per-trip token，RLS 收緊為預設拒絕。

方案 2 改動較小但會動到大量前端查詢，尚未排程。

### 2. ~~垃圾桶的 24 小時判斷依賴客戶端時間~~（已解決，2026-09-07）

**已修**：保留期的切割改由資料庫的 `now()` 決定，兩支 STABLE 的 RPC
`list_trip_trash()` / `list_expired_trash()` 分別回傳「保留期內」與「已過期」兩份清單，
`src/hooks/useTripData.ts` 的 `refetchDeleted` 直接呼叫它們，
不再把 `deleted_at` 撈回瀏覽器用 `new Date()` 相減。

搭配 `expenses` 的 BEFORE UPDATE trigger `tr_expenses_stamp_deleted_at`
把軟刪除的時間戳蓋成 `now()` —— 寫入端有三個（網頁 `useTrash`、LINE Edge Function、LIFF），
不統一時間來源的話伺服器端的判斷還是會歪。還原（寫回 `NULL`）不受影響。

> 清理逾期紀錄仍維持「先刪 Storage 照片、再刪資料列」的順序，
> 且刪列時加上 `deleted_at IS NOT NULL`，避免兩次呼叫之間被還原的紀錄遭硬刪。

### 3. anon key 曾外洩於 git 歷史（已決定接受此風險）

`.env` 曾被 commit，`VITE_SUPABASE_ANON_KEY` 仍留在舊 commit 中。
已與擁有者確認**暫不輪換** —— 這是私人親友使用的專案，repo 曝光度低。

但要清楚這代表什麼：因為 RLS 全面開放（風險 1），拿到那把 key 的人可以讀寫
**所有旅程與帳目**，不需要通行碼。不只是被看到，是可以寫入與刪除。

觸發重新評估的條件：repo 轉為公開、帳目開始涉及不想被看到的資訊、
或發現非預期的資料變動。屆時的做法是
Supabase Dashboard → Settings → API Keys 重簽 → 更新本機 `.env` 與 GitHub Secrets。

### 4. 使用者身分快取

`currentUser` 存在 `localStorage`。清快取就會失去身分設定，需重新選擇。
目前影響輕微，但沒有更好的替代方案（因為沒有帳號系統，見風險 1）。

### 5. ~~結算的匯率換算兩邊不一致~~（已解決，2026-09-06）

**已修**：餘額彙總與匯率換算收進 `getRate()` / `convertToBase()` /
`calculateMemberBalances()`，前端（`src/utils/finance.ts`）與 Edge Function
（`supabase/functions/_shared/finance.ts`）各一份，由 `finance.parity.test.ts` 比對。
`useTripStats` 與 Bot 的「結算」都改呼叫它，**主幣別一律以 1 換算**
（幣別對自己的匯率是定義，不是設定值）。漏設匯率的幣別會被回報出來，
網頁顯示提醒、Bot 的結算訊息也會明講「已當成 1:1 折算」。

> 演算法與彙總的重複都由 `src/utils/finance.parity.test.ts` 的契約測試看守，
> 改一邊忘了另一邊會讓 CI 失敗。

---

## LINE Bot 的中低優先 bug（M1–M19）—— 已全部完成

來源是 [`LINE_SCENARIOS.md`](LINE_SCENARIOS.md) 第 10.2 節。
**M1–M19 已於 2026-09-04 ~ 09-06 分批修完**（M9 不存在），
每一條的現象、修法與完成日期留在 `LINE_SCENARIOS.md` 第 10.2 節，
當作「為什麼要這樣寫」的紀錄。這裡不再重複列出。

要加新功能或改 Bot 邏輯前，先掃過 `LINE_SCENARIOS.md` 的情境表；改完逐條回歸。

---

## 未來規劃

### 短期

- 前端 `Dashboard.tsx` 已超過 1400 行，持續拆分成分頁元件與 hooks。
- ~~Edge Function 模組化~~ **已完成**：`index.ts` 從 2778 行縮到約 110 行，
  拆成 `config` / `db` / `util` / `line-api` / `drafts` / `messages` / `gemini` / `context`
  與 `handlers/` 底下的五支路徑處理器；LINE webhook 事件、postback、DB 列與 Gemini
  往來都有具名型別（`line-webhook/types.ts`、`_shared/types.ts`），
  `supabase/functions/` 底下已經沒有任何 `no-explicit-any` warning
  （只剩 `guards.test.ts` 裡的 6 個）。
- ~~共用工具層~~ **已完成**：記帳的實際動作（驗證、寫入、更新、刪除、查詢、餘額）
  收進 `supabase/functions/_shared/tools/`，LINE Bot 是它的第一個呼叫端，
  MCP server 之後是第二個。由 `expenses.test.ts` / `registry.test.ts` 看守。
- ~~LINE Bot 的自然語言修改／刪除、一句話多筆、任意條件查詢~~ **已完成**
  （Feature G，見 [`LINE_SCENARIOS.md`](LINE_SCENARIOS.md) 第 14 章）：
  文字路徑改用 Gemini function calling，模型可以自己呼叫 `list_expenses` / `get_balance` /
  `get_settlement_plan` 查資料，並用 `propose_expense_update` / `propose_expense_delete`
  提議修改或刪除（一律要使用者按確認卡才生效）；`propose_expenses` 一次最多 4 筆。
  ⚠️ **尚未部署** —— Edge Function 要另外 `npm run fn:deploy`。
- LINE Bot 尚未支援：**多品項收據拆帳**（一張收據拆成好幾筆，或指定某幾個品項給某個人；
  現在只能靠「收據草稿 + 文字重新分帳」逐項講）。
  LINE 的 `imageSet`（相簿多選被視為同一組）也還沒處理，多頁收據會變成多筆（G4）。
- Webhook 目前整條同步處理到底，OCR 與**語音**路徑有超過 LINE replyToken 時效的風險
  （語音會先呼叫一次 Gemini 轉錄，再呼叫一次解析，是目前最慢的一條路）。
  文字路徑的 AI 迴圈已經有 `deadlineAt`（事件時間 + 45 秒）會強迫收尾，
  而且 reply 失敗會改 push 原本那組 messages，卡片不會丟失 —— 但那只是止血，
  真正的解法還是把 webhook 非同步化（先回 200，處理完再 push）。

### 中期

- **MCP Server**：讓記帳不再侷限於 LINE，可直接由 Claude / Gemini 等 AI 呼叫。
  設計見 [`MCP_SERVER_DESIGN.md`](MCP_SERVER_DESIGN.md)。最終目標是透過手錶呼叫 AI 記帳。
- **行程規劃整合**：把記帳與每日行程（景點導航）結合。

### 長期

- 導入 Supabase Auth 使用者系統，取代 `access_code`，並據此收斂 RLS。
