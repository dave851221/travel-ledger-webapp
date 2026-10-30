import Decimal from 'decimal.js';

/**
 * 結清演算法。
 *
 * ⚠️ 這份邏輯在 supabase/functions/_shared/finance.ts 也有一份給 LINE Bot 用。
 *    兩者由 finance.parity.test.ts 強制比對，改一邊就要改另一邊。
 */

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

/**
 * 由每人的淨結餘算出「最少轉帳次數」的結清路徑。
 *
 * 正數代表該成員應收，負數代表應付。
 * 貪婪法：金額最大的債務人優先對上金額最大的債權人。
 * 差距小於 EPSILON（0.01），或依 `precision` 四捨五入後是 0 的，視為已結清，不產生轉帳。
 *
 * `precision` 是結算幣別的小數位數。台幣是 0 位時，手動記了整數的結清後
 * 常剩下 0.3 元的尾差，不傳的話畫面會列出一筆「NT$0」的建議轉帳。
 */
export const calculateSettlements = (
  memberBalances: Record<string, number>,
  precision = 2,
): Settlement[] => {
  const EPSILON = new Decimal('0.01');
  const roundsToZero = (amt: Decimal) => amt.toDecimalPlaces(precision).isZero();
  const debtors: { name: string; amt: Decimal }[] = [];
  const creditors: { name: string; amt: Decimal }[] = [];

  Object.entries(memberBalances).forEach(([name, bal]) => {
    const d = new Decimal(bal);
    if (d.abs().lte(EPSILON) || roundsToZero(d.abs())) return;
    if (d.isNegative()) debtors.push({ name, amt: d.negated() });
    else creditors.push({ name, amt: d });
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
    if (debtors[i].amt.lt(EPSILON) || roundsToZero(debtors[i].amt)) i++;
    if (creditors[j].amt.lt(EPSILON) || roundsToZero(creditors[j].amt)) j++;
  }
  return result;
};
