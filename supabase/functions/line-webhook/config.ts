// ============================================================
// config.ts —— 環境變數、常數與關鍵字表
//
// 這一層不 import 任何東西，是模組相依的最底層：
// config → db → line-api → drafts / messages / gemini → handlers → index
//
// 關鍵字表原本宣告在 serve() 裡面，每收到一則訊息就重建一次陣列，
// 而且 handlers 拆出去之後就再也拿不到 —— 一併提到模組層級。
// ============================================================

export const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
export const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') || ''
export const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

export const WEBAPP_URL = Deno.env.get('WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp'


// 收據照片的 bucket。路徑慣例 expenses/{tripId}/{檔名}，
// supabase/scripts/delete_trip.sql 依賴這個前綴清理照片，勿隨意更名。
export const RECEIPTS_BUCKET = 'travel-images'

export const RATE_LIMIT_MSG = '⚠️ AI 服務暫時達到免費使用量上限，請隔天再試。'
export const isRateLimit = (e: unknown) => String((e as { message?: unknown } | null)?.message).startsWith('RATE_LIMIT:')

/** 餵給 AI 的對話輪數。太多會稀釋掉當下這句話的份量。 */
export const CHAT_HISTORY_TURNS = 8

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
/** 想看完整的自我介紹 */
export const HELP_KEYWORDS = ['使用說明', '說明', '教學', '怎麼用', '怎麼使用', '如何使用', 'help', 'HELP', 'Help', '功能']
