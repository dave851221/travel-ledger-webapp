// ============================================================
// summary-cards.ts —— 快捷查詢的 Flex 卡片
//
// 今日支出、近 7 天、本月支出、結算、旅程總覽。以前是純文字，
// LINE 的字型不等寬，「品名  金額  [分類]」在手機上一長就斷行、金額對不齊。
// 改成卡片：品名靠左、金額靠右，依日期分段，合計放在底部。
//
// 只是排版，金額的捨入仍然走 formatAmount（Decimal、依旅程精度）。
// ============================================================

import { formatAmount } from "../_shared/finance.ts"
import type { OutgoingMessage } from "./types.ts"

/** 與網頁 src/utils/money.ts 的 SYMBOLS 一致 —— 網頁與 LINE 看到的金額寫法才會相同 */
const SYMBOLS: Record<string, string> = {
  TWD: 'NT$', JPY: '¥', CNY: 'CN¥', USD: 'US$', EUR: '€', GBP: '£',
  KRW: '₩', HKD: 'HK$', THB: '฿', SGD: 'S$', AUD: 'A$', VND: '₫',
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const INK = '#1f2937'
const MUTED = '#8a94a6'
const ACCENT = '#14213d'
const WARN = '#E08A00'

/** "NT$12,345"、"¥4,800"。在 formatAmount 的字串上加千分位，不碰浮點數 */
export function formatMoney(amount: number, currency: string, precision: Record<string, number>): string {
  const plain = formatAmount(amount, currency, precision)
  const negative = plain.startsWith('-') && /[1-9]/.test(plain)
  const [int, frac] = plain.replace(/^-/, '').split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '−' : ''}${SYMBOLS[currency] ?? `${currency} `}${grouped}${frac !== undefined ? `.${frac}` : ''}`
}

/** "11/16（一）" */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const md = `${Number(date.substring(5, 7))}/${Number(date.substring(8, 10))}`
  return Number.isNaN(d.getTime()) ? date : `${md}（${WEEKDAYS[d.getUTCDay()]}）`
}

export interface SummaryRow {
  label: string
  /** 第二行的小字（分類） */
  sub?: string
  value: string
}

export interface SummarySection {
  heading?: string
  rows: SummaryRow[]
}

export interface SummaryCardOptions {
  title: string
  subtitle?: string
  sections: SummarySection[]
  /** 底部的合計列，例如「共 3 筆」｜「¥13,020」 */
  totals?: SummaryRow[]
  /** 底部的提醒（匯率沒設、還有幾筆沒列出來） */
  notes?: string[]
  webUrl?: string
  altText: string
}

const row = (r: SummaryRow, size = 'sm', bold = false) => ({
  type: 'box',
  layout: 'horizontal',
  spacing: 'md',
  contents: [
    {
      type: 'box', layout: 'vertical', flex: 1,
      // Flex 的 text 不能是空字串（整則訊息會被拒），沒有標籤時放 filler
      contents: r.label
        ? [
          { type: 'text', text: r.label, size, color: INK, wrap: true, ...(bold ? { weight: 'bold' } : {}) },
          ...(r.sub ? [{ type: 'text', text: r.sub, size: 'xxs', color: MUTED }] : []),
        ]
        : [{ type: 'filler' }],
    },
    { type: 'text', text: r.value, size, color: INK, align: 'end', flex: 0, gravity: 'top', ...(bold ? { weight: 'bold' } : {}) },
  ],
})

export function buildSummaryCard(opts: SummaryCardOptions): OutgoingMessage {
  const body = opts.sections.flatMap((section, i) => [
    ...(section.heading
      ? [{ type: 'text', text: section.heading, size: 'xs', weight: 'bold', color: MUTED, margin: i === 0 ? 'none' : 'lg' }]
      : []),
    ...section.rows.map((r) => ({ ...row(r), margin: 'sm' })),
  ])
  const footer = [
    ...(opts.totals?.length
      ? [{ type: 'separator' }, ...opts.totals.map((t, i) => ({ ...row(t, 'sm', true), margin: i === 0 ? 'md' : 'xs' }))]
      : []),
    ...(opts.notes ?? []).map((n) => ({ type: 'text', text: n, size: 'xxs', color: WARN, wrap: true, margin: 'md' })),
    ...(opts.webUrl
      ? [{ type: 'button', style: 'link', height: 'sm', margin: 'md', action: { type: 'uri', label: '🌐 在網頁查看', uri: opts.webUrl } }]
      : []),
  ]
  return {
    type: 'flex',
    altText: opts.altText,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical', paddingBottom: 'sm',
        contents: [
          { type: 'text', text: opts.title, weight: 'bold', size: 'md', color: ACCENT, wrap: true },
          ...(opts.subtitle ? [{ type: 'text', text: opts.subtitle, size: 'xs', color: MUTED, margin: 'xs', wrap: true }] : []),
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingTop: 'none',
        contents: body.length > 0 ? body : [{ type: 'text', text: '（沒有資料）', size: 'sm', color: MUTED }],
      },
      ...(footer.length > 0 ? { footer: { type: 'box', layout: 'vertical', paddingTop: 'none', contents: footer } } : {}),
    },
  }
}

interface ExpenseLike { description: string; amount: number; currency: string; category?: string; date?: string }

/**
 * 支出清單（今日／近 7 天／本月）。有 date 的依日期分段；超過 maxRows 只列前面那些，
 * 合計仍然用全部的列算（呼叫端傳進來的 totals）。
 */
export function expenseSections(
  rows: ExpenseLike[],
  precision: Record<string, number>,
  opts: { groupByDate: boolean; showCategory: boolean; maxRows: number },
): { sections: SummarySection[]; omitted: number } {
  const listed = rows.slice(0, opts.maxRows)
  const toRow = (e: ExpenseLike): SummaryRow => ({
    label: e.description || '（未命名）',
    sub: opts.showCategory ? e.category : undefined,
    value: formatMoney(e.amount, e.currency, precision),
  })
  if (!opts.groupByDate) return { sections: [{ rows: listed.map(toRow) }], omitted: rows.length - listed.length }
  const byDate = new Map<string, ExpenseLike[]>()
  for (const e of listed) {
    const key = e.date ?? ''
    byDate.set(key, [...(byDate.get(key) ?? []), e])
  }
  return {
    sections: [...byDate.entries()].map(([date, list]) => ({ heading: shortDate(date), rows: list.map(toRow) })),
    omitted: rows.length - listed.length,
  }
}

/** 各幣別合計 → 合計列。第一列左邊寫「共 N 筆」 */
export function totalRows(totals: Record<string, { toNumber(): number }>, count: number, precision: Record<string, number>): SummaryRow[] {
  const entries = Object.entries(totals)
  if (entries.length === 0) return [{ label: `共 ${count} 筆`, value: '—' }]
  return entries.map(([currency, total], i) => ({
    label: i === 0 ? `共 ${count} 筆` : '',
    value: formatMoney(total.toNumber(), currency, precision),
  }))
}
