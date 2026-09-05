// ============================================================
// tools/args.ts —— 把外面給的參數收斂成工具層的型別
//
// args 來自模型或 MCP 客戶端，schema 只是「請求」不是保證：
// 少一個欄位、型別填錯、多塞一個都可能發生，所以每一個值都要自己收。
//
// 兩個呼叫端共用同一份：registry.ts（MCP 與工具測試）與
// line-webhook 的 function calling 迴圈。分成兩份寫過的話，
// 「LINE 收得比較鬆」這種差異只會在正式環境才被發現。
// ============================================================

import type { CurrencySource } from "../validate.ts"
import type { ExpenseInput, ListExpensesFilters, ToolArgs } from "./types.ts"

export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

export function toExpenseInput(args: ToolArgs): ExpenseInput {
  return {
    description: String(args.description ?? ''),
    amount: Number(args.amount) || 0,
    currency: optionalString(args.currency),
    currency_source: optionalString(args.currency_source) as CurrencySource | undefined,
    date: optionalString(args.date),
    category: optionalString(args.category),
    payer_data: args.payer_data as ExpenseInput['payer_data'],
    split_details: args.split_details as ExpenseInput['split_details'],
  }
}

/** 修改用：**沒給的欄位必須留成 undefined**，那是「沿用原值」的訊號 */
export function toExpensePatch(args: ToolArgs): Partial<ExpenseInput> {
  const patch: Partial<ExpenseInput> = {}
  if (args.description !== undefined) patch.description = String(args.description)
  if (args.amount !== undefined) patch.amount = Number(args.amount) || 0
  if (args.currency !== undefined) patch.currency = String(args.currency)
  if (args.currency_source !== undefined) patch.currency_source = String(args.currency_source) as CurrencySource
  if (args.date !== undefined) patch.date = String(args.date)
  if (args.category !== undefined) patch.category = String(args.category)
  if (args.payer_data !== undefined) patch.payer_data = args.payer_data as ExpenseInput['payer_data']
  if (args.split_details !== undefined) patch.split_details = args.split_details as ExpenseInput['split_details']
  return patch
}

export function toListFilters(args: ToolArgs): ListExpensesFilters {
  return {
    from: optionalString(args.from),
    to: optionalString(args.to),
    category: optionalString(args.category),
    member: optionalString(args.member),
    payer: optionalString(args.payer),
    keyword: optionalString(args.keyword),
    includeSettlements: args.include_settlements === true,
    limit: args.limit === undefined ? undefined : Number(args.limit) || undefined,
  }
}
