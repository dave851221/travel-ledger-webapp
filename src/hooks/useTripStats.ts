import { useMemo } from 'react';
import type { Trip, Expense } from '../types';

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
  /** 有支出用了旅程未設定匯率的幣別，會被當成 1:1 換算，需提醒使用者 */
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
  const balances: Record<string, Record<string, number>> = { GRAND_TOTAL: {} };
  const missingRateCurrencies = new Set<string>();

  trip.members.forEach((m) => {
    memberDetails[m] = { totalOwed: 0, categories: {} };
    balances.GRAND_TOTAL[m] = 0;
  });

  expenses.forEach((e) => {
    if (trip.rates[e.currency] === undefined) missingRateCurrencies.add(e.currency);
    const rate = trip.rates[e.currency] || 1;
    const amountInBase = e.amount * rate;

    if (!byCurrency[e.currency]) {
      byCurrency[e.currency] = { total: 0, paidByMe: 0, owedByMe: 0 };
      balances[e.currency] = {};
      trip.members.forEach((m) => { balances[e.currency][m] = 0; });
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

    // 所有紀錄（含結清）都要計入結餘，用來算出誰該給誰多少錢
    trip.members.forEach((m) => {
      const paid = Number(e.payer_data[m]) || 0;
      const owed = Number(e.split_data[m]) || 0;
      balances[e.currency][m] += paid - owed;
      balances.GRAND_TOTAL[m] += (paid - owed) * rate;
    });
  });

  const categoryData = Object.entries(categoryMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  return {
    byCurrency,
    grandBase,
    categoryData,
    memberDetails,
    balances,
    missingRateCurrencies: Array.from(missingRateCurrencies),
  };
}, [expenses, trip, currentUser]);
