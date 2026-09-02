import type { Trip } from '../types';
import { calculateDistribution, getCurrencyPrecision } from './finance';
import { getLocalDateString } from './date';

export interface QuickAddDraft {
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: string;
  payer_data: Record<string, number>;
  split_data: Record<string, number>;
  adjustment_member: string | null;
}

/**
 * 從一行文字裡把金額拆出來。
 *
 * 取「最後一個」獨立的數字當金額，其餘當描述 ——
 * 因為中文習慣是「拉麵 3000」而不是「3000 拉麵」，而描述本身也可能含數字
 * （「7-11 咖啡 55」的金額是 55 而不是 7 或 11）。
 *
 * 支援千分位逗號與小數點；找不到數字時回傳 null。
 */
export const parseQuickAddInput = (
  input: string,
): { description: string; amount: number } | null => {
  const text = input.trim();
  if (!text) return null;

  // 前後為非數字邊界的數字，避免切到 7-11 這種詞裡的數字
  const matches = [...text.matchAll(/(?<![\d.,])\d[\d,]*(?:\.\d+)?(?![\d.,])/g)];
  if (matches.length === 0) return null;

  const last = matches[matches.length - 1];
  const amount = parseFloat(last[0].replace(/,/g, ''));
  if (!isFinite(amount) || amount <= 0) return null;

  const description = (
    text.slice(0, last.index) + text.slice(last.index + last[0].length)
  )
    .replace(/\s+/g, ' ')
    .trim();

  return { description, amount };
};

/**
 * 把一行輸入變成可直接寫入資料庫的支出草稿，
 * 套用旅程的預設幣別、分類、付款人與分攤設定。
 *
 * 描述留空時用分類名代入，與 ExpenseModal 的行為一致。
 */
export const buildQuickAddDraft = (
  input: string,
  trip: Trip,
  currentUser: string | null,
): QuickAddDraft | null => {
  const parsed = parseQuickAddInput(input);
  if (!parsed) return null;

  const currency = trip.default_currency || trip.base_currency;
  const category = trip.default_category || trip.categories[0] || '其他';
  const precision = getCurrencyPrecision(currency, trip.precision_config);

  const defaultPayers = (trip.default_payer ?? []).filter((m) => trip.members.includes(m));
  const payers = defaultPayers.length > 0
    ? defaultPayers
    : [currentUser && trip.members.includes(currentUser) ? currentUser : trip.members[0]].filter(Boolean);

  const defaultSplit = (trip.default_split_members ?? []).filter((m) => trip.members.includes(m));
  const splitters = defaultSplit.length > 0 ? defaultSplit : trip.members;

  if (payers.length === 0 || splitters.length === 0) return null;

  // 餘數承擔者：優先目前使用者（若他是付款人），否則第一位付款人
  const adjustmentMember = currentUser && splitters.includes(currentUser)
    ? currentUser
    : splitters[0];

  return {
    description: parsed.description || category,
    amount: parsed.amount,
    currency,
    category,
    date: getLocalDateString(),
    payer_data: calculateDistribution(parsed.amount, payers, {}, null, precision),
    split_data: calculateDistribution(parsed.amount, splitters, {}, adjustmentMember, precision),
    adjustment_member: adjustmentMember,
  };
};
