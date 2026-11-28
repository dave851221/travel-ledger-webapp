// ============================================================
// _shared/savedText.ts —— 「已存入／已修改」回覆的完整明細
//
// LINE 上每一條存檔路徑（卡片的確認存入、👤 只算我、✏️ 確認修改，
// 以及 LIFF 存檔後 liff-notify 的推播）都用這一份，存完看到的內容才會一致：
// 標題、金額、日期與分類、誰付款、每個人分攤多少。
//
// ⚠️ 不列收據品項：David 覺得在群組裡把點了什麼都列出來太暴露（2026-11-17），
//    只要看得出誰先付、誰要分攤多少就好。
//
// 純函式：只 import finance.ts，vitest 能直接測。
// ============================================================

import { formatAmountDisplay } from './finance.ts'

export type SavedExpense = {
  date?: string | null
  category?: string | null
  description?: string | null
  amount: number | string
  currency: string
  payer_data?: Record<string, number | string> | null
  split_data?: Record<string, number | string> | null
}

export interface SavedTextOptions {
  /** 第一行的開頭，例如「✅ 已存入」 */
  header: string
  /** 緊接在標題後面，例如「（只算 代杰）」 */
  titleSuffix?: string
  /** 日期分類那一行之後的補充，例如「改了：金額、分攤」 */
  note?: string
  /** 最後一行，例如「（由 代杰 記錄）」 */
  footer?: string
}

export function buildSavedText(
  expense: SavedExpense,
  opts: SavedTextOptions,
  precisionConfig: Record<string, number> = {},
): string {
  const currency = expense.currency
  const fmt = (v: number | string) => formatAmountDisplay(Number(v) || 0, currency, precisionConfig)
  const rows = (data: Record<string, number | string> | null | undefined) => {
    const entries = Object.entries(data ?? {}).filter(([, v]) => Number(v) !== 0)
    return entries.length > 0
      ? entries.map(([name, v]) => `• ${name} ${fmt(v)}`).join('\n')
      : '• （無）'
  }

  const meta = [expense.date ? `📅 ${expense.date}` : '', expense.category ? `🏷️ ${expense.category}` : '']
    .filter(Boolean)
    .join(' · ')

  return [
    `${opts.header}：${expense.description || expense.category || ''}${opts.titleSuffix ?? ''}`,
    `💰 ${fmt(expense.amount)} ${currency}`,
    ...(meta ? [meta] : []),
    ...(opts.note ? [opts.note] : []),
    '',
    '👛 付款人',
    rows(expense.payer_data),
    '',
    '🧾 分帳明細',
    rows(expense.split_data),
    ...(opts.footer ? ['', opts.footer] : []),
  ].join('\n')
}
