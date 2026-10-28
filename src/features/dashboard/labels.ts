import type { Expense } from '../../types';

const nonZero = (data: Record<string, number>) => Object.entries(data).filter(([, v]) => Number(v) !== 0).map(([n]) => n);

export const payerLabel = (exp: Expense) => {
  const payers = nonZero(exp.payer_data);
  if (payers.length === 0) return '未填付款人';
  return payers.length > 2 ? `${payers[0]} 等 ${payers.length} 人` : payers.join('、');
};

export const splitLabel = (exp: Expense, members: string[]) => {
  const entries = Object.entries(exp.split_data).filter(([, v]) => Number(v) !== 0);
  if (entries.length === 0) return '未分攤';
  if (entries.length === 1) return `只有${entries[0][0]}`;
  const equal = entries.every(([, v]) => Math.abs(Number(v) - Number(entries[0][1])) < 0.011);
  if (entries.length === members.length) return equal ? '全員均分' : '全員分攤';
  return equal ? `${entries.length} 人均分` : `${entries.length} 人分攤`;
};
