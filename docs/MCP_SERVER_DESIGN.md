# MCP Server 設計構想

**狀態：工具層已實作，缺 transport 與 token。**

`supabase/functions/_shared/tools/` 已經是下面 §2 那組工具的實作，
LINE Bot 的記帳、刪除與結算都走它（見 CLAUDE.md 的「共用工具層」）。
還沒做的是 §3 的 token 表與 §4 的 MCP transport ——
也就是說「能做什麼」寫完了，「別人怎麼連進來」還沒有。

目標是讓記帳不再侷限於 LINE。把記帳能力包成一個
[MCP](https://modelcontextprotocol.io/)（Model Context Protocol）server 之後，
任何支援 MCP 的 AI 客戶端都能直接呼叫 —— Claude、Gemini、自製的 agent 皆可，
不必為每個平台重寫一套整合。

最終想達成的情境：**對手錶說「午餐八百」，帳就記進指定旅程。**

---

## 0. 現在能不能接？（一句話：還不行）

**不行 —— 現在還沒有任何對外的網址可以讓 MCP 客戶端連進來。**

「工具層」與「傳輸層」是兩件事：

| 層 | 負責什麼 | 狀態 |
| :--- | :--- | :--- |
| 工具實作層 | 記一筆帳要驗證什麼、金額怎麼分、餘額怎麼算 | ✅ `_shared/tools/`，已上線 |
| 傳輸層（transport） | 別人**怎麼連進來**、怎麼問「你有哪些工具」、怎麼呼叫、怎麼證明自己有權限 | ❌ 還沒有 |

現在那些工具只有一個呼叫端：LINE Bot 的 Edge Function，它是在**自己的行程裡**
直接 import 進來用的（`import { createExpense } from '../_shared/tools/…'`）。
外面的 Claude Desktop、Claude Code 或任何 MCP 客戶端沒有辦法 import 一個
跑在 Supabase 上的 TypeScript 檔案 —— 它們講的是 MCP 這個協定，
需要一個聽得懂 JSON-RPC 的網址。

要能接，還差三件具體的東西：

1. **一支 `supabase/functions/mcp-server/`**：實作 MCP 的 Streamable HTTP transport，
   把 `tools/list`（回報有哪些工具）與 `tools/call`（實際執行）對應到
   `_shared/tools/registry.ts` 的 `TOOLS` 與 `runTool()`。
   工具的 `inputSchema` 已經是標準 JSON Schema，可以直接回給客戶端，不必再寫一份。
2. **§3 的 `trip_access_tokens` 表與網頁上的產生／撤銷介面**：
   沒有它就無法回答「連進來的這個人可以碰哪一趟旅程」。
   工具層已經為此鋪好路 —— 它不自己建 Supabase client，
   而是由呼叫端把 client 與旅程放進 `ToolContext` 傳進去，
   所以權限可以在進入工具之前就鎖死。
3. **在客戶端登錄那個網址**（例如 Claude Desktop 的設定檔）。

工作量主要在第 1、2 項，第 3 項只是貼一行設定。

### 那現在想從別的地方記帳，有什麼替代方案？

- **手錶或手機用 LINE 的語音輸入**對機器人講話。這是今天就能用的，
  而且文字路徑已經支援自然語言的修改、刪除與查詢（Feature G），
  體驗未必比 MCP 差。詳見 §5 的評估。
- **自己寫程式打 Supabase**：知道 anon key 與旅程 UUID 就能直接讀寫
  （因為 RLS 目前全開，見 [`ROADMAP.md`](ROADMAP.md) 風險 1）。
  但這條路**繞過了工具層的所有驗證**，分帳的餘數、幣別、成員名稱都得自己算對，
  不建議 —— 專案在財務計算上吃過重複實作漂移的虧。


---

## 1. 為什麼是 MCP

這份文件寫下來的時候，所有 AI 記帳能力都綁在 `line-webhook` 這支 Edge Function 裡：
訊息解析、工具邏輯、資料庫寫入、Flex 卡片全部混在一起，想多支援一個管道就得整套重做。
（工具邏輯現在已經抽到 `_shared/tools/`，見 §6；`line-webhook` 只剩訊息解析與 Flex 卡片。）

MCP 的作法是把「能做什麼」（工具）和「怎麼觸發」（transport）拆開：

```
                    ┌─ LINE Bot（現有）
                    │
[工具實作層] ───────┼─ MCP over HTTP ── Claude / Gemini / 手錶
                    │
                    └─ 網頁前端（直接查 Supabase）
```

工具實作層只寫一次，LINE 退化成眾多入口之一。

---

## 2. 工具清單

刻意與 LINE Bot 未來要導入的 Gemini function declarations **共用同一組語意**，
避免又養出兩套會漂移的邏輯（專案已經在財務演算法上吃過這個虧）。

實際的定義在 `_shared/tools/registry.ts`（`TOOLS`），schema 在 `_shared/tools/schemas.ts`。
`trip_id` 不是參數而是 context 的一部分 —— 呼叫端先確定「這個人能操作哪一趟」
（LINE 看綁定、MCP 看 token），工具本身只在那一趟的範圍內動作。

| 工具 | 參數 | 說明 | 現況 |
| :--- | :--- | :--- | :--- |
| `list_trips` | — | 列出 token 可存取的旅程 | ❌ 要等 token 表才有意義 |
| `get_trip` | — | 旅程詳情：成員、幣別、匯率、分類、預設值、時區、今天 | ✅ |
| `create_expense` | `description`, `amount`, `currency?`, `currency_source?`, `date?`, `category?`, `payer_data?`, `split_details?` | 記一筆帳。伺服器端跑 `calculateDistribution` 並強制校驗總額 | ✅ |
| `update_expense` | `expense_ref` + 欲修改的欄位 | 修改既有支出，沒給的欄位沿用原值 | ✅ |
| `delete_expense` | `expense_ref` | 軟刪除（寫入 `deleted_at`），可從網頁垃圾桶還原 | ✅ |
| `restore_expense` | `expense_ref` | 從垃圾桶還原 | ✅ |
| `list_expenses` | `from?`, `to?`, `category?`, `member?`, `payer?`, `keyword?`, `include_settlements?`, `limit?` | 查詢支出，供 AI 回答「這禮拜吃飯花多少」 | ✅ |
| `get_balance` | `member?` | 淨結餘。不帶 member 就回傳全員 | ✅ |
| `get_settlement_plan` | — | 最少轉帳次數的結清路徑 | ✅ |

支出用 `expense_ref`（uuid 前 8 碼，可加 `#`）而不是完整 uuid 指稱：
網址與 uuid 太長，小模型抄不準（見 LINE_SCENARIOS 的 T4）。
`resolveExpenseRef` **只在唯一命中時才回傳** —— 撞到兩筆就回 null 請對方講清楚，
刪錯或改錯一筆帳比多問一句糟得多。

設計原則：

- **金額與分帳的計算一律在伺服器端做**，不信任 AI 算出來的數字。
  AI 只負責把自然語言變成參數，`calculateDistribution` 才是真相。
- `create_expense` 的 `payer_data` / `split_details` 允許留空，
  留空時套用旅程的 `default_payer` / `default_split_members` 與全員均分。
- 成員名稱要做模糊比對後回傳「解析成了誰」，讓 AI 有機會確認而不是默默記錯人；
  真的對不上就整筆退回（`reason: 'unknown_members'`），不會挑一個最像的硬記。
- schema 是 Gemini function declaration 與 MCP `tools/list` **共用同一份**，
  所以不能有 `additionalProperties`、`$ref`、`oneOf`／`anyOf` 與 STRING 的 `format`
  —— Gemini 不支援，帶了整個請求會 400。`registry.test.ts` 遞迴檢查這件事。

---

## 3. 認證

這是最需要想清楚的部分。專案目前**沒有使用者身分系統** ——
只有旅程通行碼加上完全開放的 RLS（見 [`ROADMAP.md`](ROADMAP.md)）。
MCP server 必須用 service role key 才能寫入，那把 key 絕不能交到客戶端手上。

**設計：per-trip 的長效 token。**

```sql
CREATE TABLE public.trip_access_tokens (
    token       TEXT PRIMARY KEY,          -- 高熵隨機字串
    trip_id     UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
    label       TEXT,                      -- 「我的手錶」「Claude Desktop」
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);
```

- 在網頁的旅程設定頁產生與撤銷，顯示時只顯示一次。
- MCP server 收到 `Authorization: Bearer <token>`，驗證後才以 service role 操作，
  且**只能存取該 token 對應的那個旅程**。
- 這張表必須是 RLS 預設拒絕，只讓 `SECURITY DEFINER` 函式讀取。

**安全模型要誠實說清楚**：token 等同該旅程的完整讀寫權限。
這比現況（知道 UUID 就能存取）嚴格，但仍是「信任持有 token 者」的模型，
不是真正的使用者驗證。要做到後者得先導入 Supabase Auth。

---

## 4. 部署方式

### 方案 A：Supabase Edge Function + Streamable HTTP（推薦）

新增 `supabase/functions/mcp-server/`，實作 MCP 的 Streamable HTTP transport。

- 與現有基礎設施一致，不用多養一台主機
- 有公開 URL，雲端 AI 服務可以直接連
- 能和 `line-webhook` 共用 `_shared/` 的工具實作層
- 手錶情境唯一可行的路（手錶不可能跑 stdio server）

要注意 Edge Function 的執行時間限制，以及 MCP session 狀態要嘛不保存、
要嘛存在資料庫裡（Edge Function 是無狀態的）。

### 方案 B：本機 stdio server

包成一個 npm 套件，給 Claude Desktop / Claude Code 在本機跑。

- 實作最簡單，不用處理認證（本機信任）
- 但手錶場景完全用不到

**建議順序**：先做 A，再用同一份工具實作包一層 stdio adapter 得到 B。

---

## 5. 手錶情境的可行性

這是最終目標，但也是最不確定的一環，取決於平台開放程度而非我們的實作。

**現實狀況**：Wear OS 上的 Gemini／Google Assistant 目前不提供
讓使用者自行掛載第三方 MCP server 的介面。手機端 Gemini app 的擴充機制也相當封閉。
這部分**不是寫完 MCP server 就能通**，需要持續觀察平台動向。

可行的過渡方案，由易到難：

1. **手錶 → LINE 語音輸入 → 現有 Bot**（今天就能用）
   Wear OS 的 LINE app 支援語音輸入，等於免費得到手錶記帳。
   實際體驗可能已經夠好，值得先試過再決定要不要投入後面兩項。
2. **手錶捷徑 → HTTP 呼叫 MCP server**
   用 Wear OS 的捷徑或簡單的 companion app 直接打 HTTP，
   跳過 AI 直接呼叫 `create_expense`。犧牲自然語言理解，換取確定可行。
3. **自製 Wear OS app**，內建語音辨識後呼叫 MCP server。工程量最大。

務實的建議是**先做方案 1 驗證使用習慣**，MCP server 本身的價值主要在於
桌面端的 Claude / Gemini 整合；手錶是加分項而非主要理由。

---

## 6. 與 LINE Bot 的關係

這一步**已經做完了**：`line-webhook` 的記帳、刪除與結算都呼叫共用的工具實作層。

```
supabase/functions/
├── _shared/
│   ├── tools/          ← 工具實作（create_expense、get_balance…）✅ 已實作
│   ├── validate.ts     ← AI 回傳內容的驗證（成員／幣別／分類／日期）
│   ├── finance.ts      ← 唯一的 calculateDistribution
│   └── types.ts
├── line-webhook/       ← LINE transport：訊息解析 + Flex 卡片
└── mcp-server/         ← MCP transport：JSON-RPC（❌ 尚未實作，見 §0）
```

工具層刻意**不碰 `Deno.env`、不建 Supabase client**：client 與旅程由呼叫端
放進 `ToolContext` 傳進來。這既是為了讓 vitest 測得動，也是為了讓 MCP transport
能把「這個 token 只能碰哪一趟旅程」這件事在進入工具之前就決定好。

剩下要做的只有 transport 與認證，
未來要新增任何管道（Discord、Telegram、網頁 AI 助手）也都只是再加一個 transport。
