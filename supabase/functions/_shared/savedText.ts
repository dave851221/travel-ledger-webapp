// ============================================================
// _shared/savedText.ts —— 「已存入／已修改」回覆的完整明細
//
// LINE 上每一條存檔路徑（卡片的確認存入、👤 只算我、✏️ 確認修改，
// 以及 LIFF 存檔後 liff-notify 的推播）都用這一份，存完看到的內容才會一致：
// 標題、金額、日期與分類、付款人、每個人分到多少，有收據品項時再列品項
// （知道每個品項是誰的就直接寫在那個人後面）。
//
// 純函式：只 import finance.ts，vitest 能直接測。
// ============================================================

import { formatAmount } from './finance.ts'
import type { ReceiptItem } from './itemSplit.ts'

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
  /** 收據品項（🧾 逐項分讀到的） */
  items?: ReceiptItem[] | null
  /** 每個品項是誰的（與 items 同長度）。對得上分帳名單時寫在每個人後面 */
  itemOwners?: string[][] | null
  /** 最後一行，例如「（由 代杰 記錄）」 */
  footer?: string
}

/** 品項太多時只列前面幾項，免得一則訊息拉到看不完 */
export const MAX_LISTED_ITEMS = 15

/** itemOwners 能不能信：長度對得上、每項都有人、而且每個人都在這筆的分帳名單裡 */
function usableOwners(items: ReceiptItem[], owners: string[][] | null | undefined, splitMembers: string[]): boolean {
  if (!owners || owners.length !== items.length) return false
  return owners.every((list) =>
    Array.isArray(list) && list.length > 0 && list.every((m) => splitMembers.includes(m)))
}

export function buildSavedText(
  expense: SavedExpense,
  opts: SavedTextOptions,
  precisionConfig: Record<string, number> = {},
): string {
  const currency = expense.currency
  const fmt = (v: number | string) => formatAmount(Number(v) || 0, currency, precisionConfig)
  const nonZero = (data: Record<string, number | string> | null | undefined) =>
    Object.entries(data ?? {}).filter(([, v]) => Number(v) !== 0)

  const items = (opts.items ?? []).filter((i) => i && String(i.name ?? '').trim())
  const splitEntries = nonZero(expense.split_data)
  const owners = items.length > 0 && usableOwners(items, opts.itemOwners, splitEntries.map(([m]) => m))
    ? opts.itemOwners as string[][]
    : null

  const rows = (entries: [string, number | string][], withItems = false) => {
    if (entries.length === 0) return '• （無）'
    return entries.map(([name, v]) => {
      const mine = withItems && owners
        ? items.filter((_, i) => owners[i].includes(name)).map((i) => i.name)
        : []
      return `• ${name} ${fmt(v)}${mine.length > 0 ? `（${mine.join('、')}）` : ''}`
    }).join('\n')
  }

  const meta = [expense.date ? `📅 ${expense.date}` : '', expense.category ? `🏷️ ${expense.category}` : '']
    .filter(Boolean)
    .join(' · ')

  // 品項是誰的已經寫在分帳明細裡，就不必再列一次
  const itemLines: string[] = []
  if (items.length > 0 && !owners) {
    itemLines.push('', '🛒 品項')
    for (const item of items.slice(0, MAX_LISTED_ITEMS)) itemLines.push(`• ${item.name} ${fmt(item.amount)}`)
    if (items.length > MAX_LISTED_ITEMS) itemLines.push(`…另外 ${items.length - MAX_LISTED_ITEMS} 項`)
  }

  return [
    `${opts.header}：${expense.description || expense.category || ''}${opts.titleSuffix ?? ''}`,
    `💰 ${fmt(expense.amount)} ${currency}`,
    ...(meta ? [meta] : []),
    ...(opts.note ? [opts.note] : []),
    '',
    '👛 付款人',
    rows(nonZero(expense.payer_data)),
    '',
    '🧾 分帳明細',
    rows(splitEntries, true),
    ...itemLines,
    ...(opts.footer ? ['', opts.footer] : []),
  ].join('\n')
}

/** 收進來的 itemOwners（pending 列、LIFF 帶來的）收斂成 string[][]，形狀不對就當作沒有 */
export function sanitizeItemOwners(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((list) => Array.isArray(list) ? list.map((m) => String(m ?? '')).filter(Boolean) : [])
  return out.length > 0 ? out : undefined
}
