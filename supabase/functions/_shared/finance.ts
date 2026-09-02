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
