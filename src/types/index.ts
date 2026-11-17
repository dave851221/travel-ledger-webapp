export interface Trip {
  id: string;
  name: string;
  /**
   * NULL 或空白代表該旅程免密碼。
   * 只有 Dashboard 抓自己這一趟時才會有這個欄位，其餘查詢用 TRIP_COLUMNS 不帶它。
   */
  access_code?: string | null;
  members: string[];
  categories: string[];
  category?: string | null;
  base_currency: string;
  /**
   * IANA 時區字串（例如 Asia/Tokyo）。LINE Bot 判斷「今天」用的就是它。
   * NULL／undefined 代表沒設，Bot 會退回從幣別推測（主幣 TWD 的日本旅程會猜錯，M4）。
   */
  timezone?: string | null;
  default_currency?: string;
  default_category?: string;
  default_payer?: string[];
  default_split_members?: string[];
  rates: Record<string, number>;
  precision_config: Record<string, number>;
  is_archived: boolean;
  /**
   * LINE Bot 解析自然語言與收據時參考的自由文字偏好。
   * 整趟旅程共用一份（不分 LINE 綁定、不分管道），空字串一律存成 NULL。
   */
  ai_preference?: string | null;
  created_at: string;
}

export interface Expense {
  id: string;
  trip_id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
  payer_data: Record<string, number>;
  split_data: Record<string, number>;
  adjustment_member: string | null;
  photo_urls: string[];
  /** The subset of photo_urls that are receipts; the rest are item photos (album). */
  receipt_photo_urls?: string[];
  is_settlement: boolean;
  deleted_at: string | null;
  created_at: string;
  /** 只存在前端：離線時記的、還在這支手機上等著上傳（utils/offlineQueue.ts） */
  pending_sync?: boolean;
}

/**
 * 只存在 LIFF 編輯頁：草稿從 LINE 帶來、存檔後要交給 liff-notify 的資訊。
 * ExpenseModal 收到的 editData 可能多帶這幾欄。
 */
export interface LiffExpenseMeta {
  nonce?: string;
  line_user_id?: string;
  /** 收據品項（🧾 逐項分讀到的），推播「已存入」時列出來 */
  receipt_items?: { name: string; amount: number }[];
  /** 每個品項是誰的（與 receipt_items 同長度） */
  item_owners?: string[][];
  /** item_owners 算出來的分帳；表單裡又改過分攤就對不上，推播不再寫「誰點了什麼」 */
  item_split?: Record<string, number>;
}
