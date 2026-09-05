// ============================================================
// types.ts —— Edge Function 端的資料庫列型別
//
// 欄位定義刻意「複製」自 src/types/index.ts 的 Trip / Expense，而不是 import ——
// 前端走 npm 與 bundler，Edge Function 走 Deno 的 URL import，
// 跨越 src/ 與 supabase/functions/ 的相對 import 兩邊都編不過。
//
// ⚠️ 改前端的 Trip / Expense 時記得同步這裡（與 finance.ts 兩份實作同樣的處境）。
// ============================================================

/** JSONB 的「成員名稱 → 金額」。key 是純字串顯示名稱，不是成員 ID。 */
export type AmountMap = Record<string, number>

/** JSONB 的「幣別 → 小數位數」，例如 { TWD: 0, JPY: 0, USD: 2 } */
export type PrecisionConfig = Record<string, number>

/** trips 資料表的一列。對齊 src/types/index.ts 的 Trip。 */
export interface TripRow {
  id: string
  name: string
  /** NULL 或空白代表該旅程免密碼 */
  access_code: string | null
  members: string[]
  categories: string[]
  /** 旅程自己的分組（首頁分組用），與 categories（支出分類清單）是兩回事 */
  category?: string | null
  base_currency: string
  /**
   * IANA 時區字串（例如 Asia/Tokyo）。LINE Bot 判斷「今天」用的就是它。
   * NULL／undefined 代表沒設，Bot 會退回從幣別推測（主幣 TWD 的日本旅程會猜錯，M4）。
   */
  timezone?: string | null
  default_currency?: string
  default_category?: string
  default_payer?: string[]
  default_split_members?: string[]
  rates: Record<string, number>
  precision_config: PrecisionConfig
  is_archived: boolean
  /**
   * LINE Bot 解析自然語言與收據時參考的自由文字偏好。
   * 整趟旅程共用一份（不分 LINE 綁定、不分管道），空字串一律存成 NULL。
   */
  ai_preference?: string | null
  created_at: string
}

/** expenses 資料表的一列。對齊 src/types/index.ts 的 Expense。 */
export interface ExpenseRow {
  id: string
  trip_id: string
  date: string
  category: string
  description: string
  amount: number
  currency: string
  payer_data: AmountMap
  split_data: AmountMap
  adjustment_member: string | null
  /** Storage 路徑而非完整 URL（顯示時要自行加上 public bucket 前綴） */
  photo_urls: string[]
  is_settlement: boolean
  /** 軟刪除。非 NULL 代表在垃圾桶裡。 */
  deleted_at: string | null
  created_at: string
}
