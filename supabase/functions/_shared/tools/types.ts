// ============================================================
// tools/types.ts —— 共用工具層的型別
//
// 工具層是「記帳能做什麼」的唯一實作（見 docs/MCP_SERVER_DESIGN.md §2、§6）：
// LINE Bot 是它的第一個呼叫端，未來的 MCP server 會是第二個。
// 因此這一層**不碰 Deno.env、不建 Supabase client、不組任何 LINE 訊息** ——
// client 與旅程由呼叫端放進 ToolContext 傳進來，vitest 才測得動。
//
// 純型別檔，沒有執行期程式碼。
// ============================================================

import type { SupabaseClient } from "../deps.ts"
import type { AmountMap, ExpenseRow, TripRow } from "../types.ts"
import type { CurrencySource } from "../validate.ts"

// ============================================================
// context
// ============================================================

/**
 * 一次工具呼叫的環境。
 *
 * `trip` 是**已經查好的**旅程 —— 工具層不負責去找它，
 * 因為呼叫端本來就要先確定「這個人有權限操作哪一趟」（LINE 看綁定，
 * MCP 看 token）。`today` 同理：時區怎麼推是 transport 的事（見 line-webhook/util.ts）。
 */
export interface ToolContext {
  db: SupabaseClient
  trip: TripRow
  /** 這趟旅程的「今天」，YYYY-MM-DD */
  today: string
  /** 這次操作是誰做的（LINE 的傳訊者、MCP 的 token 標籤）。補預設付款人時會用到。 */
  actorName?: string | null
}

/**
 * 只需要「哪個資料庫、哪一趟旅程」的工具用得到的最小 context。
 *
 * `ToolContext` 在結構上相容於它，所以 registry 一律傳完整的 context；
 * 但 LINE 的 undo／del 只有一個 expense id 與旅程 id，
 * 為了它們多查一次整趟旅程並不划算。
 */
export interface ScopedContext {
  db: SupabaseClient
  trip: { id: string }
}

// ============================================================
// 支出的輸入與輸出
// ============================================================

/**
 * 「成員 → 金額」的陣列形式。
 *
 * Gemini 的 function declaration 與 response schema 都不支援
 * `additionalProperties`，動態 key 的物件表達不出來，只能用陣列。
 * `toAmountMap()` 會把它轉回程式內部慣用的 `{ 成員: 金額 }`。
 */
export interface AmountEntry {
  member: string
  amount: number
}

/**
 * 呼叫端（AI 或 MCP 客戶端）給的一筆支出。
 *
 * 除了 description 與 amount 以外全部可選 —— 沒給的欄位由
 * `prepareExpense()` 依旅程設定補上，這正是「不信任 AI 算出來的數字」的作法。
 *
 * ⚠️ 金額欄位宣告成陣列或 map 兩種都收：schema 要求的是陣列，
 *    但舊草稿與沒有 schema 的模型仍可能回 map（見 `toAmountMap`）。
 */
export interface ExpenseInput {
  description: string
  amount: number
  currency?: string
  /** 幣別是哪裡來的。交給 resolveCurrencyByRule 決定要不要採信（T3） */
  currency_source?: CurrencySource
  date?: string
  category?: string
  payer_data?: AmountEntry[] | AmountMap
  split_details?: AmountEntry[] | AmountMap
}

/**
 * 驗證與分帳都做完、可以直接寫進資料庫的一筆支出。
 *
 * 欄位名沿用「草稿」的說法（`split_details`）而不是資料庫的 `split_data`：
 * 它同時要餵給 LINE 的卡片與 LIFF 編輯器。落地時由 `commitExpense()` 改名。
 */
export interface PreparedExpense {
  description: string
  amount: number
  currency: string
  date: string
  category: string
  payer_data: AmountMap
  split_details: AmountMap
  /** 餘數要算在誰頭上。null 代表沒有可分配的成員。 */
  adjustment_member: string | null
}

/**
 * `prepareExpense()` 的結果。
 *
 * ⚠️ **`reject` 有值時 `expense` 仍然是正規化好的內容**：收據的幣別在這趟旅程
 *    沒有匯率時（M10），LINE 還要把它存成 pending，讓使用者按「以 XXX 存入」
 *    直接換個幣別存下去，不必重拍收據。
 *
 * `unresolvedMembers` 刻意不自己決定該怎麼辦 —— 文字路徑要拒絕（打錯名字就重講），
 * OCR 路徑只警告（照片留著，讓使用者按「✏️ 編輯」改），兩種行為都要保留。
 */
export interface PrepareResult {
  expense: PreparedExpense
  /** 被修正過的欄位（幣別／分類／日期），要如實告訴使用者，不能默默改掉 */
  warnings: string[]
  /** 對不上旅程成員清單的名字，已從金額 map 中移除 */
  unresolvedMembers: string[]
  /** 有值代表「不能就這樣存」，內容是給使用者看的完整說明 */
  reject: string | null
}

/** 修改支出時，哪一個欄位從什麼變成什麼 */
export interface FieldChange {
  field: string
  before: unknown
  after: unknown
}

/** `prepareExpenseUpdate()` 的結果：比 PrepareResult 多一份異動清單 */
export interface PrepareUpdateResult extends PrepareResult {
  changes: FieldChange[]
}

/** 寫入失敗的原因。訊息文字由呼叫端決定 —— 工具層不知道對方是 LINE 還是 MCP。 */
export type CommitFailureReason =
  | 'trip_missing'
  | 'archived'
  | 'empty_participants'
  | 'dropped_members'
  | 'sum_mismatch'

export type CommitExpenseResult =
  | {
    ok: true
    /**
     * 新支出的 id。
     * ⚠️ insert 沒回 id 時是 null（維持 LINE 既有行為：仍視為存入，只是沒有撤銷按鈕）。
     */
    id: string | null
    adjustment_member: string | null
  }
  | { ok: false; reason: CommitFailureReason; dropped?: string[] }

export type UpdateFailureReason = 'not_found' | 'archived' | 'empty_participants' | 'sum_mismatch'

export type CommitUpdateResult =
  | { ok: true; id: string }
  | { ok: false; reason: UpdateFailureReason }

export type DeleteFailureReason = 'not_found' | 'already_deleted' | 'update_failed'

export type DeleteExpenseResult =
  | { ok: true; description: string }
  | { ok: false; reason: DeleteFailureReason; description?: string }

export type RestoreFailureReason = 'not_found' | 'not_deleted' | 'update_failed'

export type RestoreExpenseResult =
  | { ok: true; description: string }
  | { ok: false; reason: RestoreFailureReason; description?: string }

// ============================================================
// 查詢
// ============================================================

export interface ListExpensesFilters {
  /** 起始日期（含），YYYY-MM-DD */
  from?: string
  /** 結束日期（含），YYYY-MM-DD */
  to?: string
  category?: string
  /** 出現在付款人或分攤名單裡的成員 */
  member?: string
  /** 只看這個人付的 */
  payer?: string
  /** 描述包含這段文字（不分大小寫） */
  keyword?: string
  /** 預設 false —— 結清紀錄不是消費 */
  includeSettlements?: boolean
  /** 預設 20，上限 50 */
  limit?: number
}

/** 給 AI 看的一筆支出。`ref` 是 uuid 前 8 碼，短到模型抄得準（T4 的教訓）。 */
export interface ExpenseBrief {
  ref: string
  id: string
  date: string
  description: string
  amount: number
  currency: string
  category: string
  payers: AmountMap
  splits: AmountMap
  hasPhoto: boolean
  isSettlement: boolean
}

export interface ListExpensesResult {
  /** 實際回傳的筆數 */
  count: number
  /** 還有更多沒回傳（被 limit 或伺服器端上限切掉） */
  truncated: boolean
  expenses: ExpenseBrief[]
}

export interface ResolveRefOptions {
  includeDeleted?: boolean
  allowSettlement?: boolean
}

// ============================================================
// 餘額與結算
// ============================================================

export interface BalanceResult {
  baseCurrency: string
  /** 折合主幣別的淨結餘（正＝應收、負＝應付）。有指定 member 時只有那一個人。 */
  balances: Record<string, number>
  /** 各幣別的原幣淨結餘 */
  byCurrency: Record<string, Record<string, number>>
  /** 有支出用到、但旅程沒設匯率的幣別（已被當成 1:1，必須提醒使用者） */
  missingRateCurrencies: string[]
}

export interface SettlementStep {
  from: string
  to: string
  amount: number
}

export interface SettlementPlanResult {
  baseCurrency: string
  settlements: SettlementStep[]
  balances: Record<string, number>
  missingRateCurrencies: string[]
}

// ============================================================
// 旅程
// ============================================================

/** `get_trip` 的回傳。刻意不含 access_code 與 ai_preference 以外的內部欄位。 */
export interface TripInfo {
  id: string
  name: string
  members: string[]
  categories: string[]
  baseCurrency: string
  defaultCurrency: string
  defaultCategory: string | null
  defaultPayer: string[]
  defaultSplitMembers: string[]
  rates: Record<string, number>
  precision: Record<string, number>
  timezone: string | null
  today: string
  isArchived: boolean
  aiPreference: string | null
}

// ============================================================
// 工具定義
// ============================================================

/**
 * 工具參數的 JSON Schema。
 *
 * ⚠️ 這個型別刻意**沒有** `additionalProperties`、`$ref`、`oneOf`／`anyOf`
 *    與 STRING 的 `format` —— Gemini 的 function declaration 不支援它們，
 *    帶了會直接 400。型別擋一層，registry.test.ts 再遞迴檢查一次。
 */
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  description?: string
  enum?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
}

/** 從模型或 MCP 客戶端進來的參數。內容一律先驗證再使用。 */
export type ToolArgs = Record<string, unknown>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
  execute(args: ToolArgs, ctx: ToolContext): Promise<unknown>
}

/** Gemini 的 function declaration（`tools[0].functionDeclarations` 的元素） */
export interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: JsonSchema
}

/** re-export，讓呼叫端只 import 這一個檔案就夠 */
export type { AmountMap, ExpenseRow, TripRow }
