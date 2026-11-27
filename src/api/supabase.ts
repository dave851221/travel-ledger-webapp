import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DB_SCHEMA, IS_PUBLIC } from '../config/mode';

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
export const TRIP_COLUMNS = 'id, name, members, categories, category, base_currency, timezone, start_date, end_date, rates, precision_config, is_archived, default_currency, default_category, default_payer, default_split_members, ai_preference, created_at';

/**
 * Dashboard 抓「自己這一趟」用的欄位。
 * 舊版：`*`（含 access_code，設定頁要顯示與修改）。
 * 開放版：沒有 access_code；分享設定與連結給成員看（owner 才能改），密碼雜湊誰都讀不到 ——
 * 開放版的 trips 是欄位級權限，`*` 會因為碰到 view_password_hash 而被拒絕。
 */
export const TRIP_DETAIL_COLUMNS: string = IS_PUBLIC
  ? `${TRIP_COLUMNS}, visibility, share_token, invite_token, created_by`
  : '*';

/**
 * 舊版：沒有登入，資料在 public（跟以前完全一樣）。
 * 開放版：資料在 app schema；登入走 PKCE（回來時網址帶 ?code=，不會跟 HashRouter 的 # 打架）。
 * 見 src/config/mode.ts。
 */
export const supabase = (supabaseUrl && supabaseAnonKey)
  ? (IS_PUBLIC
      ? createClient(supabaseUrl, supabaseAnonKey, {
          db: { schema: DB_SCHEMA },
          auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        }) as unknown as SupabaseClient
      : createClient(supabaseUrl, supabaseAnonKey))
  : (null as unknown as SupabaseClient);
