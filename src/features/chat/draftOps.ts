/**
 * 聊天卡片上「直接改」的計算（純函式，draftOps.test.ts）。
 *
 * LINE 的卡片只能按按鈕換一張新卡（只算我、換幣別），要改金額或分攤得開 LIFF；
 * 網頁的卡片本身就能改。所有重算都走 `calculateDistribution`（decimal.js），
 * 與 ExpenseModal、Edge Function 的分帳是同一套規則（finance.parity.test.ts 看守兩邊一致）。
 * 真正存進去之前，web-chat 的 commitExpense 還會再驗一次 Σ 與成員。
 */
import Decimal from 'decimal.js';
import type { Expense, Trip } from '../../types';
import { calculateDistribution, getCurrencyPrecision } from '../../utils/finance';
import { getLocalDateString } from '../../utils/date';
import type { DraftExpense, WebDraft } from './types';

const precisionOf = (trip: Trip, currency: string) => getCurrencyPrecision(currency, trip.precision_config);

const round = (value: number, precision: number) =>
  new Decimal(Number(value) || 0).toDecimalPlaces(precision).toNumber();

/** 付款人與分攤都照目前的人重新均分（金額或人改了之後） */
export function redistribute(
  exp: DraftExpense,
  trip: Trip,
  next: { amount?: number; payers?: string[]; splits?: string[] },
): DraftExpense {
  const currency = exp.c;
  const precision = precisionOf(trip, currency);
  const amount = round(next.amount ?? exp.a, precision);
  const payers = (next.payers ?? Object.keys(exp.p)).filter(m => trip.members.includes(m));
  const splits = (next.splits ?? Object.keys(exp.s)).filter(m => trip.members.includes(m));
  // 付款人有一個人也在分攤裡，餘數就給他（與 commitExpense 的 pickAdjustmentMember 同精神）
  const adjust = payers.find(m => splits.includes(m)) ?? splits[0] ?? null;
  return {
    ...exp,
    a: amount,
    p: payers.length > 0 ? calculateDistribution(amount, payers, {}, payers[0], precision) : {},
    s: splits.length > 0 ? calculateDistribution(amount, splits, {}, adjust, precision) : {},
  };
}

/** 點一下成員：在 / 不在付款人（或分攤）裡。至少留一個人 */
export function toggleMember(exp: DraftExpense, trip: Trip, side: 'p' | 's', member: string): DraftExpense {
  const current = Object.keys(exp[side]);
  const next = current.includes(member) ? current.filter(m => m !== member) : [...current, member];
  if (next.length === 0) return exp;
  // 照旅程成員的順序排，卡片上看起來才穩定
  const ordered = trip.members.filter(m => next.includes(m));
  return redistribute(exp, trip, side === 'p' ? { payers: ordered } : { splits: ordered });
}

/** 改金額：其他欄位不動，付款與分攤照原本的人均分 */
export function changeAmount(exp: DraftExpense, trip: Trip, amount: number): DraftExpense {
  return redistribute(exp, trip, { amount: Math.max(0, Number(amount) || 0) });
}

/** 👤 只算我：付款人與分攤都只有我 */
export function soloDraft(exp: DraftExpense, trip: Trip, me: string): DraftExpense {
  const precision = precisionOf(trip, exp.c);
  const amount = round(exp.a, precision);
  return { ...exp, a: amount, p: { [me]: amount }, s: { [me]: amount } };
}

/**
 * 換幣別（收據的幣別這趟沒有匯率時）。
 * 🚫 只換標籤，金額不換算 —— 與 LINE 的「以 XXX 存入」相同；精度變了就照新精度重算分帳，
 * 原本有值的份額照新精度四捨五入、餘數給調整成員，Σ 一定等於總額。
 */
export function changeCurrency(exp: DraftExpense, trip: Trip, currency: string): DraftExpense {
  const precision = precisionOf(trip, currency);
  const amount = round(exp.a, precision);
  const payers = Object.keys(exp.p);
  const splits = Object.keys(exp.s);
  const adjust = payers.find(m => splits.includes(m)) ?? splits[0] ?? null;
  // 全 0 的 map 是「均分」的佔位，不能當鎖定金額（否則整筆會落到調整成員身上）
  const relock = (map: Record<string, number>): Record<string, number> => {
    const entries = Object.entries(map);
    if (entries.every(([, v]) => !(Number(v) || 0))) return {};
    return Object.fromEntries(entries.map(([k, v]) => [k, round(v, precision)]));
  };
  return {
    ...exp,
    c: currency,
    a: amount,
    p: payers.length > 0 ? calculateDistribution(amount, payers, relock(exp.p), payers[0], precision) : {},
    s: splits.length > 0 ? calculateDistribution(amount, splits, relock(exp.s), adjust, precision) : {},
  };
}

/** 卡片上要不要給「👤 只算我」：本來就只有我付、只算我，就不必 */
export function canGoSolo(exp: DraftExpense, trip: Trip, me: string | null): boolean {
  if (!me || trip.members.length < 2 || !trip.members.includes(me)) return false;
  const payers = Object.keys(exp.p);
  const splits = Object.keys(exp.s);
  return !(payers.length === 1 && splits.length === 1 && payers[0] === me && splits[0] === me);
}

/** 至少兩個品項、兩個成員，逐項分才有意義 */
export const canSplitByItems = (draft: WebDraft, trip: Trip) => draft.items.length >= 2 && trip.members.length >= 2;

/** 打開完整表單用：一份沒有 id 的支出（ExpenseModal 會當成新增） */
export function draftToExpense(draft: WebDraft, trip: Trip): Expense {
  const e = draft.exp;
  return {
    id: '',
    trip_id: trip.id,
    date: e.dt || getLocalDateString(),
    category: e.cat || trip.categories[0] || '其他',
    description: e.d,
    amount: Number(e.a) || 0,
    currency: e.c || trip.base_currency,
    payer_data: e.p,
    split_data: e.s,
    adjustment_member: Object.keys(e.s)[0] ?? trip.members[0] ?? null,
    photo_urls: draft.photoIds,
    receipt_photo_urls: draft.receipt ? draft.photoIds : [],
    is_settlement: false,
    deleted_at: null,
    created_at: new Date().toISOString(),
  };
}

/** 卡片能不能直接存：金額大於 0、付款與分攤都有人 */
export const canSave = (exp: DraftExpense) =>
  Number(exp.a) > 0 && Object.keys(exp.p).length > 0 && Object.keys(exp.s).length > 0;
