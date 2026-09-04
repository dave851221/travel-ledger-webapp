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

### 2. 垃圾桶的 24 小時判斷依賴客戶端時間

`Dashboard.tsx` 過濾 `deleted_at` 時是用瀏覽器的 `new Date()` 去減資料庫時間。
使用者裝置時間不準的話，可能提早清空或永遠不清。

**建議修法**：改由資料庫過濾（`deleted_at > NOW() - INTERVAL '24 hours'`），
或建一個 view。

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

### 5. 結算的匯率換算兩邊不一致（低，但會算錯錢）

Edge Function 的結算換算寫成 `e.currency === base ? 1 : rates[...]`，
網頁端（`Dashboard.tsx`）是 `rates[...]`。若 `rates` 裡 base currency 的值不等於 1，
兩邊會算出不同的結算結果。

這一段不在契約測試的涵蓋範圍內（測試比對的是 `calculateDistribution` 與
`calculateSettlements` 兩支純函式，不是呼叫端如何準備 balance）。
修法是把餘額彙總也收進 `_shared/` —— 見下方的 M14。

> 演算法本身的重複已由 `src/utils/finance.parity.test.ts` 的契約測試看守，
> 改一邊忘了另一邊會讓 CI 失敗。

---

## LINE Bot 的中低優先 bug（M1–M19）

來源是 [`LINE_SCENARIOS.md`](LINE_SCENARIOS.md) 第 10.2 節。
高優先的 H1–H12 已經修完，這一批**已確認暫不處理**，只記錄下來排程。
每條都寫了現象與修法方向，實作者可以直接照做；動手前請先看 `LINE_SCENARIOS.md`
對應的情境編號，改完逐條回歸。

| # | 問題 | 修法方向 |
| :-- | :-- | :-- |
| M1 | 群組綁定：輸入 `ID:` 當下 `current_trip_id` 就清空；等密碼期間群組每句話都被當密碼回「密碼錯誤」；沒有放棄指令。 | 驗證成功才切換旅程；加 `取消綁定`；`line_user_states` 加 `pending_at`，逾時 10 分鐘自動放棄（`last_active_at` 目前從未被更新，是死欄位，可順便處理）。 |
| ~~M2~~ | ~~`buildEditLiffUrl()` 把整筆支出塞進 URL，LINE `uri` 上限 1000 字，多成員多照片會讓整張清單發不出去。~~ | ✅ **已完成**（隨 T2 一起做，2026-09-04）：編輯既有支出只帶 `id`，`LiffEdit` 自行查 `expenses`；草稿帶 nonce 與 sourceId 查 `line_chat_history` 的 pending 列；舊的 `data=` 格式保留。 |
| M3 | `isManagement` 用 `userText.startsWith('設定')`，群組「設定好了嗎」會被送進 AI。 | 改為只認 `設定:`、`設定：`、`設定?`、`設定？`。 |
| M4 | `getTripTimezone()` 先看 `base_currency`，主幣 TWD 的日本旅程「今天」是台北時間。 | 旅程設定加時區欄位，或改為優先看非主幣別的 rates。 |
| M5 | AI 核心在 `trip` 為 null 時直接存取欄位 → 500 → LINE 重送。（快捷查詢已在修 H5 時一併補上 null 檢查。） | 抽一個 `loadTripOrReply()`，沒有旅程就回「找不到旅程」並 `continue`。 |
| M6 | AI context 只有最近 10 筆，自由查詢（K8–K13）會答錯。 | 伺服器端用 Decimal 算好：各幣別合計、每人已付／應付、各分類合計、筆數、日期範圍，放進 `tripContext`；長期改 function calling（見 [`MCP_SERVER_DESIGN.md`](MCP_SERVER_DESIGN.md)）。 |
| M7 | OCR prompt 把「截圖」列為 not_receipt，行動支付與信用卡通知截圖記不了。 | prompt 規則 7 改為「人物照、風景照、與消費無關的截圖」，並加一句「付款成功畫面、交易通知視為收據」。 |
| M8 | 1:1 傳非收據照片完全沒回應。 | 1:1 回一句「這看起來不是收據，要記帳可以直接打字」；群組維持靜默。 |
| M10 | 收據幣別沒匯率或成員對不上時照片被刪，要重傳。 | 保留照片，回覆附快速回覆「以 TWD 存入」「以 JPY 存入」；或先出卡讓使用者按「編輯」改。 |
| M11 | `liff-notify` 把 LIFF 的 UPDATE 也記成 `saved`，`取消上一筆` 會刪掉剛編輯的舊支出；推播文字寫「存入」。 | `ExpenseModal` 呼叫時多帶 `mode: 'update' \| 'insert'`；更新不寫 `saved`，文字改「已更新」。 |
| M12 | 確認時成員已被移除，`calculateDistribution` 把該人份額默默加給調整成員。（全部成員都被移除的情況已由 H6 擋下並提示編輯。） | P1 save 發現有成員被過濾掉時，回「成員已變動，請按『編輯』重新分攤」。 |
| M13 | 綁定、斷開、切換旅程時舊草稿沒失效。 | 在 A1／A2／A7 的成功路徑呼叫 `supersedeAllDrafts(sourceId)` —— H1 已經把這支函式準備好留在 `index.ts`，只差接上呼叫端。 |
| M14 | 結算匯率換算兩邊不一致（同下方「已知風險 5」）。 | 把餘額彙總收進 `_shared/finance.ts`（`sumByCurrency` 已經先搬進去了），納入契約測試。 |
| M15 | 語音訊息不支援。 | Gemini 可直接吃音訊：下載 `audio/m4a` 後走與文字相同的 schema。 |
| M16 | `cleanText` 的 `@\S+` 會把 `@小明` 也刪掉（L14），AI 看不到付款人。 | 只移除 mention 到機器人自己的那段（用 `mentionees[].index/length`）。 |
| M17 | 對話歷史沒把發言者帶進 prompt（L15）。 | `summarizeHistoryEntry` 對 user 訊息前綴 `speaker_name`。 |
| M18 | AI 回的分類不驗證（F7），會存進旅程裡不存在的分類。 | 比照 `resolveMember` 做 `resolveCategory`（放 `guards.ts` 並加測試），對不上退回預設分類並提醒。 |
| M19 | 機器人加入群組不打招呼（L12）。 | 處理 `join` event，回 `BOT_SELF_INTRODUCTION`。 |

（編號沿用 `LINE_SCENARIOS.md`，M9 不存在。）

---

## 未來規劃

### 短期

- 修正上述已知風險 2 與 5。
- 前端 `Dashboard.tsx` 已超過 1400 行，持續拆分成分頁元件與 hooks。
- Edge Function 模組化：純函式已抽到 `line-webhook/guards.ts` 並有測試，
  但 `index.ts` 仍是兩千行的路由單檔。並為 LINE webhook 事件與
  Gemini 回應補上真正的型別（那些 `any` 在 ESLint 是 warning，見 `eslint.config.js`）。
- LINE Bot 尚未支援：以自然語言直接定位並修改／刪除既有支出（只能走清單按鈕或撤銷最近一筆）、多品項收據拆帳、
  自由條件的支出查詢（目前只有今日／本週／本月／結算幾個固定指令，
  其餘交給 AI 但它只看得到最近 10 筆）。
  這些適合改用 Gemini function calling 一次解決，並與
  [`MCP_SERVER_DESIGN.md`](MCP_SERVER_DESIGN.md) 的工具清單共用同一層實作。
- Webhook 目前整條同步處理到底，OCR 路徑有超過 LINE replyToken 時效的風險。

### 中期

- **MCP Server**：讓記帳不再侷限於 LINE，可直接由 Claude / Gemini 等 AI 呼叫。
  設計見 [`MCP_SERVER_DESIGN.md`](MCP_SERVER_DESIGN.md)。最終目標是透過手錶呼叫 AI 記帳。
- **行程規劃整合**：把記帳與每日行程（景點導航）結合。

### 長期

- 導入 Supabase Auth 使用者系統，取代 `access_code`，並據此收斂 RLS。
