# 架設與部署指南

從零建立這個專案的完整步驟。日常開發指令與架構說明請看根目錄的 [`CLAUDE.md`](../CLAUDE.md)。

## 1. 環境需求

- Node.js v18 以上、npm v9 以上
- 一個 Supabase 專案（免費方案即可）
- 若要啟用 LINE Bot：LINE Developers 的 Messaging API channel、Google AI Studio 的 Gemini API key

## 2. 前端

```bash
npm install
cp .env.example .env      # 然後填入實際值
npm run dev               # http://localhost:5173
```

`.env` 需要兩個變數，皆可在 Supabase Dashboard → Project Settings → API 取得：

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your_publishable_or_anon_key
```

> `.env` 已被 gitignore，切勿提交。

## 3. 資料庫

### 全新架設

把 [`supabase/schema/bootstrap.generated.sql`](../supabase/schema/bootstrap.generated.sql)
整份貼進 Supabase Dashboard → SQL Editor 執行一次。它會建立：

- `trips` / `expenses` 兩張核心表
- `line_trip_id_mapping` / `line_user_states` / `line_chat_history` / `line_processed_actions` 四張 LINE Bot 表
- 通行碼驗證函式、短碼產生器與觸發器
- RLS 政策、Realtime 發布設定
- `travel-images` storage bucket 與其政策

腳本可重複執行，不會因為重跑而出錯。

### schema/ 與 migrations/ 的分工

| 目錄 | 用途 |
| :--- | :--- |
| `supabase/schema/NN_*.sql` | **結構的唯一事實來源**。改資料庫結構時改這裡 |
| `supabase/schema/bootstrap.generated.sql` | 由上面自動串接產生，給全新架設一次貼上用。**勿手動編輯** |
| `supabase/migrations/` | 給**已在運作**的資料庫做增量變更 |
| `supabase/scripts/` | 手動執行的維運工具，見 [`DB_MAINTENANCE.md`](DB_MAINTENANCE.md) |

改動結構的流程是**兩邊都要動**：

1. 修改對應的 `supabase/schema/NN_*.sql`
2. 執行 `npm run db:build` 重新產生 bootstrap
3. 另外寫一支 `supabase/migrations/YYYYMMDD_描述.sql` 讓既有資料庫跟上

這樣「從零建置」與「既有升級」兩條路徑都有涵蓋，而 bootstrap 由程式產生，
不會再發生過去 `SQL_SETUP.sql` 與 migration 內容各自漂移的問題。

## 4. LINE Bot（Edge Function）

### A. Supabase CLI

```bash
npx supabase login
npx supabase link --project-ref <你的_PROJECT_REF>
```

### B. 設定密鑰

```bash
npx supabase secrets set LINE_CHANNEL_ACCESS_TOKEN=xxx
npx supabase secrets set LINE_CHANNEL_SECRET=xxx
npx supabase secrets set GEMINI_API_KEY=xxx
npx supabase secrets set WEBAPP_URL=https://<你的帳號>.github.io/travel-ledger-webapp
```

`SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 由平台自動注入，不需自行設定。
改動密鑰後必須重新部署才會生效。

### C. 部署

```bash
npx supabase functions deploy line-webhook --no-verify-jwt
npx supabase functions deploy liff-notify
```

> ⚠️ **`--no-verify-jwt` 是必填的。** LINE 的 webhook 呼叫不帶 Supabase JWT，
> 少了這個旗標會一律收到 401，Bot 對所有訊息完全無反應，而且不會有任何錯誤提示。
> `supabase/config.toml` 也已設定 `[functions.line-webhook] verify_jwt = false` 作為第二道保險。

### D. 登錄 Webhook URL

到 LINE Developers → 你的 Channel → Messaging API：

1. Webhook URL 填 `https://<PROJECT_REF>.supabase.co/functions/v1/line-webhook`
2. 開啟 **Use webhook**
3. 點 **Verify** 確認連通

本機開發用 `npx supabase functions serve line-webhook`。

## 5. 前端部署（GitHub Pages）

推送到 `main` 會由 [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) 自動建置並部署。

Repo 的 Settings → Secrets and variables → Actions 需要設定：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## 6. 新增行程頁

見 [`ITINERARY_AUTHORING.md`](ITINERARY_AUTHORING.md)。
