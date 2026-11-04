// Confirmation text pushed after a LIFF save.
//
// Kept as a pure function (no Deno/Supabase imports besides finance.ts) so vitest
// can cover it alongside the other Edge Function helpers.

import { formatAmount } from '../_shared/finance.ts'

export type SavedExpense = {
  date?: string | null
  category?: string | null
  description?: string | null
  amount: number | string
  currency: string
  payer_data?: Record<string, number | string> | null
  split_data?: Record<string, number | string> | null
}

/**
 * Lists everything that was actually written (after the user's edits in LIFF):
 * title, amount, category, payers and split. Text only, no photo.
 */
export function buildSavedText(
  expense: SavedExpense,
  isUpdate: boolean,
  precisionConfig: Record<string, number> = {},
): string {
  const currency = expense.currency
  const fmt = (v: number | string) => formatAmount(Number(v) || 0, currency, precisionConfig)
  const rows = (data: Record<string, number | string> | null | undefined) => {
    const entries = Object.entries(data ?? {}).filter(([, v]) => Number(v) !== 0)
    return entries.length > 0
      ? entries.map(([name, v]) => `• ${name} ${fmt(v)}`).join('\n')
      : '• （無）'
  }

  const header = isUpdate ? '✏️ 已透過 LIFF 更新' : '✅ 已透過 LIFF 存入'
  const meta = [expense.date ? `📅 ${expense.date}` : '', expense.category ? `🏷️ ${expense.category}` : '']
    .filter(Boolean)
    .join(' · ')

  return [
    `${header}：${expense.description || expense.category || ''}`,
    `💰 ${fmt(expense.amount)} ${currency}`,
    ...(meta ? [meta] : []),
    '',
    '👛 付款人',
    rows(expense.payer_data),
    '',
    '🧾 分帳明細',
    rows(expense.split_data),
  ].join('\n')
}
