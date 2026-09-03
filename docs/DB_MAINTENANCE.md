# 資料庫維運

需要在 Supabase SQL Editor 執行的操作。腳本放在 [`supabase/scripts/`](../supabase/scripts/)。

> 設定好 [`AI_TOOLING.md`](AI_TOOLING.md) 的 Supabase MCP 之後，這些也可以請 AI 代跑，
> 但**步驟與順序仍然一樣** —— 尤其是先 preview 再刪除、以及先清 Storage 再刪資料庫。

---

## 刪除一個旅程

網頁上**刻意沒有**刪除旅程的按鈕，也沒有可以被 API 呼叫的刪除函式 ——
這是為了避免任何人誤觸就讓整個旅程連同所有帳目消失。刪除只能從這裡手動執行。

### 步驟 1：找出旅程的 UUID

把 [`supabase/scripts/list_trips.sql`](../supabase/scripts/list_trips.sql)
整份貼進 Supabase Dashboard → SQL Editor 執行，不需要修改任何內容。

輸出大致如下：

| id | name | category | is_archived | created | expenses | in_trash | photos | linebot_id |
| :-- | :-- | :-- | :-- | :-- | --: | --: | --: | :-- |
| `851bce67-…` | 九寨溝 2026 | 中國 | false | 2026-05-14 | 42 | 3 | 17 | `K7M2PQ` |
| `d7374216-…` | 測試用旅程 | | false | 2026-08-30 | 2 | 0 | 1 | `X4TN9B` |

複製目標那一列的 `id`。

### 步驟 2：預覽會刪掉什麼（唯讀）

打開 [`supabase/scripts/preview_trip.sql`](../supabase/scripts/preview_trip.sql)，
把開頭那行的 `00000000-0000-0000-0000-000000000000` 換成步驟 1 的 UUID，整份貼上執行。

| item | value |
| :-- | :-- |
| trip_name | 測試用旅程 |
| expenses | 2 |
| expenses_in_trash | 0 |
| storage_photos | 1 |
| linebot_id | X4TN9B |
| line_bound_chats | 1 |

**務必確認 `trip_name` 真的是你要刪的那一個。** 若顯示「⚠️ 查無此旅程」代表 UUID 填錯了。
這支腳本只做查詢，跑幾次都不會改到資料。

### 步驟 3：備份（建議）

Supabase Dashboard → Database → Backups 建立一次備份。刪除後就只能靠備份救回來了。

### 步驟 4：執行刪除

打開 [`supabase/scripts/delete_trip.sql`](../supabase/scripts/delete_trip.sql)，
同樣把「← 改這裡」那行的 UUID 換掉，整份貼上執行。

腳本包在單一交易裡，依序做四件事：

1. **先刪 Storage 的收據照片**
2. 解除所有 LINE 聊天的綁定狀態
3. 刪除旅程本身（cascade 會一併帶走 `expenses` 與 `line_trip_id_mapping`）
4. 回報驗證結果

最後一段輸出應該**每一欄都是 0**：

| trips_left | expenses_left | mappings_left | photos_left | line_states_left |
| --: | --: | --: | --: | --: |
| 0 | 0 | 0 | 0 | 0 |

若 UUID 忘了改、或查無此旅程，腳本會拋出例外並回滾整個交易，不會刪到任何東西。

### 為什麼順序是「先 Storage 後資料庫」

`expenses.trip_id` 的外鍵是 `ON DELETE CASCADE`。一旦先刪掉 `trips` 的那一列，
所有 `expenses` 會立刻連帶消失，`photo_urls` 也跟著不見 —— 於是再也查不出
該清掉 bucket 裡的哪些檔案。那些照片會變成無人知曉、也無法追蹤的孤兒，
永遠佔用儲存空間（Storage 不受資料庫外鍵約束，不會自動清理）。

腳本改以路徑前綴 `expenses/{tripId}/` 比對，所以就算真的搞錯順序，
只要還記得 UUID 就能事後補救 —— 但正常流程仍請照順序走。

---

## 常見狀況

### 刪錯旅程了

- **交易還沒 COMMIT**：執行 `ROLLBACK;` 即可，什麼都沒發生。
- **已經 COMMIT**：只能從步驟 3 的備份還原。這也是備份那步不該跳過的原因。

### 旅程刪掉後，LINE 那邊會怎樣

`line_user_states.current_trip_id` 的外鍵是 `ON DELETE SET NULL`，
所以綁定會自動解除，機器人會回到未綁定狀態並提示重新輸入 `ID:短碼`。
使用者不會看到錯誤，只會發現機器人不認得那本帳了。

### 清理孤兒照片

若懷疑 bucket 裡有已刪旅程遺留的檔案：

```sql
-- 列出所有不屬於任何現存旅程的收據照片
SELECT o.name, o.created_at, o.metadata->>'size' AS bytes
FROM storage.objects o
WHERE o.bucket_id = 'travel-images'
  AND o.name LIKE 'expenses/%'
  AND NOT EXISTS (
      SELECT 1 FROM public.trips t
      WHERE o.name LIKE 'expenses/' || t.id::text || '/%'
  )
ORDER BY o.created_at;
```

確認清單無誤後，把 `SELECT o.name, …` 換成 `DELETE` 即可刪除：

```sql
DELETE FROM storage.objects o
WHERE o.bucket_id = 'travel-images'
  AND o.name LIKE 'expenses/%'
  AND NOT EXISTS (
      SELECT 1 FROM public.trips t
      WHERE o.name LIKE 'expenses/' || t.id::text || '/%'
  );
```

---

## 其他常用查詢

### 查某旅程的 LINE 短碼

```sql
SELECT t.name, m.linebot_id
FROM public.trips t
JOIN public.line_trip_id_mapping m ON m.trip_id = t.id
WHERE t.name ILIKE '%關鍵字%';
```

短碼在網頁的「設定 → 基本設定」也看得到。

### 重設某個 LINE 聊天的綁定狀態

當某個群組或使用者卡在奇怪的狀態時（例如一直被要求輸入密碼）：

```sql
UPDATE public.line_user_states
SET current_trip_id = NULL,
    pending_trip_id = NULL
WHERE line_user_id = '<groupId 或 userId>';
```

之後請對方重新輸入 `ID:短碼` 綁定。
注意 `line_user_id` 存的是 **sourceId** —— 群組是 groupId、一對一才是 userId。

### 手動清理過舊的對話紀錄

程式本身會以約 10% 的機率順手清掉 30 天前的紀錄。要立即清理：

```sql
DELETE FROM public.line_chat_history WHERE created_at < NOW() - INTERVAL '30 days';
DELETE FROM public.line_processed_actions WHERE created_at < NOW() - INTERVAL '7 days';
```
