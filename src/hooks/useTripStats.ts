import { useMemo } from 'react';
import type { Trip, Expense } from '../types';
import { calculateMemberBalances, getRate } from '../utils/finance';

export interface CurrencyTotals {
  total: number;
  paidByMe: number;
  owedByMe: number;
}

export interface MemberDetail {
  totalOwed: number;
  categories: Record<string, number>;
}

export interface TripStats {
  /** 各幣別的原幣金額，不做換算 */
  byCurrency: Record<string, CurrencyTotals>;
  /** 全部折算回主幣別後的總計 */
  grandBase: CurrencyTotals;
  /** 圓餅圖用，已依金額由大到小排序 */
  categoryData: { name: string; value: number }[];
  memberDetails: Record<string, MemberDetail>;
  /**
   * 每人的淨結餘（付款 - 分攤）。
   * key 是幣別，另有一個 'GRAND_TOTAL' 是全部折算回主幣別的版本。
   */
  balances: Record<string, Record<string, number>>;
  /**
   * 有支出用了旅程未設定匯率的幣別，會被當成 1:1 換算，需提醒使用者。
   * 主幣別不會出現在這裡 —— 它對自己的匯率依定義就是 1（情境 D9）。
   */
  missingRateCurrencies: string[];
}

const EMPTY_STATS: TripStats = {
  byCurrency: {},
  grandBase: { total: 0, paidByMe: 0, owedByMe: 0 },
  categoryData: [],
  memberDetails: {},
  balances: { GRAND_TOTAL: {} },
  missingRateCurrencies: [],
};

/**
 * 由支出明細算出統計與結餘。
 *
 * 兩條重要規則：
 *   - 「結清紀錄」(is_settlement) 不計入總支出與分類統計，否則結清會被當成消費
 *   - 但結清紀錄**要**計入結餘，否則結清完帳還是掛在那裡
 */
export const useTripStats = (
  expenses: Expense[],
  trip: Trip | null,
  currentUser: string | null,
): TripStats => useMemo(() => {
  if (!trip) return EMPTY_STATS;

  const byCurrency: Record<string, CurrencyTotals> = {};
  const grandBase: CurrencyTotals = { total: 0, paidByMe: 0, owedByMe: 0 };
  const categoryMap: Record<string, number> = {};
  const memberDetails: Record<string, MemberDetail> = {};

  trip.members.forEach((m) => {
    memberDetails[m] = { totalOwed: 0, categories: {} };
  });

  // 餘額與匯率換算走共用實作（M14）。
  // ⚠️ 以前這裡自己寫 `rates[e.currency] || 1`，Edge Function 寫
  //    `e.currency === base ? 1 : rates[...]` —— rates[base] 不等於 1 時
  //    網頁與機器人會算出不同的結算結果（ROADMAP 舊「已知風險 5」）。
  //    現在兩邊都呼叫 calculateMemberBalances，且由契約測試看守。
  //    結清紀錄要一起傳進去：不然結清完帳面上還是欠著。
  const balanceSummary = calculateMemberBalances(
    expenses, trip.members, trip.rates, trip.base_currency,
  );

  expenses.forEach((e) => {
    const rate = getRate(e.currency, trip.rates, trip.base_currency);
    const amountInBase = (Number(e.amount) || 0) * rate;

    if (!byCurrency[e.currency]) {
      byCurrency[e.currency] = { total: 0, paidByMe: 0, owedByMe: 0 };
    }

    const pMe = currentUser ? (Number(e.payer_data[currentUser]) || 0) : 0;
    const oMe = currentUser ? (Number(e.split_data[currentUser]) || 0) : 0;

    // 只有「非結清」紀錄才計入總支出與分類統計
    if (!e.is_settlement) {
      byCurrency[e.currency].total += Number(e.amount) || 0;
      byCurrency[e.currency].paidByMe += pMe;
      byCurrency[e.currency].owedByMe += oMe;
      grandBase.total += amountInBase;
      grandBase.paidByMe += pMe * rate;
      grandBase.owedByMe += oMe * rate;
      categoryMap[e.category] = (categoryMap[e.category] || 0) + amountInBase;

      trip.members.forEach((m) => {
        const owed = Number(e.split_data[m]) || 0;
        const owedInBase = owed * rate;
        memberDetails[m].totalOwed += owedInBase;
        memberDetails[m].categories[e.category] =
          (memberDetails[m].categories[e.category] || 0) + owedInBase;
      });
    }
  });

  const categoryData = Object.entries(categoryMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  return {
    byCurrency,
    grandBase,
    categoryData,
    memberDetails,
    balances: { GRAND_TOTAL: balanceSummary.grandTotal, ...balanceSummary.byCurrency },
    missingRateCurrencies: balanceSummary.missingRateCurrencies,
  };
}, [expenses, trip, currentUser]);
