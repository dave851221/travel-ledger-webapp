# 開放版（旅行小本本）的資料防護規則

舊版（旅遊小本本，`public` schema）是給親友用的，RLS 全開，見 [`ROADMAP.md`](ROADMAP.md) 風險 1。
開放版（`app` schema）給陌生人用，**每一個新功能都要對過下面這份清單**，PR 說明裡寫出對過哪幾條。

## 規則

1. **預設拒絕。** `app` 裡每張表建立時就 `ENABLE ROW LEVEL SECURITY`，沒有政策就誰都讀不到。
   表權限只給需要的角色、需要的動作；`anon` 對任何表都沒有權限。
   `trips` 用欄位級權限（`supabase/app/schema/01_tables.sql`）：新增欄位時要決定它屬於「成員可改」還是「只有 owner 透過 RPC 改」，
   並補進 GRANT —— 對整張表 GRANT 再 REVOKE 單一欄位是沒有效果的。
2. **不信任前端。** 權限、額度、付款狀態只在資料庫（RLS、RPC、trigger）或 Edge Function 判斷。
   寫入者（`created_by`）由 trigger 蓋上，前端送什麼都不算。
3. **Edge Function 自己驗身分。** 它們用 service role，RLS 管不到。每支都要先驗
   （使用者 JWT、LINE 簽章、金流檢查碼），再用同一個共用函式確認是不是這趟旅程的成員，
   之後的每個查詢都帶著那個 trip id。要有「從 A 旅程拿不到 B 旅程」的測試。
4. **只給需要的資料。** 不用 `select('*')`；其他成員的 LINE ID、Email、密碼雜湊永遠不送到瀏覽器；
   log 只記數字與錯誤代碼，不記訊息內容、收據文字。
5. **照片私有。** 開放版的 bucket 不公開，只發短期簽名網址；上傳限制類型與大小。
6. **金鑰。** 前端只有公開金鑰；其他都在 Supabase secrets 與 GitHub Secrets。
   封測前輪換曾經進過 git 的公開金鑰（舊網頁一起更新）。
7. **外來的東西一律驗過。** AI 的輸出、匯入的行程、使用者的 HTML、webhook 回呼，先驗證再存。
8. **刪除是真的刪。** 刪帳號、刪旅程時照片一起刪；備份加密、只留 30 天。
9. **管理功能只有管理者。** 用帳號角色、由伺服器判斷，不靠藏起來的網址。
10. **每個階段過關前做一次安全檢查。** Supabase 的 security advisors、對整份差異做一次安全審查，問題修完才開放。

## SECURITY DEFINER 函式的寫法

- `SET search_path = ''`，函式裡一律寫完整的 schema 名稱。
- 第一件事檢查 `auth.uid()` 與身分（`app.is_member` / `app.is_owner`），不過就 `RAISE`。
- 建立後 `REVOKE ALL ... FROM PUBLIC`，再只 `GRANT EXECUTE` 給需要的角色。
- 錯誤用固定的英文代碼（`not_member`、`not_owner`、`invalid_invite`…），前端依代碼顯示中文。

## 前端的防護（開放版）

- **共用裝置**：這台裝置上屬於某個帳號的資料（旅程清單快取、帳目快取、我是誰、聊天、照片簽名網址）
  一律用 `tlb:` 開頭的鍵（`src/config/mode.ts` 的 `globalStorageKey` / `tripStorageKey` / `meKey`）。
  登入的人換了或登出時，`ensureCacheOwner`（`features/auth/session.ts`）整批清掉；
  上一個人還沒上傳的離線帳也會被清掉（不能用別人的身分上傳）。新增任何存在裝置上的資料都要用這些 helper。
- **照片**：Cloudflare R2 的私有 bucket `tlb-photos`（2026-11-27 從 Supabase Storage 的 `app-images` 搬過去，讓 Supabase 維持免費方案）。
  R2 金鑰只在 Edge Function（secrets `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`，選填 `R2_BUCKET`），網頁一律經過 `tlb-photos`：
  上傳（≤ 10 MB、只收圖片、要是成員；`app.add_trip_photo` 先占位置擋張數上限）、簽名網址（12 小時，只簽自己是成員的旅程）、刪除（成員）、整趟刪除（owner）。
  每張照片在 `app.trip_photos` 記一列（只有 service role 碰得到），`count_photos` 數這張表＋還留在 `app-images` 的（本機沒設 R2 金鑰時照片放 `app-images`）。
  LINE 機器人與網頁聊天透過 `_shared/photoStore.ts` 存取，舊版照舊用公開的 `travel-images`。分享頁不顯示照片。
  R2 bucket 的 CORS 只開 GET／HEAD 給網站網域與 localhost:5173（回顧影片要用 CORS 讀原圖）。本機測試：`scripts/local-photos-test.mjs`；搬既有照片：`scripts/migrate-photos-r2.mjs`。
- **LINE 登入**：只收網頁 OAuth 的 code（伺服器自己換 ID token、驗 nonce）或 LIFF 的 access token
  （伺服器向 LINE 確認是發給我們 channel 的）；前端送來的 ID token 一律不收（有效期內可以重放）。
  `auth-line` 的 CORS 只對 `APP_ALLOWED_ORIGINS` 裡的網站回 Allow-Origin。
- **成員看得到的帳號資訊**：只走 `trip_member_accounts`／`my_logins`（SECURITY DEFINER，要是成員／本人），
  給 LINE／Google 顯示名稱與遮過的 email（`d***e@gmail.com`）；不給完整 email、LINE userId、auth 的 id 以外的東西。
- **連結帳號**：Google 用 `supabase.auth.linkIdentity`（Auth 要開 manual linking）；LINE 走 `auth-line` 的 `link`，
  伺服器用呼叫者的 JWT 認人，那個 LINE 已經屬於別的帳號就拒絕（不合併、不搶）。

## 用量上限（app/05_quota.sql）

- 每趟的上限在 `app.plan_limits`（free／paid），加量在 `trips.extra_*`；只有 service role 能改。
- 記帳筆數由 trigger 擋（新增、從垃圾桶救回、把結清改成一般帳都算），照片由 storage 上傳政策擋。
- AI：Edge Function 叫 AI **之前**一定要先 `consumeAi()`（`_shared/quota.ts`），不過就不叫；
  只限「每趟」的次數，不限每個人；總開關在 `app.quota_settings.ai_enabled`（設成 false 立刻全部停）。
- 建立旅程：沒付過費的帳號最多建立 5 趟（`app.trip_creations` 記錄，刪掉旅程也不會空出名額），`app.paid_accounts` 裡的帳號不限。

- **刪除帳號**：`app.delete_my_account`（要使用者自己打「刪除帳號」），只剩自己的旅程整趟刪除、其他旅程交給下一位；
  登入方式的 sha256 與建立過的趟數留在 `app.deleted_identity_trips`（不存原文），重新註冊不會重拿免費名額。

## 上線時要做的設定（還沒做）

- 正式資料庫：把 `supabase/app/app.generated.sql` 當成第一支 migration 跑一次（之後的變更照 CLAUDE.md 寫成 `supabase/migrations/`）；
  Dashboard → API 的 Exposed schemas 加上 `app`。
- Supabase Auth：開 Google、關 Email 註冊；Redirect URLs 加開放版網址。
- Edge Function secrets：`LINE_LOGIN_CHANNEL_ID`、`LINE_LOGIN_CHANNEL_SECRET`、`APP_ALLOWED_ORIGINS`；部署 `auth-line --no-verify-jwt`。
- 前端建置：`VITE_APP_MODE=public`、`VITE_LINE_LOGIN_CHANNEL_ID`，輸出到 GitHub Pages 的 `/next/`。
- LINE：新的 provider 底下建 LINE Login channel（callback 填開放版網址）與新官方帳號的 Messaging API channel，兩個要在**同一個 provider**。

## 怎麼測

權限測試在 `supabase/app/tests/`（pgTAP），在本機 Supabase 跑，不碰正式資料庫：

```bash
npm run db:local          # 第一次：啟動本機 Supabase（需要 Docker Desktop）
npm run db:local:reset    # 改了 schema 之後：重新產生並重灌
npm run db:test           # 跑權限測試（pgTAP）+ 透過 API 的整段流程（scripts/local-flow-test.mjs）
```

本機的設定在 `local/supabase/config.toml`；`npm run db:build` 把舊版與開放版的 schema 接成
`local/supabase/migrations/00000000000000_bootstrap.generated.sql`，開機時當成唯一一支 migration 跑
（要比 API 先建好 app schema，所以不能用 seed）。新增表或 RPC 時，兩邊的測試都補一條「不該做到的人做不到」。

看畫面：`VITE_APP_MODE=public`、`VITE_SUPABASE_URL=http://127.0.0.1:54321`、`VITE_SUPABASE_ANON_KEY=<supabase status 的 ANON_KEY>`
跑 `npx vite`，開 `http://localhost:5173/travel-ledger-webapp/next/`，用登入框下面的「本機開發專用」Email 登入，
信在 http://localhost:54324。
