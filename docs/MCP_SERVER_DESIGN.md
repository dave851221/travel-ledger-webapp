# MCP Server 設計構想

**狀態：設計階段，尚未實作。**

目標是讓記帳不再侷限於 LINE。把記帳能力包成一個
[MCP](https://modelcontextprotocol.io/)（Model Context Protocol）server 之後，
任何支援 MCP 的 AI 客戶端都能直接呼叫 —— Claude、Gemini、自製的 agent 皆可，
不必為每個平台重寫一套整合。

最終想達成的情境：**對手錶說「午餐八百」，帳就記進指定旅程。**

---

## 1. 為什麼是 MCP

目前所有 AI 記帳能力都綁在 `line-webhook` 這支 Edge Function 裡：
訊息解析、工具邏輯、資料庫寫入、Flex 卡片全部混在一起。
想多支援一個管道就得整套重做。

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

| 工具 | 參數 | 說明 |
| :--- | :--- | :--- |
| `list_trips` | — | 列出 token 可存取的旅程 |
| `get_trip` | `trip_id` | 旅程詳情：成員、幣別、匯率、分類、預設值 |
| `create_expense` | `trip_id`, `description`, `amount`, `currency`, `date`, `category`, `payer_data`, `split_data` | 記一筆帳。伺服器端跑 `calculateDistribution` 並強制校驗總額 |
| `update_expense` | `expense_id`, 欲修改的欄位 | 修改既有支出 |
| `delete_expense` | `expense_id` | 軟刪除（寫入 `deleted_at`），可從網頁垃圾桶還原 |
| `list_expenses` | `trip_id`, `from`, `to`, `category?`, `member?` | 查詢支出，供 AI 回答「這禮拜吃飯花多少」 |
| `get_balance` | `trip_id`, `member?` | 淨結餘。不帶 member 就回傳全員 |
| `get_settlement_plan` | `trip_id` | 最少轉帳次數的結清路徑 |

設計原則：

- **金額與分帳的計算一律在伺服器端做**，不信任 AI 算出來的數字。
  AI 只負責把自然語言變成參數，`calculateDistribution` 才是真相。
- `create_expense` 的 `payer_data` / `split_data` 允許留空，
  留空時套用旅程的 `default_payer` / `default_split_members` 與全員均分。
- 成員名稱要做模糊比對後回傳「解析成了誰」，讓 AI 有機會確認而不是默默記錯人。

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

MCP server 落地時，`line-webhook` 應該重構成**共用同一個工具實作層**：

```
supabase/functions/
├── _shared/
│   ├── tools/          ← 工具實作（create_expense、get_balance…）
│   ├── finance.ts      ← 唯一的 calculateDistribution
│   └── db.ts
├── line-webhook/       ← LINE transport：訊息解析 + Flex 卡片
└── mcp-server/         ← MCP transport：JSON-RPC
```

這樣不但消除了目前財務演算法兩份實作的問題，
未來要新增任何管道（Discord、Telegram、網頁 AI 助手）都只是再加一個 transport。
