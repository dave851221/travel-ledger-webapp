import Decimal from 'decimal.js';
import type { Expense } from '../../types';
import { convertToBase } from '../../utils/finance';
import { daysBetween, photoCaption, type RecapDay } from './plan';

/**
 * 回顧影片的「趣味統計」：從帳目與照片算得出來、讓人會心一笑的小數據。
 * 純函式；金額是否顯示由呼叫端給的 `money` 決定（null 就一律不出現金額）。
 */

export interface RecapFact {
  /** Small line on top, e.g. 最貴的一筆 */
  label: string;
  /** The big answer */
  value: string;
  /** One line of colour underneath */
  detail: string;
}

export interface FactInput {
  expenses: Expense[];
  range: { from: string; to: string };
  days: RecapDay[];
  members: string[];
  baseCurrency: string;
  rates: Record<string, number>;
  /** Formats an amount in its own currency; null hides every amount */
  money: ((amount: number, currency: string) => string) | null;
  /** Cities in visiting order, from the itinerary (e.g. 京都 → 大阪) */
  cities?: string[];
}

export const MAX_FACTS = 5;

const dayTag = (from: string, date: string) =>
  `Day ${daysBetween(from, date) + 1} · ${date.slice(5, 7)}.${date.slice(8, 10)}`;

/** Splits itinerary city lines like "京都 → 大阪" and keeps each city once, in order */
export const visitedCities = (cityLines: (string | undefined)[]): string[] => {
  const seen: string[] = [];
  for (const line of cityLines) {
    for (const part of (line ?? '').split(/\s*(?:→|->|、|,|\/)\s*/)) {
      const city = part.trim();
      if (city && !seen.includes(city)) seen.push(city);
    }
  }
  return seen;
};

const top = <T>(entries: [T, number][]): [T, number] | null =>
  entries.reduce<[T, number] | null>((best, e) => (!best || e[1] > best[1] ? e : best), null);

export const recapFacts = (input: FactInput): RecapFact[] => {
  const { expenses, range, days, members, baseCurrency, rates, money } = input;
  const spent = expenses.filter(e => !e.deleted_at && !e.is_settlement);
  const inTrip = spent.filter(e => e.date >= range.from && e.date <= range.to);
  const base = (e: Expense) => convertToBase(e.amount, e.currency, rates, baseCurrency);
  const facts: RecapFact[] = [];

  // The single biggest bill (anywhere in the trip, bookings included)
  const priciest = spent.reduce<Expense | null>((best, e) => (!best || base(e).gt(base(best)) ? e : best), null);
  if (priciest && base(priciest).gt(0)) {
    const inRange = priciest.date >= range.from && priciest.date <= range.to;
    facts.push({
      label: '最貴的一筆',
      value: photoCaption(priciest.description) || priciest.category,
      detail: [money ? money(priciest.amount, priciest.currency) : '', inRange ? dayTag(range.from, priciest.date) : '出發前就訂好']
        .filter(Boolean).join('  ·  '),
    });
  }

  // The day the wallets took the biggest hit
  const byDay = new Map<string, Decimal>();
  const countByDay = new Map<string, number>();
  for (const e of inTrip) {
    byDay.set(e.date, (byDay.get(e.date) ?? new Decimal(0)).plus(base(e)));
    countByDay.set(e.date, (countByDay.get(e.date) ?? 0) + 1);
  }
  const bigDay = [...byDay.entries()].reduce<[string, Decimal] | null>((b, e) => (!b || e[1].gt(b[1]) ? e : b), null);
  if (bigDay && byDay.size > 1 && bigDay[1].gt(0)) {
    const city = days.find(d => d.date === bigDay[0])?.city;
    facts.push({
      label: '花最多的一天',
      value: dayTag(range.from, bigDay[0]),
      detail: [city, money ? `共 ${money(bigDay[1].toNumber(), baseCurrency)}` : `記了 ${countByDay.get(bigDay[0])} 筆`]
        .filter(Boolean).join('  ·  '),
    });
  }

  // Whose card came out most often
  if (members.length > 1) {
    const paid = new Map<string, number>();
    for (const e of spent) {
      for (const [name, amount] of Object.entries(e.payer_data ?? {})) {
        if (Number(amount) > 0 && members.includes(name)) paid.set(name, (paid.get(name) ?? 0) + 1);
      }
    }
    const payer = top([...paid.entries()]);
    if (payer && payer[1] > 1) facts.push({ label: '最常掏錢的人', value: payer[0], detail: `幫大家付了 ${payer[1]} 次` });
  }

  // The most photogenic day
  const photoDay = top(days.map(d => [d, d.photos.length] as [RecapDay, number]));
  if (photoDay && days.length > 1 && photoDay[1] > 1) {
    facts.push({
      label: '拍最多照片的一天',
      value: dayTag(range.from, photoDay[0].date),
      detail: [photoDay[0].city, `${photoDay[1]} 張照片`].filter(Boolean).join('  ·  '),
    });
  }

  const cities = input.cities ?? [];
  if (cities.length > 1) facts.push({ label: '一路走過', value: cities.join(' → '), detail: `${cities.length} 個城市` });

  // What we kept spending on (by how often, not how much)
  const byCategory = new Map<string, number>();
  for (const e of spent) if (e.category) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
  const cat = top([...byCategory.entries()]);
  if (cat && cat[1] > 1) facts.push({ label: '最常買的是', value: cat[0], detail: `${cat[1]} 筆，占全部的 ${Math.round((cat[1] / spent.length) * 100)}%` });

  // Per person per day, only when amounts are shown
  const tripDays = daysBetween(range.from, range.to) + 1;
  if (money && members.length > 0 && tripDays > 0) {
    const total = spent.reduce((s, e) => s.plus(base(e)), new Decimal(0));
    if (total.gt(0)) {
      facts.push({
        label: '平均每人每天',
        value: money(total.div(members.length).div(tripDays).toDecimalPlaces(0).toNumber(), baseCurrency),
        detail: `${members.length} 個人 · ${tripDays} 天`,
      });
    }
  }

  return facts.slice(0, MAX_FACTS);
};

export interface SpendingRace {
  /** One entry per trip day, oldest first */
  dates: string[];
  /** Each member's running total (in the base currency) at the end of each day */
  totals: Record<string, number[]>;
}

/**
 * 每人累積花費（看分攤，不看誰先墊）隨天數的變化，給「花費賽跑」長條圖用。
 * 出發前的訂票、住宿算在第一天的起跑點，旅程結束後補記的算在最後一天。
 */
export const spendingRace = (
  expenses: Expense[],
  range: { from: string; to: string },
  members: string[],
  rates: Record<string, number>,
  baseCurrency: string,
): SpendingRace | null => {
  const days = daysBetween(range.from, range.to) + 1;
  if (members.length < 2 || days < 1) return null;
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(`${range.from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const perDay: Record<string, Decimal[]> = Object.fromEntries(members.map(m => [m, dates.map(() => new Decimal(0))]));
  for (const e of expenses) {
    if (e.deleted_at || e.is_settlement) continue;
    const idx = Math.min(days - 1, Math.max(0, daysBetween(range.from, e.date)));
    for (const [name, share] of Object.entries(e.split_data ?? {})) {
      if (!perDay[name]) continue;
      perDay[name][idx] = perDay[name][idx].plus(convertToBase(Number(share) || 0, e.currency, rates, baseCurrency));
    }
  }
  const totals: Record<string, number[]> = {};
  let any = false;
  for (const m of members) {
    let run = new Decimal(0);
    totals[m] = perDay[m].map(v => {
      run = run.plus(v);
      return run.toDecimalPlaces(0).toNumber();
    });
    if (run.gt(0)) any = true;
  }
  return any ? { dates, totals } : null;
};
