export interface Trip {
  id: string;
  name: string;
  /** NULL 或空白代表該旅程免密碼 */
  access_code: string | null;
  members: string[];
  categories: string[];
  category?: string | null;
  base_currency: string;
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
  is_settlement: boolean;
  deleted_at: string | null;
  created_at: string;
}
