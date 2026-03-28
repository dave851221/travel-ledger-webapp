import Decimal from 'decimal.js';
import Papa from 'papaparse';

/**
 * High-precision financial utilities using decimal.js
 */

export const toDecimal = (val: number | string) => new Decimal(val || 0);

/**
 * Formats a number based on currency precision
 */
export const formatAmount = (amount: number, currency: string, precisionConfig: Record<string, number> = {}) => {
  const precision = precisionConfig[currency] ?? (currency === 'TWD' ? 0 : 2);
  return new Decimal(amount).toFixed(precision);
};

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
export const exportExpensesToCSV = (expenses: any[], tripName: string) => {
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
  link.setAttribute("download", `旅遊支出備份_${tripName}_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
