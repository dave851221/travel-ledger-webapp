// ============================================================
// config.ts —— 環境變數、常數與關鍵字表
//
// 這一層不 import 任何執行期的東西（只有型別），是模組相依的最底層：
// config → db → line-api → drafts / messages / gemini → handlers → index
//
// 關鍵字表原本宣告在 serve() 裡面，每收到一則訊息就重建一次陣列，
// 而且 handlers 拆出去之後就再也拿不到 —— 一併提到模組層級。
// ============================================================

import type { GroupMode } from "./types.ts"
import { isPublicApp } from "../_shared/appMode.ts"

/**
 * 開放版（旅行喵喵，tlb-line-webhook）與舊版（耀西）共用這份程式，差在下面這幾個設定。
 * 見 _shared/appMode.ts：由進入點決定，不是環境變數（secrets 是整個 Supabase 專案共用的）。
 */
export const IS_PUBLIC = isPublicApp()

export const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get(IS_PUBLIC ? 'TLB_BOT_ACCESS_TOKEN' : 'LINE_CHANNEL_ACCESS_TOKEN') || ''
export const LINE_CHANNEL_SECRET = Deno.env.get(IS_PUBLIC ? 'TLB_BOT_CHANNEL_SECRET' : 'LINE_CHANNEL_SECRET') || ''
/** 資料在哪個 schema：舊版 public，開放版 app（表名相同） */
export const DB_SCHEMA = IS_PUBLIC ? 'app' : 'public'
/** 綁定的旅程不見了（被刪掉）時的說法 */
export const TRIP_GONE_MSG = IS_PUBLIC
  ? '❌ 找不到這個旅程，可能已被刪除。請重新輸入「綁定」選一趟。'
  : '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。'
export const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
export const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
/**
 * 用哪一家 AI：`gemini`（預設，免費額度）或 `claude`（付費）。
 * 選 claude 時 Gemini 仍是備援，語音也一律交給 Gemini（Claude 沒有音訊輸入）。
 * 改這個值只要 `supabase secrets set AI_PROVIDER=...`，不必改程式。
 */
export const AI_PROVIDER = (Deno.env.get('AI_PROVIDER') || 'gemini').trim().toLowerCase()
/** 留空就用 `_shared/ai/claude.ts` 的預設（Haiku 5.5） */
export const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') || ''
/** Google Places API（search_places）。沒設就不給模型查地點，回覆也不附行程表以外的地圖連結 */
export const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') || ''
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

export const WEBAPP_URL = IS_PUBLIC
  ? (Deno.env.get('TLB_WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp/next')
  : (Deno.env.get('WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp')
/**
 * LIFF app 的 ID（不是密鑰）。有值時卡片按鈕改開 https://liff.line.me/<ID>，
 * LIFF 頁面才能用 liff.sendMessages 代送「✅ 已記帳」換機器人的免費回覆（_shared/liffEcho.ts）。
 * 預設是正式的 LIFF app（Endpoint = GitHub Pages）；secret LIFF_ID 設成空字串＝照舊直接開網頁。要跟前端 src/utils/liff.ts 的 LIFF_ID 一致。
 */
// 開放版是另一個 LIFF app（旅行小本本的 LINE Login channel，endpoint /next/），要跟前端 src/utils/liff.ts 一致
export const LIFF_ID = IS_PUBLIC
  ? (Deno.env.get('TLB_LIFF_ID') ?? '2012815845-0THqm2DV')
  : (Deno.env.get('LIFF_ID') ?? '2012713943-msELyw4c')


// 收據照片的 bucket。路徑慣例 expenses/{tripId}/{檔名}，
// supabase/scripts/delete_trip.sql 依賴這個前綴清理照片，勿隨意更名。
// 開放版是私有 bucket：卡片上的照片用簽名網址（drafts.ts 的 photoViewUrls）
export const RECEIPTS_BUCKET = IS_PUBLIC ? 'app-images' : 'travel-images'

// AI 失敗與改用備援時的說法，網頁聊天也用同一份（_shared/assistant/notices.ts）
export { AI_BUSY_MSG, AI_QUOTA_MSG, aiUnavailableMessage, FALLBACK_NOTICES, RATE_LIMIT_MSG } from "../_shared/assistant/notices.ts"

/** 餵給 AI 的對話輪數。太多會稀釋掉當下這句話的份量。 */
export const CHAT_HISTORY_TURNS = 8

/**
 * 群組（提及模式）裡，機器人回覆之後**同一個人**在這段時間內的下一句話不必再 @ 也會處理。
 * 這種「接話」由 AI 判斷是不是在跟它講話，不是的話就不回（stay_silent）。
 */
export const FOLLOWUP_WINDOW_MS = 3 * 60 * 1000

/** 一則訊息最多讓 AI 上網搜尋幾次（一次約 US$0.01 加上搜尋結果的 token） */
export const WEB_SEARCH_MAX_USES = 2

/** 等待輸入通行碼的有效期限（M1）。超過就自動放棄，不會一直卡在等密碼狀態。 */
export const PENDING_BIND_TTL_MS = 10 * 60 * 1000

// ── 路由用的關鍵字表 ───────────────────────────────
// 全部走「整句完全相符」的比對（`includes`），不是前綴或子字串 ——
// 群組裡的「設定好了嗎」曾因為 startsWith 被當成管理指令送進 AI（M3）。

/** 直接查 DB 的快捷查詢，不經過 AI */
export const QUICK_CMD_KEYWORDS = ['今日支出', '今天支出', '本週支出', '近期支出', '本月支出', '結算', '旅程總覽']
/** 撤銷「已經存檔」的最後一筆。與草稿的「取消」是兩回事。 */
export const UNDO_KEYWORDS = ['取消上一筆', '撤銷上一筆', '刪除上一筆', '刪掉上一筆', '移除上一筆']
/** 列出近期支出讓使用者點選刪除 */
export const DELETE_LIST_KEYWORDS = ['刪除支出', '刪除紀錄', '刪除記錄', '管理支出', '刪除哪一筆']
/** 列出近期支出讓使用者點選編輯 */
export const EDIT_LIST_KEYWORDS = ['編輯支出', '編輯紀錄', '編輯記錄', '修改支出', '修改紀錄']
/** 切換群組回應模式的指令（見 types.ts 的 GroupMode） */
export const GROUP_MODE_COMMANDS: Record<string, GroupMode> = {
  '模式:提及模式': 'mention',
  '模式:全回應模式': 'all',
  '模式:靜音模式': 'silent',
}
/** 想看完整的自我介紹 */
export const HELP_KEYWORDS = ['使用說明', '說明', '教學', '怎麼用', '怎麼使用', '如何使用', 'help', 'HELP', 'Help', '功能']
