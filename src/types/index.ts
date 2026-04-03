export interface Trip {
  id: string;
  name: string;
  access_code: string;
  members: string[];
  categories: string[];
  base_currency: string;
  default_currency?: string;
  default_category?: string;
  rates: Record<string, number>;
  precision_config: Record<string, number>;
  is_archived: boolean;
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
}
