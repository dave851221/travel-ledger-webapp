# 待辦、已知風險與未來規劃

架構與慣例見 [`CLAUDE.md`](../CLAUDE.md)。這裡只記錄「還沒做的事」與「知道但暫時不修的事」。

---

## 已知風險

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

### 3. 使用者身分快取

`currentUser` 存在 `localStorage`。清快取就會失去身分設定，需重新選擇。
目前影響輕微，但沒有更好的替代方案（因為沒有帳號系統，見風險 1）。

### 4. 結算的匯率換算兩邊不一致（低，但會算錯錢）

Edge Function 的結算換算寫成 `e.currency === base ? 1 : rates[...]`，
網頁端（`Dashboard.tsx`）是 `rates[...]`。若 `rates` 裡 base currency 的值不等於 1，
兩邊會算出不同的結算結果。

這一段不在契約測試的涵蓋範圍內（測試比對的是 `calculateDistribution` 與
`calculateSettlements` 兩支純函式，不是呼叫端如何準備 balance）。
修法是把餘額彙總也收進 `_shared/`。

> 演算法本身的重複已由 `src/utils/finance.parity.test.ts` 的契約測試看守，
> 改一邊忘了另一邊會讓 CI 失敗。

---

## 未來規劃

### 短期

- 修正上述已知風險 2 與 4。
- 前端 `Dashboard.tsx` 已超過 1400 行，持續拆分成分頁元件與 hooks。
- Edge Function 模組化（目前仍是 1600 行單檔），並為 LINE webhook 事件與
  Gemini 回應補上真正的型別（那些 `any` 在 ESLint 是 warning，見 `eslint.config.js`）。
- LINE Bot 尚未支援：修改／刪除既有支出（只能撤銷最近一筆）、多品項收據拆帳、
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
