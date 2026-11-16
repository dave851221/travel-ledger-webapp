// ============================================================
// _shared/itemSplit.ts —— 收據逐項拆帳（🧾 逐項分）
//
// ⚠️ 前端 src/utils/itemSplit.ts 有一份同樣的實作（前端走 npm 的 decimal.js，
//    這裡走 deps.ts），itemSplit.parity.test.ts 會用隨機輸入比對兩份。改一邊就要改另一邊。
// ============================================================

import { Decimal } from './deps.ts'

/** 收據上的一個品項。amount 是那一行印的金額（數量 × 單價，折扣已扣掉）。 */
export interface ReceiptItem {
  name: string
  amount: number
}

export interface ItemSplitResult {
  /** { 成員: 應付金額 }，已依精度四捨五入，加總**一定**等於 total */
  split: Record<string, number>
  /** 尾差給了誰（寫進 adjustment_member） */
  adjustment: string
  /** 品項加總（沒算稅）。跟 total 差很多時，多半是品項讀漏了 */
  itemsTotal: number
}

/**
 * 依「每個品項是誰的」算出每個人該付多少。
 *
 * - 一個品項有好幾個人：那幾個人平分。
 * - 沒指定的品項：由 `others` 平分（通常是這張卡原本的分攤名單）。
 * - 稅、服務費、整張收據的折扣：品項加總跟總額不一樣時，依每個人分到的品項金額**按比例**攤，
 *   所以外税 8%、10% 或整單打折都不必另外處理。
 * - 先用不捨入的 Decimal 算到底，最後才依精度四捨五入；尾差給 `preferAdjust`
 *   （通常是付款人）—— 他不在名單裡就給分到最多的人。
 */
export function splitByItems(
  total: number,
  items: ReceiptItem[],
  assignments: string[][],
  others: string[],
  precision: number,
  preferAdjust?: string | null,
): ItemSplitResult {
  const raw = new Map<string, Decimal>()
  const add = (m: string, v: Decimal) => raw.set(m, (raw.get(m) ?? new Decimal(0)).plus(v))

  let itemsTotal = new Decimal(0)
  items.forEach((item, i) => {
    const amt = new Decimal(Number(item.amount) || 0)
    itemsTotal = itemsTotal.plus(amt)
    const owners = [...new Set((assignments[i] ?? []).filter(Boolean))]
    const who = owners.length > 0 ? owners : [...new Set(others.filter(Boolean))]
    if (who.length === 0) return
    const each = amt.div(who.length)
    who.forEach(m => add(m, each))
  })

  const totalDec = new Decimal(Number(total) || 0)
  const members = [...raw.keys()]
  if (members.length === 0) return { split: {}, adjustment: preferAdjust ?? '', itemsTotal: itemsTotal.toNumber() }

  // 稅與整單折扣：依比例放大或縮小。品項加總是 0（全是贈品）時就平分總額。
  const scaled = new Map<string, Decimal>()
  if (itemsTotal.isZero()) {
    members.forEach(m => scaled.set(m, totalDec.div(members.length)))
  } else {
    const factor = totalDec.div(itemsTotal)
    members.forEach(m => scaled.set(m, (raw.get(m) as Decimal).times(factor)))
  }

  const split: Record<string, number> = {}
  let roundedSum = new Decimal(0)
  members.forEach(m => {
    const r = (scaled.get(m) as Decimal).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP)
    split[m] = r.toNumber()
    roundedSum = roundedSum.plus(r)
  })

  const largest = members.reduce((a, b) =>
    (scaled.get(b) as Decimal).greaterThan(scaled.get(a) as Decimal) ? b : a)
  const adjustment = preferAdjust && members.includes(preferAdjust) ? preferAdjust : largest
  const diff = totalDec.minus(roundedSum)
  if (!diff.isZero()) split[adjustment] = new Decimal(split[adjustment]).plus(diff).toNumber()

  return { split, adjustment, itemsTotal: itemsTotal.toNumber() }
}

/**
 * 把 AI 讀到的品項收斂成安全的形狀：名稱是字串、金額是有限數字、最多 40 項。
 * 少於 2 項就沒有「逐項分」的意義，回傳空陣列。
 */
export function sanitizeReceiptItems(value: unknown): ReceiptItem[] {
  if (!Array.isArray(value)) return []
  const out: ReceiptItem[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const name = String(o.name ?? '').trim().slice(0, 40)
    const amount = Number(o.amount)
    // 0 元的（加冰、免費的附餐）點了也沒差，不列出來
    if (!name || !Number.isFinite(amount) || amount === 0) continue
    out.push({ name, amount })
    if (out.length >= 60) break
  }
  return out.length >= 2 ? out : []
}

/** 對不上總額時補上的那一列 */
export const UNREAD_ITEM_NAME = '沒讀到的品項／差額'

/**
 * 品項加總比總額少、而且不像外加消費稅（8%～10%）時，多半是辨識漏了一兩行
 * （例如同一道菜連續點了兩次，被當成同一行）。這時不要把差額按比例攤給每個人
 * —— 那會讓沒點的人也替漏掉的那一項付錢 —— 而是補一列「沒讀到的品項／差額」，
 * 讓使用者自己點是誰的（沒點就跟其他沒指定的一起平分）。
 * 比總額多（折扣）或差額像消費稅時維持原樣，交給 splitByItems 依比例攤。
 */
export function reconcileReceiptItems(items: ReceiptItem[], total: number): ReceiptItem[] {
  if (items.length === 0 || !(total > 0)) return items
  if (items.some(i => i.name === UNREAD_ITEM_NAME)) return items
  const sum = items.reduce((acc, i) => acc.plus(i.amount), new Decimal(0))
  if (!sum.greaterThan(0)) return items
  const diff = new Decimal(total).minus(sum)
  // 尾數差一點點（四捨五入）也照比例攤就好
  if (!diff.greaterThan(new Decimal(total).times(0.005))) return items
  const ratio = new Decimal(total).div(sum)
  // 外税 8%／10%（或兩種混在一起）：差額本來就該照每項金額比例分
  if (ratio.greaterThanOrEqualTo(1.075) && ratio.lessThanOrEqualTo(1.105)) return items
  return [...items, { name: UNREAD_ITEM_NAME, amount: diff.toNumber() }]
}
