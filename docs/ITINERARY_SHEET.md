# 用 Google 試算表排行程（開放版）

David 2026-11-27：開放版的使用者自己用 Google 試算表排行程，旅程的「行程」分頁貼上試算表連結就會整理成每天的時間軸，旅行喵喵（LINE、網頁 AI）也讀得到。
舊版的行程頁照舊寫在程式裡（`docs/ITINERARY_AUTHORING.md`）。

## 模板

**範例（給使用者複製）**：David 的「旅行小本本範例」<https://docs.google.com/spreadsheets/d/12LfnaUsjqkc65FIyOfdoRD-3gRRFMwoHHrGE4LtgLew>（2026-11-28 填好京都三天的範例、下拉選單、日期時間欄純文字、凍結標題列、使用說明分頁）。
行程分頁的「複製範例到我的 Google 雲端」連 `/copy`，「下載 Excel」連 `/export?format=xlsx`（`src/features/itinerary/sheet.ts`）。**這份要維持「知道連結的任何人：檢視者」**，開成編輯者的話任何人都能改壞範例。
下面的 xlsx 是同樣格式的備份，範例壞掉時可以重新上傳。

- 產生：`python scripts/make-itinerary-template.py` → `docs/itinerary-sheet-template.xlsx`
- 上架：上傳到 Google 雲端硬碟 → 用 Google 試算表開啟 → 檔案 → 儲存為 Google 試算表 → 共用改「知道連結的任何人：檢視者」
  → 網址的 `/edit…` 換成 `/copy`，填進 `src/features/itinerary/sheet.ts` 的 `SHEET_TEMPLATE_COPY_URL`（空字串時設定頁改成教人自己開欄位）。
- 分頁（名稱固定，可以自己多加欄位或分頁）：
  - **行程**：日期｜時間｜類型｜行程｜地點｜備註｜連結｜預訂。日期只寫每天第一列；類型選「📅 當天標題」的那列是那天的標題（地點欄＝城市）；備註一行一條，開頭「!」是紅色提醒；地點用「、」分隔；只有一個地點時連結掛在地點上，否則掛在標題上；航班會另外列進行前的航班。
  - **住宿**：入住日期｜退房日期｜住宿名稱｜地址｜連結｜備註。入住日 ≤ 那天 < 退房日 的那間就是當晚住宿。
  - **行前準備**：一列一項，可以打勾（記在各自手機）。
- 日期、時間欄在模板裡是純文字格式：Google 不會自動轉成日期，gviz 也不會因為一欄混了不同型別而把字丟掉。

## 程式

| 位置 | 內容 |
| :--- | :--- |
| `app.trips.itinerary_sheet` | 試算表 id（`supabase/app/schema/11_itinerary.sql`），成員可看可改 |
| `_shared/sheetItinerary.ts` | 讀 gviz CSV（`/gviz/tq?tqx=out:csv&headers=1&sheet=分頁名`）、解析成 `ItineraryDoc`；純函式，`sheetItinerary.test.ts` |
| `tlb-itinerary` | Edge Function：成員才讀得到；`{ tripId, sheet }` 是貼連結時先試讀 |
| `_shared/assistant/itinerary.ts` | 旅行喵喵讀行程：開放版有 `itinerary_sheet` 就讀試算表（快取 2 分鐘），否則讀網頁打包的 JSON |
| `src/features/itinerary/SheetItinerary.tsx` | 行程分頁：還沒連結時三個步驟＋貼連結；連結後先畫這台裝置上次讀到的，同時讀最新的 |

試算表沒開放檢視時 Google 回登入頁（HTML），回 `not_shared`，畫面教人改共用設定。
