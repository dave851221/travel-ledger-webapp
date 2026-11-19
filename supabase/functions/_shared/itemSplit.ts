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
  /** 收據印的數量（×5）。只有 ≥2 才會出現；可以按份數分給不同人 */
  qty?: number
}

/** 一個品項按份數分：{ 成員: 拿了幾份 }。沒人拿的份數由 others 平分 */
export type ItemUnits = Record<string, number>

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
 * - 有 `units[i]`（按份數分，例如 ×5 的啤酒 2 瓶給 A、3 瓶給 B）：依份數比例分；
 *   份數加起來比 qty 少，剩下的份數由 `others` 平分。units 有值時優先於 assignments。
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
  units?: (ItemUnits | null | undefined)[],
): ItemSplitResult {
  const raw = new Map<string, Decimal>()
  const add = (m: string, v: Decimal) => raw.set(m, (raw.get(m) ?? new Decimal(0)).plus(v))

  let itemsTotal = new Decimal(0)
  items.forEach((item, i) => {
    const amt = new Decimal(Number(item.amount) || 0)
    itemsTotal = itemsTotal.plus(amt)
    const u = cleanUnits(units?.[i])
    if (u) {
      const taken = Object.values(u).reduce((a, b) => a + b, 0)
      const qty = Math.max(taken, Math.floor(Number(item.qty) || 0))
      Object.entries(u).forEach(([m, n]) => add(m, amt.times(n).div(qty)))
      const pool = [...new Set(others.filter(Boolean))]
      if (qty > taken && pool.length > 0) {
        const each = amt.times(qty - taken).div(qty).div(pool.length)
        pool.forEach(m => add(m, each))
      }
      return
    }
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

/** 只留正整數份數；全是 0 就當沒按份數分 */
function cleanUnits(u: ItemUnits | null | undefined): ItemUnits | null {
  if (!u || typeof u !== 'object') return null
  const out: ItemUnits = {}
  for (const [m, v] of Object.entries(u)) {
    const n = Math.floor(Number(v))
    if (m && Number.isFinite(n) && n > 0) out[m] = n
  }
  return Object.keys(out).length > 0 ? out : null
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
    // 數量只收 2～999 的整數；1 或讀不到就不帶，維持舊的形狀
    const qty = Math.floor(Number(o.qty))
    out.push(Number.isFinite(qty) && qty >= 2 && qty <= 999 ? { name, amount, qty } : { name, amount })
    if (out.length >= 60) break
  }
  return out.length >= 2 ? out : []
}

/** 對不上總額時補上的那一列 */
export const UNREAD_ITEM_NAME = '沒讀到的品項／差額'

/**
 * 讓品項對得上收據，差額才不會被算到錯的人頭上。
 *
 * - 有收據印的**品項小計**（外税＝稅前小計；內含稅＝合計）時以它為準：
 *   品項加起來比小計少，就是辨識漏了一兩行（例如同一道菜連點兩次被當成一行）→ 補一列「沒讀到的品項／差額」讓人指派；
 *   小計與總額之間的差（消費稅、服務費）一律交給 splitByItems 依每個人點的金額比例攤。
 * - 沒有小計時退回猜測：差額像外加消費稅（8%～10%）或尾數就照比例攤，其餘補一列差額。
 * 比總額多（折扣）時維持原樣，交給 splitByItems 依比例攤。
 */
export function reconcileReceiptItems(items: ReceiptItem[], total: number, subtotal?: number | null): ReceiptItem[] {
  if (items.length === 0 || !(total > 0)) return items
  if (items.some(i => i.name === UNREAD_ITEM_NAME)) return items
  const sum = items.reduce((acc, i) => acc.plus(i.amount), new Decimal(0))
  if (!sum.greaterThan(0)) return items
  const st = Number(subtotal)
  if (Number.isFinite(st) && st > 0 && st <= total * 1.001) {
    const missing = new Decimal(st).minus(sum)
    // 小計本身的尾數差一點點就算了
    if (!missing.greaterThan(new Decimal(st).times(0.005))) return items
    return [...items, { name: UNREAD_ITEM_NAME, amount: missing.toNumber() }]
  }
  const diff = new Decimal(total).minus(sum)
  // 尾數差一點點（四捨五入）也照比例攤就好
  if (!diff.greaterThan(new Decimal(total).times(0.005))) return items
  const ratio = new Decimal(total).div(sum)
  // 外税 8%／10%（或兩種混在一起）：差額本來就該照每項金額比例分
  if (ratio.greaterThanOrEqualTo(1.075) && ratio.lessThanOrEqualTo(1.105)) return items
  return [...items, { name: UNREAD_ITEM_NAME, amount: diff.toNumber() }]
}
