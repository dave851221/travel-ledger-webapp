import Decimal from 'decimal.js';
import Papa from 'papaparse';
import type { Expense } from '../types';
import { getLocalDateString } from './date';

/**
 * High-precision financial utilities using decimal.js
 */

export const toDecimal = (val: number | string) => new Decimal(val || 0);

/**
 * Formats a number based on currency precision
 */
const DEFAULT_CURRENCY_PRECISION: Record<string, number> = { TWD: 0, JPY: 0, KRW: 0 };

/**
 * 某個幣別要用幾位小數。
 *
 * 優先序：旅程的 precision_config → 內建預設（TWD/JPY/KRW 為 0 位）→ 2 位。
 * 所有需要判斷精度的地方都該走這裡，不要各自寫 fallback。
 */
export const getCurrencyPrecision = (
  currency: string,
  precisionConfig: Record<string, number> = {}
): number => precisionConfig[currency] ?? DEFAULT_CURRENCY_PRECISION[currency] ?? 2;

export const formatAmount = (amount: number, currency: string, precisionConfig: Record<string, number> = {}) => {
  return new Decimal(amount).toFixed(getCurrencyPrecision(currency, precisionConfig));
};

/**
 * 依幣別加總一批支出。
 *
 * 一律走 Decimal —— 原生 `+=` 在 USD 旅程會累出 `0.30000000000000004` 這種尾數。
 *
 * ⚠️ Edge Function 的 supabase/functions/_shared/finance.ts 有完全對應的一份，
 *    由契約測試比對（M14）。
 */
export function sumByCurrency(
  rows: { amount: number | string; currency: string }[],
): Record<string, Decimal> {
  const totals: Record<string, Decimal> = {};
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
): Decimal {
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
  const grand: Record<string, Decimal> = {};
  const byCurrency: Record<string, Record<string, Decimal>> = {};
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
 * Distributes a total amount among members, handling remainders fairly.
 */
export const calculateDistribution = (
  total: number,
  activeMembers: string[],
  lockedData: Record<string, number> = {},
  adjustmentMember: string | null = null,
  precision: number = 2
): Record<string, number> => {
  const result: Record<string, Decimal> = {};
  if (activeMembers.length === 0) return {};

  const dTotal = new Decimal(total || 0);
  let remainingAmount = dTotal;
  
  const unlockedActiveMembers = activeMembers.filter(m => {
    if (lockedData[m] !== undefined) {
      const lockedVal = new Decimal(lockedData[m]);
      result[m] = lockedVal;
      remainingAmount = remainingAmount.minus(lockedVal);
      return false;
    }
    return true;
  });

  if (unlockedActiveMembers.length > 0) {
    const share = remainingAmount.dividedBy(unlockedActiveMembers.length).toDecimalPlaces(precision, Decimal.ROUND_DOWN);
    unlockedActiveMembers.forEach(m => {
      result[m] = share;
      remainingAmount = remainingAmount.minus(share);
    });

    if (!remainingAmount.isZero()) {
      const target = (adjustmentMember && unlockedActiveMembers.includes(adjustmentMember))
        ? adjustmentMember
        : unlockedActiveMembers[0];
      result[target] = result[target].plus(remainingAmount);
    }
  } else if (!remainingAmount.isZero()) {
    // 全部成員皆已鎖定但加總不等於總金額時，餘數強制加給調整成員
    const target = (adjustmentMember && activeMembers.includes(adjustmentMember))
      ? adjustmentMember
      : activeMembers[0];
    result[target] = result[target] ? result[target].plus(remainingAmount) : remainingAmount;
  }

  const finalResult: Record<string, number> = {};
  Object.keys(result).forEach(m => {
    finalResult[m] = result[m].toNumber();
  });
  return finalResult;
};

/**
 * Exports expense data to CSV format
 */
export const exportExpensesToCSV = (expenses: Expense[], tripName: string) => {
  const csvData = expenses.map(e => ({
    '日期': e.date,
    '類別': e.category,
    '描述': e.description,
    '金額': e.amount,
    '幣別': e.currency,
    '付款明細': JSON.stringify(e.payer_data),
    '分攤明細': JSON.stringify(e.split_data),
    '備註': e.is_settlement ? '結清紀錄' : '',
    '建立時間': new Date(e.created_at).toLocaleString()
  }));

  const csv = Papa.unparse(csvData);
  const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  
  link.setAttribute("href", url);
  link.setAttribute("download", `旅遊支出備份_${tripName}_${getLocalDateString()}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
