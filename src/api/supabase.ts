import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Supabase credentials are missing. Check your .env file.');
}

/**
 * trips 除了 access_code 以外的欄位。
 *
 * 首頁、其他旅程、LIFF 頁面一律用這份 —— `select('*')` 會把**每一趟**旅程的進入密碼
 * 一起傳到瀏覽器，打開首頁的人在開發者工具就看得到。
 * 只有已經通過通行碼的 Dashboard 抓自己這一趟時用 `*`（設定頁要顯示、修改密碼）。
 * ⚠️ RLS 仍然全開（docs/ROADMAP.md 風險 1），這只是不主動送出去，不是存取控制。
 */
// 必須是單一字串字面值：supabase-js 從 select 字串推導回傳型別，串接出來的 string 它讀不懂
export const TRIP_COLUMNS = 'id, name, members, categories, category, base_currency, timezone, rates, precision_config, is_archived, default_currency, default_category, default_payer, default_split_members, ai_preference, created_at';

export const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : (null as unknown as SupabaseClient);
