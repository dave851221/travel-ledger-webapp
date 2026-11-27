// ============================================================
// web-chat/config.ts —— 網頁聊天的環境變數與常數
//
// 與 line-webhook 用同一組 AI 密鑰（AI_PROVIDER、GEMINI_API_KEY、ANTHROPIC_API_KEY…），
// 兩邊永遠用同一家、同一個模型回答。
//
// 開放版（另一個 schema、LINE／Google 登入）沿用這支函式時要改的地方都在這裡與 auth.ts：
//   APP_DB_SCHEMA   資料表所在的 schema（預設 public）
//   auth.ts         誰可以操作哪一趟旅程
// ============================================================

import { isPublicApp } from "../_shared/appMode.ts"

/** 開放版（tlb-web-chat）跟舊版共用這份程式：app schema、私有 bucket、要登入（auth.ts）、扣 AI 額度（handlers.ts） */
export const IS_PUBLIC = isPublicApp()

export const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
export const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
export const AI_PROVIDER = (Deno.env.get('AI_PROVIDER') || 'gemini').trim().toLowerCase()
export const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') || ''
export const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') || ''
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
export const WEBAPP_URL = IS_PUBLIC
  ? (Deno.env.get('TLB_WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp/next')
  : (Deno.env.get('WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp')
/** 資料表所在的 schema。開放版用另一個 schema 時設這個（`supabase secrets set APP_DB_SCHEMA=...`） */
export const APP_DB_SCHEMA = IS_PUBLIC ? 'app' : (Deno.env.get('APP_DB_SCHEMA') || 'public')

/** 收據照片的 bucket，路徑慣例 expenses/{tripId}/{檔名}（supabase/scripts/delete_trip.sql 依賴這個前綴） */
export const RECEIPTS_BUCKET = IS_PUBLIC ? 'app-images' : 'travel-images'

/** 餵給 AI 的對話輪數，與 LINE 相同 */
export const CHAT_HISTORY_TURNS = 8
/** 一則訊息最多讓 AI 上網搜尋幾次，與 LINE 相同 */
export const WEB_SEARCH_MAX_USES = 2
/**
 * 整個 AI 迴圈的時間上限。網頁沒有 replyToken 的一分鐘時效，但使用者一樣在等，
 * 而且 Edge Function 的請求也有上限 —— 跟 LINE 用同一個數字。
 */
export const AI_DEADLINE_MS = 45_000
/** 補問一次「這句是不是在改草稿」至少要剩這麼多時間 */
export const DRAFT_RETRY_MIN_MS = 15_000
