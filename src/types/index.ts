export interface Trip {
  id: string;
  name: string;
  /**
   * NULL 或空白代表該旅程免密碼。
   * 只有 Dashboard 抓自己這一趟時才會有這個欄位，其餘查詢用 TRIP_COLUMNS 不帶它。
   */
  access_code?: string | null;
  /** 開放版才有：沒登入的人能不能看（members／link／password） */
  visibility?: 'members' | 'link' | 'password';
  /** 開放版才有：分享連結與邀請連結裡的隨機字串（成員看得到，owner 才能重設） */
  share_token?: string;
  invite_token?: string;
  created_by?: string | null;
  members: string[];
  categories: string[];
  category?: string | null;
  base_currency: string;
  /**
   * IANA 時區字串（例如 Asia/Tokyo）。LINE Bot 判斷「今天」用的就是它。
   * NULL／undefined 代表沒設，Bot 會退回從幣別推測（主幣 TWD 的日本旅程會猜錯，M4）。
   */
  timezone?: string | null;
  /**
   * 旅程日期（選填，YYYY-MM-DD）。一天的旅程只有 start_date；一段時間再加 end_date（含當天）。
   * 都沒填的舊旅程，首頁用建立時間代替。見 utils/tripDates.ts
   */
  start_date?: string | null;
  end_date?: string | null;
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
  /** 開放版：行程用的 Google 試算表 id（features/itinerary/sheet.ts） */
  itinerary_sheet?: string | null;
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
