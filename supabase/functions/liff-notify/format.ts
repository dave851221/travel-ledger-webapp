// Confirmation text pushed after a LIFF save.
//
// The layout is shared with line-webhook's save replies (_shared/savedText.ts);
// this wrapper only picks the LIFF header.

import { buildSavedText as buildText, type SavedExpense } from '../_shared/savedText.ts'

export type { SavedExpense }

/**
 * Lists everything that was actually written (after the user's edits in LIFF):
 * title, amount, category, payers and split. Text only, no photo, no receipt items.
 */
export function buildSavedText(
  expense: SavedExpense,
  isUpdate: boolean,
  precisionConfig: Record<string, number> = {},
): string {
  return buildText(expense, { header: isUpdate ? '✏️ 已透過 LIFF 更新' : '✅ 已透過 LIFF 存入' }, precisionConfig)
}
