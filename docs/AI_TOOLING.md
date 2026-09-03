# 讓 AI 直接操作 Supabase

設定完成後，就不必再自己開網頁貼 SQL 或手動下部署指令 ——
可以直接說「幫我刪掉『測試用旅程』」或「重新部署 line-webhook」。

專案已經放好 [`.mcp.json`](../.mcp.json)，你只需要做**一次**設定：拿一組存取權杖。

---

## 一次性設定

### 1. 建立 Supabase 個人存取權杖

Supabase Dashboard → 右上角頭像 → **Account Settings** → **Access Tokens**
→ **Generate new token**，命名例如 `claude-code`，複製產生的字串（**只會顯示一次**）。

### 2. 設成環境變數

Windows PowerShell（永久生效，設定後要重開終端機）：

```powershell
[Environment]::SetEnvironmentVariable('SUPABASE_ACCESS_TOKEN', '貼上你的權杖', 'User')
```

驗證：重開終端機後執行 `echo $env:SUPABASE_ACCESS_TOKEN`，應該印得出來。

> `.mcp.json` 裡寫的是 `${SUPABASE_ACCESS_TOKEN}`，權杖本身不會進版控。
> **切勿**把權杖直接寫進 `.mcp.json` —— 那個檔案是要 commit 的。

### 3. 完全重啟 VS Code

⚠️ **要整個 VS Code 關掉重開，只重啟 Claude Code 不夠。**

Windows 的 `SetEnvironmentVariable(..., 'User')` 只會傳給**設定之後才啟動**的行程。
Claude Code 以 VS Code 擴充套件執行，繼承的是 VS Code 的環境；
如果 VS Code 在你設定變數之前就開著，它（以及它啟動的 MCP server）永遠看不到那個變數。

症狀是 MCP server 有起來，但每次呼叫都回
`Unauthorized. Please provide a valid access token` —— 看起來像權杖錯了，其實是根本沒傳進去。

重開後用 `/mcp` 確認 `supabase` 已連上，第一次會問是否信任這個專案的 MCP server。

**權杖到底有沒有效**，可以不靠 MCP 直接驗（不會印出權杖本身）：

```powershell
$t = [Environment]::GetEnvironmentVariable('SUPABASE_ACCESS_TOKEN','User')
Invoke-RestMethod -Uri 'https://api.supabase.com/v1/projects' -Headers @{ Authorization = "Bearer $t" } |
  Select-Object name, id, status
```

列得出專案就代表權杖沒問題，剩下的就是環境變數傳遞的問題。

---

## 設定內容

```jsonc
"--project-ref=cdrjtthstteyruqmyrss"                          // 鎖定這個專案
"--features=database,functions,debugging,development,docs"    // 不含 account / branching / storage
```

- **鎖定專案**：AI 碰不到你 Supabase 帳號下的其他專案。
- **未啟用 `account`**：不能建立、暫停或刪除整個 Supabase 專案。
- **未加 `--read-only`**：可以寫入，這是為了能真的執行刪除旅程與套用 migration。

可用的能力：

| 工具 | 用途 |
| :--- | :--- |
| `execute_sql` | 執行任意 SQL，例如 `supabase/scripts/delete_trip.sql` |
| `apply_migration` | 套用 `supabase/migrations/` 的變更 |
| `list_tables` / `list_migrations` | 查看目前的資料庫結構 |
| `deploy_edge_function` | 重新部署 line-webhook |
| `get_logs` | 讀 Edge Function 與資料庫日誌，排查問題用 |
| `get_advisors` | Supabase 的安全性與效能建議 |

---

## 風險與界線

**這是有寫入權限的正式資料庫連線，請理解以下幾點：**

1. **AI 可以對正式資料下任意 SQL，包含 `DROP TABLE`。** Claude Code 在實際執行前會
   跟你確認，但那道確認是最後一道防線 —— 請看清楚再按同意。
2. **Prompt injection**：資料表裡的內容（例如支出描述、LINE 對話紀錄）是使用者輸入，
   AI 讀到之後有可能被其中的文字影響行為。不要把來路不明的內容存進資料庫。
3. **刪除旅程仍建議照 [`DB_MAINTENANCE.md`](DB_MAINTENANCE.md) 的順序**：
   先 `list_trips` 找 UUID → `preview_trip` 核對名稱 → 才執行刪除。
   請 AI 幫忙時也一樣，先讓它把 preview 結果給你看過。
4. **重要操作前先備份**：Supabase Dashboard → Database → Backups。
5. **權杖本身別留在檔案裡**。設定時如果先貼在編輯器裡再執行，記得關掉時不要存檔。
   權杖等同你 Supabase 帳號下所有專案的管理權限，外流的話請到
   Account Settings → Access Tokens 撤銷並重新產生。

### 想收緊權限

改 `.mcp.json` 後重啟 Claude Code：

- 加 `"--read-only"` 到 args → 只能查詢，不能寫入。
- 把 `--features` 縮成 `functions,debugging` → 只能部署與看日誌，完全不碰資料。

---

## 不透過 MCP 的作法

MCP 沒設定好、或你想自己來的時候：

```bash
npm run fn:deploy   # 部署兩支 Edge Function（line-webhook 自動帶 --no-verify-jwt）
npm run fn:serve    # 本機執行 line-webhook
```

`fn:deploy` 需要先 `npx supabase login` 與 `npx supabase link --project-ref <ref>`。

資料庫操作則照 [`DB_MAINTENANCE.md`](DB_MAINTENANCE.md)，在 Supabase SQL Editor 手動執行。
