// ============================================================
// tools/schemas.ts —— 工具參數的 JSON Schema
//
// 同一份 schema 有兩個用途，所以只能寫一次：
//   1. Gemini 的 function declaration（`tools[0].functionDeclarations[].parameters`）
//   2. MCP 的 `tools/list`（`inputSchema`）
//
// ⚠️ 四條硬性限制，違反的話 Gemini 直接回 400，而且錯誤訊息不會告訴你是哪一條：
//    - 不可以有 `additionalProperties` → 「成員 → 金額」只能用陣列表達
//    - 不可以有 `$ref`（所以下面是複製貼上而不是共用節點）
//    - 不可以有 `oneOf` / `anyOf`
//    - STRING 不可以有 `format`（日期只能在 description 裡講清楚）
//    `type` 一律小寫 —— MCP 要求小寫，Gemini 兩種都收。
//    registry.test.ts 會遞迴掃過每一支工具的 schema 再確認一次。
// ============================================================

import type { JsonSchema } from "./types.ts"

/** 沒有參數的工具也要給一個空物件，Gemini 不接受省略 `parameters` */
export const NO_ARGS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
}

export const AMOUNT_LIST_SCHEMA: JsonSchema = {
  type: 'array',
  description: '每位成員分到的金額。留空由系統套用旅程預設值（預設付款人／預設分攤成員／全員均分）',
  items: {
    type: 'object',
    properties: {
      member: { type: 'string', description: '成員名稱，必須一字不差地來自旅程的成員清單' },
      amount: { type: 'number', description: '這位成員的金額。全部填 0 代表「請系統均分」' },
    },
    required: ['member', 'amount'],
  },
}

/** 一筆支出的內容。description 與 amount 以外都可省略，省略的由旅程設定補。 */
export const EXPENSE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: '品項或商店名稱。外文請保留原文並在括號附繁體中文' },
    amount: { type: 'number', description: '總金額。🚫 嚴禁換算匯率，照抄使用者說的或收據上印的數字' },
    currency: { type: 'string', description: 'ISO 幣別代碼，例如 TWD / JPY / USD。只在 currency_source 不是 none 時才有意義' },
    currency_source: {
      type: 'string',
      enum: ['stated', 'preference', 'none'],
      description: 'stated＝使用者這句話（或收據上）明確出現幣別字眼或符號；preference＝記帳偏好指定；none＝都沒有',
    },
    date: { type: 'string', description: '日期，YYYY-MM-DD。省略代表今天' },
    category: { type: 'string', description: '從旅程的分類清單中挑一個' },
    payer_data: AMOUNT_LIST_SCHEMA,
    split_details: AMOUNT_LIST_SCHEMA,
  },
  required: ['description', 'amount'],
}

/** 指定某一筆既有支出。`ref` 是 list_expenses 回傳的 8 碼編號。 */
export const EXPENSE_REF_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    expense_ref: {
      type: 'string',
      description: '支出編號，list_expenses 回傳的 ref（8 碼，可加 # 開頭），或完整 uuid',
    },
  },
  required: ['expense_ref'],
}

/** 修改既有支出：指定哪一筆，加上要改的欄位（沒給的沿用原值） */
export const UPDATE_EXPENSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ...(EXPENSE_REF_SCHEMA.properties ?? {}),
    ...(EXPENSE_INPUT_SCHEMA.properties ?? {}),
    // 只有這一支的 description／amount 是選填，覆寫掉上面複製過來的說明
    description: { type: 'string', description: '新的品項或商店名稱。不改就別填' },
    amount: { type: 'number', description: '新的總金額。不改就別填；改了而沒給 payer_data／split_details 時系統會重新均分' },
  },
  required: ['expense_ref'],
}

export const LIST_EXPENSES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: '起始日期（含），YYYY-MM-DD' },
    to: { type: 'string', description: '結束日期（含），YYYY-MM-DD' },
    category: { type: 'string', description: '只看這個分類' },
    member: { type: 'string', description: '只看這位成員有份的（付款或分攤都算）' },
    payer: { type: 'string', description: '只看這位成員付的' },
    keyword: { type: 'string', description: '描述包含這段文字（不分大小寫）' },
    include_settlements: { type: 'boolean', description: '是否包含結清紀錄，預設 false' },
    limit: { type: 'integer', description: '最多回傳幾筆，預設 20、上限 50' },
  },
  required: [],
}

export const GET_BALANCE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    member: { type: 'string', description: '只看這位成員的淨結餘。省略代表全員' },
  },
  required: [],
}

// ============================================================
// 「提議」類的 schema —— 給對話式管道（LINE）用
//
// 與上面的差別只在「誰按下確認」：MCP 的 create／update／delete_expense 是
// 直接落地，LINE 這邊一律先出一張卡片，使用者按了才寫進資料庫。
// 內容欄位刻意共用同一份 schema，未來 MCP 若也要「先提議再確認」就不必再寫一份。
// ============================================================

/** 一句話可以記好幾筆。上限是 LINE 一次 reply 只能送 5 則訊息（要留一則放說明）。 */
export const MAX_PROPOSED_EXPENSES = 4

export const PROPOSE_EXPENSES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    expenses: {
      type: 'array',
      description: `這句話要記的支出，1 到 ${MAX_PROPOSED_EXPENSES} 筆。「午餐 300 晚餐 500」是兩筆，一次全部回傳。`,
      items: EXPENSE_INPUT_SCHEMA,
    },
    corrects_draft: {
      type: 'string',
      description: '若這句話是在修正某張尚未確認的草稿，填該草稿的 nonce；否則不要填',
    },
  },
  required: ['expenses'],
}

export const ANALYZE_RECEIPT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    expense_ref: {
      type: 'string',
      description: '要重新閱讀收據的那一筆的 ref（8 碼）。不確定是哪一筆就不要填，系統會自己去全庫找',
    },
    question: { type: 'string', description: '使用者想知道的事情，例如「買了什麼」「幫我翻譯品項」' },
  },
  required: ['question'],
}

export const REPLY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '要回給使用者的繁體中文訊息。條列式、簡短，適合在手機上閱讀' },
  },
  required: ['text'],
}
