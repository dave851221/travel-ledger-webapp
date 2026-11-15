// ============================================================
// src/utils/itemSplit.ts —— 收據逐項拆帳（🧾 逐項分）
//
// ⚠️ LINE Bot 的 supabase/functions/_shared/itemSplit.ts 有一份同樣的實作（那邊走 deps.ts，
//    這裡走 npm 的 decimal.js），itemSplit.parity.test.ts 會用隨機輸入比對兩份。改一邊就要改另一邊。
// ============================================================

import Decimal from 'decimal.js'

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
    if (!name || !Number.isFinite(amount)) continue
    out.push({ name, amount })
    if (out.length >= 40) break
  }
  return out.length >= 2 ? out : []
}
