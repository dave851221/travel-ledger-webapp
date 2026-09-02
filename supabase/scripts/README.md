# 資料庫維運腳本

這裡的 SQL 是**手動在 Supabase SQL Editor 執行**的維運工具，不屬於資料庫結構的一部分，
不會被 `npm run db:build` 收進 `bootstrap.generated.sql`。

| 檔案 | 用途 |
| :--- | :--- |
| `list_trips.sql`   | 列出所有旅程與其支出/照片數量，用來查 UUID。直接執行，不需修改 |
| `preview_trip.sql` | 唯讀預覽「刪除某旅程會刪掉什麼」。需填入 UUID |
| `delete_trip.sql`  | 永久刪除一個旅程。需填入 UUID。**不可逆** |

**完整操作步驟、注意事項與疑難排解，請看 [`docs/DB_MAINTENANCE.md`](../../docs/DB_MAINTENANCE.md)。**
這裡只放檔案清單，避免同一份說明散在兩處各自漂移。

> 刪除旅程刻意**不提供**網頁介面，也不建立可被 PostgREST 呼叫的 RPC ——
> 這是為了避免誤觸讓整個旅程消失。
