// 財務計算 —— Edge Function 版本
//
// ⚠️ 這份必須與 src/utils/finance.ts 及 src/utils/settlement.ts 的邏輯完全一致。
//    兩者由 src/utils/finance.parity.test.ts 的契約測試強制比對，
//    改動任何一邊而沒有同步另一邊，測試就會失敗。
//
// 之所以無法直接共用同一個檔案：前端走 npm 的 decimal.js，
// Edge Function 走 esm.sh 的 URL import，模組解析方式不同。
// deps.ts 這層間接讓測試得以同時載入兩份實作互相比對。

import { Decimal } from './deps.ts';

export const DEFAULT_PRECISION: Record<string, number> = { TWD: 0, JPY: 0, KRW: 0 };

/** 依幣別精度格式化金額。務必用這個而不是直接 toFixed()。 */
export function formatAmount(
  amount: number,
  currency: string,
  precisionConfig: Record<string, number> = {},
): string {
  const precision = precisionConfig[currency] ?? DEFAULT_PRECISION[currency] ?? 2;
  return new Decimal(amount).toFixed(precision);
}

/**
 * 依幣別加總一批支出。
 *
 * 快捷查詢（今日／本月／旅程總覽）以前是用原生的 `totals[c] += e.amount` 累加，
 * USD 旅程的合計會出現 `0.30000000000000004` 這種尾數 ——
 * 違反 CLAUDE.md「金額運算一律走 decimal.js」。
 *
 * ⚠️ 前端 src/utils/finance.ts 有完全對應的一份，由契約測試比對（M14）。
 */
export function sumByCurrency(
  rows: { amount: number | string; currency: string }[],
): Record<string, InstanceType<typeof Decimal>> {
  const totals: Record<string, InstanceType<typeof Decimal>> = {};
  for (const row of rows ?? []) {
    const currency = row?.currency;
    if (!currency) continue;
    const amount = new Decimal(row.amount || 0);
    totals[currency] = totals[currency] ? totals[currency].plus(amount) : amount;
  }
  return totals;
}

/**
 * 某個幣別要折算成主幣別時該乘的匯率。
 *
 * ⚠️ **主幣別一律是 1**，不管 `rates` 裡寫了什麼。
 *    幣別對自己的匯率就是 1，這是定義，不是設定值。
 *
 * 這一條規則正是 ROADMAP「已知風險 5」／M14 的核心：
 * 以前 Edge Function 寫成 `e.currency === base ? 1 : rates[...]`，
 * 前端寫成 `rates[...] || 1` —— 只要 `rates[base]` 不等於 1（舊資料或手動改壞），
 * 網頁與機器人就會算出**不同的結算結果**，而且兩邊看起來都很合理。
 *
 * 沒有設定匯率的幣別退回 1（等於不換算）並由呼叫端回報給使用者 ——
 * 直接當 0 會讓那筆支出從結算裡消失，比 1:1 失真更糟。
 */
export function getRate(
  currency: string,
  rates: Record<string, number> | null | undefined,
  baseCurrency: string,
): number {
  if (currency === baseCurrency) return 1;
  const rate = (rates ?? {})[currency];
  return typeof rate === 'number' && isFinite(rate) ? rate : 1;
}

/** 把某幣別的金額折算成主幣別。回傳 Decimal，呼叫端自行決定何時 toNumber()。 */
export function convertToBase(
  amount: number | string,
  currency: string,
  rates: Record<string, number> | null | undefined,
  baseCurrency: string,
): InstanceType<typeof Decimal> {
  return new Decimal(amount || 0).times(getRate(currency, rates, baseCurrency));
}

/** 算餘額只需要這幾個欄位；`amount` 用不到，因為餘額只看付款與分攤。 */
export interface BalanceRow {
  currency: string;
  payer_data?: Record<string, unknown> | null;
  split_data?: Record<string, unknown> | null;
}

export interface BalanceSummary {
  /** 每人折合主幣別後的淨結餘。正數＝應收，負數＝應付。 */
  grandTotal: Record<string, number>;
  /** 每人在各幣別的原幣淨結餘，`{ 幣別: { 成員: 金額 } }` */
  byCurrency: Record<string, Record<string, number>>;
  /** 有支出用到、但旅程 rates 沒設定的幣別（已被當成 1:1，需提醒使用者） */
  missingRateCurrencies: string[];
}

/**
 * 每人的淨結餘（付款 − 分攤），全程走 Decimal。
 *
 * ⚠️ **結清紀錄（is_settlement）要一起傳進來**：結清就是「誰把錢還給誰」，
 *    不計入的話結清完帳面上還是欠著。呼叫端不要先濾掉。
 *    （反過來說，「總支出」「分類統計」則必須排除結清紀錄 —— 那是另一回事。）
 *
 * 只統計 `members` 清單裡的人。已被移除的成員留在舊支出的 JSONB 裡，
 * 把他們算進來會多出永遠結不掉的餘額。
 */
export function calculateMemberBalances(
  rows: BalanceRow[],
  members: string[],
  rates: Record<string, number> | null | undefined,
  baseCurrency: string,
): BalanceSummary {
  const memberList = members ?? [];
  const grand: Record<string, InstanceType<typeof Decimal>> = {};
  const byCurrency: Record<string, Record<string, InstanceType<typeof Decimal>>> = {};
  const missing = new Set<string>();

  memberList.forEach((m) => { grand[m] = new Decimal(0); });

  for (const row of rows ?? []) {
    const currency = row?.currency;
    if (!currency) continue;

    // 主幣別不算「沒設匯率」—— 它的匯率是定義出來的 1（情境 D9）
    if (currency !== baseCurrency && (rates ?? {})[currency] === undefined) {
      missing.add(currency);
    }
    const rate = getRate(currency, rates, baseCurrency);

    if (!byCurrency[currency]) {
      byCurrency[currency] = {};
      memberList.forEach((m) => { byCurrency[currency][m] = new Decimal(0); });
    }

    for (const m of memberList) {
      const paid = new Decimal(Number(row.payer_data?.[m]) || 0);
      const owed = new Decimal(Number(row.split_data?.[m]) || 0);
      const net = paid.minus(owed);
      byCurrency[currency][m] = byCurrency[currency][m].plus(net);
      grand[m] = grand[m].plus(net.times(rate));
    }
  }

  const grandTotal: Record<string, number> = {};
  Object.keys(grand).forEach((m) => { grandTotal[m] = grand[m].toNumber(); });

  const byCurrencyNum: Record<string, Record<string, number>> = {};
  Object.keys(byCurrency).forEach((c) => {
    byCurrencyNum[c] = {};
    Object.keys(byCurrency[c]).forEach((m) => {
      byCurrencyNum[c][m] = byCurrency[c][m].toNumber();
    });
  });

  return {
    grandTotal,
    byCurrency: byCurrencyNum,
    missingRateCurrencies: Array.from(missing),
  };
}

/**
 * 把總額分配給成員，並公平處理除不盡的餘數。
 *
 * - lockedData 裡的成員金額固定不動，只有其餘成員參與均分
 * - 均分採 ROUND_DOWN，剩下的餘數整筆給 adjustmentMember
 *   （若他不在可分配名單中，則給第一位）
 * - 保證 Σ(結果) === total
 */
export function calculateDistribution(
  total: number,
  activeMembers: string[],
  lockedData: Record<string, number> = {},
  adjustmentMember: string | null = null,
  precision: number = 2,
): Record<string, number> {
  const result: Record<string, InstanceType<typeof Decimal>> = {};
  if (activeMembers.length === 0) return {};

  let remainingAmount = new Decimal(total || 0);

  const unlockedActiveMembers = activeMembers.filter((m) => {
    if (lockedData[m] !== undefined) {
      const lockedVal = new Decimal(lockedData[m]);
      result[m] = lockedVal;
      remainingAmount = remainingAmount.minus(lockedVal);
      return false;
    }
    return true;
  });

  if (unlockedActiveMembers.length > 0) {
    const share = remainingAmount
      .dividedBy(unlockedActiveMembers.length)
      .toDecimalPlaces(precision, Decimal.ROUND_DOWN);
    unlockedActiveMembers.forEach((m) => {
      result[m] = share;
      remainingAmount = remainingAmount.minus(share);
    });

    if (!remainingAmount.isZero()) {
      const target = adjustmentMember && unlockedActiveMembers.includes(adjustmentMember)
        ? adjustmentMember
        : unlockedActiveMembers[0];
      result[target] = result[target].plus(remainingAmount);
    }
  } else if (!remainingAmount.isZero()) {
    // 全部成員皆已鎖定但加總不等於總額時，餘數強制加給調整成員
    const target = adjustmentMember && activeMembers.includes(adjustmentMember)
      ? adjustmentMember
      : activeMembers[0];
    result[target] = result[target] ? result[target].plus(remainingAmount) : remainingAmount;
  }

  const finalResult: Record<string, number> = {};
  Object.keys(result).forEach((m) => {
    finalResult[m] = result[m].toNumber();
  });
  return finalResult;
}

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

/**
 * 由每人的淨結餘算出「最少轉帳次數」的結清路徑。
 * 正數代表該成員應收，負數代表應付。差距小於 EPSILON 者視為已結清。
 */
export function calculateSettlements(
  memberBalances: Record<string, number>,
): Settlement[] {
  const EPSILON = new Decimal('0.01');
  const debtors: { name: string; amt: InstanceType<typeof Decimal> }[] = [];
  const creditors: { name: string; amt: InstanceType<typeof Decimal> }[] = [];

  Object.entries(memberBalances).forEach(([name, bal]) => {
    const d = new Decimal(bal);
    if (d.lt(EPSILON.negated())) debtors.push({ name, amt: d.negated() });
    else if (d.gt(EPSILON)) creditors.push({ name, amt: d });
  });

  debtors.sort((a, b) => b.amt.comparedTo(a.amt));
  creditors.sort((a, b) => b.amt.comparedTo(a.amt));

  const result: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const minAmt = Decimal.min(debtors[i].amt, creditors[j].amt);
    result.push({ from: debtors[i].name, to: creditors[j].name, amount: minAmt.toNumber() });
    debtors[i].amt = debtors[i].amt.minus(minAmt);
    creditors[j].amt = creditors[j].amt.minus(minAmt);
    if (debtors[i].amt.lt(EPSILON)) i++;
    if (creditors[j].amt.lt(EPSILON)) j++;
  }
  return result;
}
