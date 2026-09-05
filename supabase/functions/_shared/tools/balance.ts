// ============================================================
// tools/balance.ts —— 誰欠誰多少
//
// 只是把 _shared/finance.ts 的兩支演算法接上資料庫，本身不做任何算術 ——
// 網頁的 useTripStats 呼叫的是同一份邏輯的前端版本，兩份由
// src/utils/finance.parity.test.ts 的契約測試比對（M14）。
// 這一層唯一的責任是「把該撈的列撈齊」。
// ============================================================

import { calculateMemberBalances, calculateSettlements } from "../finance.ts"
import type { BalanceResult, SettlementPlanResult, ToolContext } from "./types.ts"

/**
 * 算餘額用的所有支出。
 *
 * ⚠️ **結清紀錄（is_settlement）也要撈進來**：結清就是「誰把錢還給誰」，
 *    不計入的話結清完帳面上還是欠著。垃圾桶裡的（deleted_at）才要排除。
 */
async function loadBalanceRows(ctx: ToolContext) {
  const { data } = await ctx.db.from('expenses')
    .select('amount, currency, payer_data, split_data')
    .eq('trip_id', ctx.trip.id)
    .is('deleted_at', null)
  return data ?? []
}

/**
 * 每人折合主幣別的淨結餘。正數＝應收，負數＝應付。
 *
 * 指定 `member` 時只回那一個人，但仍然是拿**全部**支出算出來的 ——
 * 只看某人有份的那幾筆會算出完全不同的數字。
 */
export async function getBalance(ctx: ToolContext, member?: string | null): Promise<BalanceResult> {
  const rows = await loadBalanceRows(ctx)
  const trip = ctx.trip
  const summary = calculateMemberBalances(rows, trip.members ?? [], trip.rates, trip.base_currency)

  const wanted = String(member ?? '').trim()
  const balances = wanted && summary.grandTotal[wanted] !== undefined
    ? { [wanted]: summary.grandTotal[wanted] }
    : summary.grandTotal

  return {
    baseCurrency: trip.base_currency,
    balances,
    byCurrency: summary.byCurrency,
    missingRateCurrencies: summary.missingRateCurrencies,
  }
}

/**
 * 最少轉帳次數的結清路徑。
 *
 * `missingRateCurrencies` 一定要傳給使用者看 —— 沒設匯率的幣別被當成 1:1 折算，
 * 金額會默默失真，而畫面上完全看不出來（情境 D9）。
 */
export async function getSettlementPlan(ctx: ToolContext): Promise<SettlementPlanResult> {
  const rows = await loadBalanceRows(ctx)
  const trip = ctx.trip
  const { grandTotal, missingRateCurrencies } = calculateMemberBalances(
    rows, trip.members ?? [], trip.rates, trip.base_currency,
  )
  return {
    baseCurrency: trip.base_currency,
    settlements: calculateSettlements(grandTotal),
    balances: grandTotal,
    missingRateCurrencies,
  }
}
