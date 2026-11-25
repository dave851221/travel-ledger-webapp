// ============================================================
// _shared/assistant/types.ts —— 對話式記帳（LINE、網頁）共用的型別
//
// 原本在 line-webhook/types.ts，網頁聊天（web-chat）也要用，搬到這裡；
// line-webhook/types.ts 原樣轉出。純型別檔，沒有執行期程式碼。
// ============================================================

import type { ReceiptItem } from "../itemSplit.ts"
import type { AmountMap } from "../types.ts"
import type { CurrencySource } from "../validate.ts"

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

/** 收據 OCR 的回應 */
export interface OcrResponse {
  /** expense＝收據；item_photo＝可記帳的品項照片（金額先填 0）；not_receipt＝與消費無關 */
  type: 'expense' | 'item_photo' | 'not_receipt'
  data?: AiExpenseData
  /** 收據上的品項明細（🧾 逐項分用） */
  items?: unknown
  items_subtotal?: unknown
  /** 付款人的來源：photo／preference 才採用模型的 payer_data，其餘改用傳照片的人 */
  payer_source?: unknown
  /** 兩種 type 都不是時的後備說明 */
  content?: string
}

/** 「全庫找出使用者問的是哪一筆收據」那次額外呼叫的回應 */
export interface PhotoSelectResponse {
  found?: boolean
  ref?: string
}


/** 一張還沒被確認或取消的記帳草稿（LINE 存在 pending 列，網頁存在使用者的瀏覽器） */
export interface OutstandingDraft {
  nonce: string
  exp: DraftExpense
  photoIds: string[]
  /** 照片是收據（見 line-webhook/types.ts 的 PendingDraft.rc） */
  receipt: boolean
  tripId: string
  /** 收據品項明細（🧾 逐項分），沒有就是空陣列 */
  items: ReceiptItem[]
  /** 收據印的品項小計（PendingDraft.st） */
  subtotal?: number
}
