import type { LoginInfo } from '../auth/loginInfo';

/** 後台 RPC（supabase/app/schema/09_admin.sql）回來的形狀 */
export interface AdminLimits { max_entries: number; max_ai_calls: number; max_photos: number }
export interface AdminTripRow {
  id: string; name: string; created_at: string; is_archived: boolean; plan: string;
  extra_entries: number; extra_ai_calls: number; extra_photos: number; ai_suspended: boolean;
  members: number; accounts: number; owner: LoginInfo[] | null; line_bound: boolean; last_entry: string | null;
  limits: AdminLimits; entries: number; ai_calls: number; photos: number;
}
export interface AdminAccountRow {
  id: string; created_at: string; last_sign_in_at: string | null; logins: LoginInfo[];
  paid: boolean; admin: boolean; trips: number; ai_calls: number;
  allowance: { created: number; limit: number; paid: boolean };
}
