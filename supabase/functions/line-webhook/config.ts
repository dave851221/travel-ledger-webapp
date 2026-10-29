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
export const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
/**
 * 用哪一家 AI：`gemini`（預設，免費額度）或 `claude`（付費）。
 * 選 claude 時 Gemini 仍是備援，語音也一律交給 Gemini（Claude 沒有音訊輸入）。
 * 改這個值只要 `supabase secrets set AI_PROVIDER=...`，不必改程式。
 */
export const AI_PROVIDER = (Deno.env.get('AI_PROVIDER') || 'gemini').trim().toLowerCase()
/** 留空就用 `_shared/ai/claude.ts` 的預設（Haiku 5.5） */
export const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') || ''
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

export const WEBAPP_URL = Deno.env.get('WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp'


// 收據照片的 bucket。路徑慣例 expenses/{tripId}/{檔名}，
// supabase/scripts/delete_trip.sql 依賴這個前綴清理照片，勿隨意更名。
export const RECEIPTS_BUCKET = 'travel-images'

export const RATE_LIMIT_MSG = '⚠️ AI 服務暫時達到免費使用量上限，請隔天再試。'
export const AI_BUSY_MSG = '⏳ AI 服務目前忙碌中，請過幾分鐘再試一次。'
export const AI_QUOTA_MSG = '⚠️ AI 本月的使用額度已經用完了，請管理員到 Anthropic Console 調整上限或儲值。'

/**
 * AI 失敗時（錯誤前綴的定義見 `_shared/ai/types.ts`）要回給使用者的話；
 * 其他錯誤回傳 null，由呼叫端用自己的訊息。
 */
export const aiUnavailableMessage = (e: unknown): string | null => {
  const message = String((e as { message?: unknown } | null)?.message)
  if (message.startsWith('RATE_LIMIT:')) return RATE_LIMIT_MSG
  if (message.startsWith('AI_QUOTA:')) return AI_QUOTA_MSG
  if (message.startsWith('AI_BUSY:')) return AI_BUSY_MSG
  return null
}

/**
 * 主要的 AI 失敗、這次改由備援（Gemini 免費版）回答時，放在回覆最前面的一句話。
 * LINE 的 replyToken 只能用一次，沒辦法先回一則「請稍候」再補答案（那要用推播，免費方案每月只有 200 則），
 * 所以併在同一則裡講。
 */
export const FALLBACK_NOTICES = {
  quota: '⚠️ Claude 本月額度已用完，這次改用免費版 Gemini 回覆（可能比較慢、也比較不準）。',
  error: '⚠️ Claude 暫時連不上，這次改用免費版 Gemini 回覆。',
} as const

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
/** 想看完整的自我介紹 */
export const HELP_KEYWORDS = ['使用說明', '說明', '教學', '怎麼用', '怎麼使用', '如何使用', 'help', 'HELP', 'Help', '功能']
