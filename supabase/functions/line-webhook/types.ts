// ============================================================
// types.ts —— LINE webhook 事件、DB 列與 Gemini 往來的型別
//
// 這支函式處理的東西幾乎都是「外部來的 payload」：LINE 的事件、Gemini 的回應、
// 沒有產生型別的 Supabase 查詢結果。以前一律寫成 any，於是欄位打錯只會在
// 正式環境安靜地變成 undefined。這裡只宣告**程式真的會讀到**的欄位，
// 不追求完整覆蓋 LINE 的 API 文件 —— 沒用到的欄位寫上去只會變成要維護的謊言。
//
// 純型別檔，沒有執行期程式碼。
// ============================================================

import type { AmountMap } from "../_shared/types.ts"
import type { CurrencySource } from "../_shared/validate.ts"

// ============================================================
// LINE webhook 事件
// ============================================================

/** user＝一對一、group＝群組、room＝多人聊天室。後兩者一律視為「群組」。 */
export type SourceType = 'user' | 'group' | 'room'

/**
 * ⚠️ sourceId 是 groupId ?? roomId ?? userId —— 群組內所有人共用同一份綁定與偏好，
 *    那是刻意的設計（見 supabase/schema/02_tables_line.sql）。
 *    userId 是「實際發言的人」，群組事件裡也一定有（除非使用者未加好友）。
 */
export interface EventSource {
  type: SourceType
  userId?: string
  groupId?: string
  roomId?: string
}

/** LINE 的 mention 條目。index／length 是相對於**未 trim 的**原始 text。 */
export interface Mentionee {
  index?: number
  length?: number
  isSelf?: boolean
  userId?: string
}

export interface TextMessage {
  type: 'text'
  id: string
  text: string
  mention?: { mentionees?: Mentionee[] }
}

export interface ImageMessage {
  type: 'image'
  id: string
}

export interface AudioMessage {
  type: 'audio'
  id: string
  duration?: number
}

/** 貼圖、影片、檔案、位置 —— 一律不處理，列在這裡只是為了讓聯集能收斂。 */
export interface UnsupportedMessage {
  type: 'sticker' | 'video' | 'file' | 'location'
  id?: string
}

export type LineMessage = TextMessage | ImageMessage | AudioMessage | UnsupportedMessage

export interface MessageEvent {
  type: 'message'
  replyToken: string
  source: EventSource
  message: LineMessage
  timestamp?: number
}

export interface PostbackEvent {
  type: 'postback'
  replyToken: string
  source: EventSource
  postback: { data: string; params?: Record<string, string> }
  timestamp?: number
}

/** 被加進群組／聊天室（M19）。回一段自我介紹，不然機器人進來之後一片安靜。 */
export interface JoinEvent {
  type: 'join'
  replyToken: string
  source: EventSource
  timestamp?: number
}

/** 收得到但這支函式不處理的事件。列出來是為了讓 WebhookEvent 是個真的聯集。 */
export interface IgnoredEvent {
  type: 'follow' | 'unfollow' | 'leave' | 'memberJoined' | 'memberLeft'
    | 'unsend' | 'videoPlayComplete' | 'beacon' | 'accountLink' | 'things'
  replyToken?: string
  source: EventSource
  timestamp?: number
}

export type WebhookEvent = MessageEvent | PostbackEvent | JoinEvent | IgnoredEvent

/** message 事件的窄化捷徑，讓 handler 的簽名寫得出來 */
export type TextMessageEvent = MessageEvent & { message: TextMessage }
export type ImageMessageEvent = MessageEvent & { message: ImageMessage }
export type AudioMessageEvent = MessageEvent & { message: AudioMessage }

// ============================================================
// postback 與草稿
// ============================================================

/**
 * 一張記帳草稿的內容。
 *
 * 短鍵（d/a/c/dt/cat/p/s）是為了 postback data 的 300 bytes 上限；
 * 更早的卡片帶的是長鍵，**已經發出去的卡片還在使用者的聊天室裡**，
 * 所以兩種都要看得懂。讀的時候一律 `raw.d ?? raw.description`。
 */
export interface DraftExpense {
  /** description */
  d?: string
  /** amount */
  a?: number | string
  /** currency */
  c?: string
  /** date */
  dt?: string
  /** category */
  cat?: string
  /** payer_data */
  p?: AmountMap
  /** split_details */
  s?: AmountMap

  // ── 舊卡片的長鍵 ──
  description?: string
  amount?: number | string
  currency?: string
  date?: string
  category?: string
  payer_data?: AmountMap
  split_details?: AmountMap
}

/**
 * postback 的 data（一段 JSON 字串）解析後的樣子。
 *
 * 刻意**不是** act 的判別聯集：save／cancel 兩個分支同時接受新版的 `act`
 * 與舊版的 `action`，還要在短鍵與長鍵之間退化，用聯集反而每一行都要 narrow。
 * 全部欄位皆選填，由各分支自己驗。
 */
export interface PostbackData {
  /** 新版動作 */
  act?: 'undo' | 'cur' | 'del' | 'upd' | 'save' | 'cancel'
  /** 舊版動作（save_expense / cancel） */
  action?: string
  /** nonce（新版短鍵） */
  n?: string
  /** nonce（舊版長鍵） */
  nonce?: string
  /** expense id（undo、del 用） */
  eid?: string
  /** 描述。舊的 undo 卡片才有，現在改成回查 DB。 */
  d?: string
  /** 使用者選的幣別（cur 用） */
  c?: string
  /** 收據 photo id（新版短鍵） */
  p?: string[]
  /** 收據 photo id（舊版長鍵） */
  photo_urls?: string[]
  /** 支出內容（新版短鍵） */
  exp?: DraftExpense
  /** 支出內容（舊版長鍵） */
  expense?: DraftExpense
  trip_id?: string
}

/**
 * line_chat_history 的 `pending` 列，content 存的就是這個 JSON。
 *
 * `kind` 決定按下確認會發生什麼事：
 *   `expense`（或沒有這個欄位，舊列都是這樣）→ 新增一筆，走 `act: 'save'`
 *   `update` → 把 `eid` 那一筆改成 `exp` 的內容，走 `act: 'upd'`
 *   `delete` → 軟刪除 `eid` 那一筆，走 `act: 'del'`
 *
 * ⚠️ 只有 `expense` 算「草稿」：update／delete 的列不可以被
 *    `getOutstandingDrafts()` 撈出來，否則使用者打「取消」會取消到一張
 *    他根本沒在看的修改卡，AI 也會拿它的 nonce 當 `corrects_draft`。
 */
export interface PendingDraft {
  /** nonce */
  n: string
  kind?: 'expense' | 'update' | 'delete'
  /** 要寫進去的內容。`delete` 沒有內容可寫，所以是選填。 */
  exp?: DraftExpense
  /** 要修改或刪除的既有支出 id（kind 為 update／delete 時才有） */
  eid?: string
  /** 收據 photo id 或 Storage 路徑 */
  p?: string[]
  /** 這張草稿屬於哪個旅程 —— 換旅程後舊草稿必須失效，靠的就是它（M13） */
  tid?: string
}

// ============================================================
// DB 列（Supabase 沒有產生型別，只列會讀到的欄位）
// ============================================================

export interface UserStateRow {
  line_user_id: string
  current_trip_id: string | null
  pending_trip_id: string | null
  pending_at: string | null
  /** 群組觸發模式，true＝需 @提及或以「耀西」開頭 */
  mention_required: boolean | null
  last_active_at: string | null
  /** 已不再讀寫，偏好改存 trips.ai_preference */
  default_config?: string | null
  created_at?: string
}

export interface ChatHistoryRow {
  /** user / model 是餵給 AI 的對話；pending 是草稿；saved 是「撤銷上一筆」用的支出 id */
  role: 'user' | 'model' | 'pending' | 'saved'
  content: string
  speaker_user_id?: string | null
  speaker_name?: string | null
  created_at?: string
}

/** line_chat_history 的 `saved` 列，content 存的就是這個 JSON。 */
export interface SavedExpenseEntry {
  expense_id: string
  description?: string
  /** 記錄這筆的人（群組才有） */
  by?: string | null
}

// ============================================================
// Gemini
// ============================================================

// 往來的資料形狀（含 functionCall／functionResponse）定義在 _shared/gemini.ts ——
// 那一層不碰 Deno.env，vitest 才測得動 function calling 迴圈。這裡原樣轉出，
// 讓 line-webhook 這邊的 import 路徑不變。
export type {
  GeminiContent,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiTextPart,
} from "../_shared/gemini.ts"

/**
 * AI 回傳的支出內容。
 *
 * ⚠️ payer_data／split_details 剛解析出來時是 response_schema 產生的**陣列**
 *    （`[{ member, amount }]`），`normalizeExpenseAmountMaps()` 會就地換成 map。
 *    呼叫端在正規化之後才把它當 `ExpenseDraft` 用。
 */
export interface AiExpenseData {
  description?: string
  amount?: number
  currency?: string
  /** AI 對「這個幣別是哪裡來的」的自我宣告，交給 resolveCurrencyByRule 判斷（T3） */
  currency_source?: CurrencySource
  date?: string
  category?: string
  payer_data?: unknown
  split_details?: unknown
}

/**
 * 正規化之後、可以直接拿去算分帳的支出。
 *
 * 與 AiExpenseData 的差別只在金額欄位已經是 map。
 * photo_ids 是文字路徑沿用收據草稿時才會有。
 */
export type ExpenseDraft = {
  description: string
  amount: number
  currency: string
  currency_source?: CurrencySource
  date: string
  category: string
  payer_data: AmountMap
  split_details: AmountMap
  photo_ids?: string[]
}

/** 收據 OCR 的回應 */
export interface OcrResponse {
  type: 'expense' | 'not_receipt'
  data?: AiExpenseData
  /** 兩種 type 都不是時的後備說明 */
  content?: string
}

/** 「全庫找出使用者問的是哪一筆收據」那次額外呼叫的回應 */
export interface PhotoSelectResponse {
  found?: boolean
  ref?: string
}

// ============================================================
// 其他
// ============================================================

/**
 * 一則文字訊息通過群組觸發判斷之後的結果。
 * 所有指令比對用的都是 cleanText —— 已經去掉「@耀西」與開頭的「耀西」。
 */
export interface TextRoute {
  /** 未 trim 的原文。mentionees 的 index 是相對於它，切 mention 只能用這個。 */
  rawText: string
  cleanText: string
  /** 訊息裡有沒有 @提及機器人自己 */
  isMentioned: boolean
  /** 去掉自我提及之後是不是以「耀西」開頭 */
  startsWithYoshi: boolean
}

/** getQuickReply 等函式回傳的快速回覆。內容是 LINE 的 action 物件，不再細分。 */
export interface QuickReply {
  items: Record<string, unknown>[]
}

/**
 * 送給 LINE 的一則訊息（text、flex …）。
 * 刻意不細分 —— Flex 的結構有幾十種節點，寫成型別維護不起來，
 * 而且這支函式只是把它 JSON.stringify 之後丟出去。
 */
export type OutgoingMessage = Record<string, unknown>

/** buildExpenseCard 讀得到的欄位。草稿與換幣別後的重算結果都能餵進來。 */
export interface ExpenseCardData {
  description?: unknown
  amount?: unknown
  currency?: unknown
  date?: unknown
  category?: unknown
  payer_data?: Record<string, unknown>
  split_details?: Record<string, unknown>
}

/**
 * Supabase Edge Runtime 注入的全域物件。
 *
 * `waitUntil` 讓非同步工作在 Response 送出後仍跑得完 —— 本機 `functions serve`
 * 與測試環境沒有它，所以一律要先檢查存在再呼叫。
 */
export interface EdgeRuntimeGlobal {
  waitUntil?: (promise: Promise<unknown>) => void
}
