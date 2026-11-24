import Decimal from 'decimal.js';
import type { Expense } from '../../types';
import { convertToBase } from '../../utils/finance';
import { daysBetween, photoCaption, type RecapDay } from './plan';

/**
 * 回顧影片的統計與「旅途小彩蛋」：從帳目與照片算得出來、讓人會心一笑的小數據。
 * 每一項都有 key，使用者可以逐項勾選要放進影片的（`defaultOn` 是第一次打開時預設勾的）。
 * 純函式；金額是否顯示由呼叫端給的 `money` 決定（null 就一律不出現金額，需要金額才成立的項目直接不提供）。
 */

export interface RecapFact {
  key: string;
  /** Small line on top, e.g. 最貴的一筆 */
  label: string;
  /** The big answer */
  value: string;
  /** One line of colour underneath */
  detail: string;
  defaultOn: boolean;
}

export interface RecapStat {
  key: string;
  label: string;
  /** A number counts up; a string just appears */
  value: number | string;
  prefix?: string;
  suffix?: string;
  defaultOn: boolean;
}

export interface FactInput {
  expenses: Expense[];
  range: { from: string; to: string };
  /** Days with the trip's own photos (receipts left out) */
  days: RecapDay[];
  members: string[];
  baseCurrency: string;
  rates: Record<string, number>;
  /** Formats an amount in its own currency; null hides every amount */
  money: ((amount: number, currency: string) => string) | null;
  /** Cities in visiting order, from the itinerary (e.g. 京都 → 大阪) */
  cities?: string[];
  /** IANA zone for "the latest expense of the night" */
  timeZone?: string | null;
}

/** Past this a page gets too crowded to read in a few seconds */
export const MAX_FACTS = 6;
export const MAX_STATS = 6;

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

/** Category names often carry an emoji (飲食🍖); the video shows them as they are */
const isFood = (category: string) => /食|餐|吃|飲|喝|美食/.test(category);

const percent = (part: Decimal, whole: Decimal) => (whole.gt(0) ? Math.round(part.div(whole).times(100).toNumber()) : 0);

const spentOf = (expenses: Expense[]) => expenses.filter(e => !e.deleted_at && !e.is_settlement);

const hourIn = (iso: string, timeZone?: string | null): number | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: timeZone || undefined }).formatToParts(d);
    const h = Number(parts.find(p => p.type === 'hour')?.value);
    const m = Number(parts.find(p => p.type === 'minute')?.value);
    return h + m / 60;
  } catch {
    return d.getHours() + d.getMinutes() / 60;
  }
};

/** Late night counts as after 22:00 or before 05:00; returns minutes past 18:00 so 01:30 beats 23:50 */
const lateness = (hour: number) => (hour < 5 ? hour + 24 : hour) - 18;

const clock = (hour: number) => {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${h < 5 ? '凌晨' : '晚上'} ${String(h > 12 ? h - 12 : h).padStart(1, '0')}:${String(m).padStart(2, '0')}`;
};

export const recapFacts = (input: FactInput): RecapFact[] => {
  const { expenses, range, days, members, baseCurrency, rates, money } = input;
  const spent = spentOf(expenses);
  const inTrip = spent.filter(e => e.date >= range.from && e.date <= range.to);
  const base = (e: Expense) => convertToBase(e.amount, e.currency, rates, baseCurrency);
  const facts: RecapFact[] = [];
  const name = (e: Expense) => photoCaption(e.description) || e.category;

  // The single biggest bill (anywhere in the trip, bookings included)
  const priciest = spent.reduce<Expense | null>((best, e) => (!best || base(e).gt(base(best)) ? e : best), null);
  if (priciest && base(priciest).gt(0)) {
    const inRange = priciest.date >= range.from && priciest.date <= range.to;
    facts.push({
      key: 'priciest', label: '最貴的一筆', value: name(priciest), defaultOn: true,
      detail: [money ? money(priciest.amount, priciest.currency) : '', inRange ? dayTag(range.from, priciest.date) : '出發前就訂好']
        .filter(Boolean).join('  ·  '),
    });
  }

  // The priciest meal, when the trip has a food category and it isn't the bill above
  const meal = inTrip.filter(e => isFood(e.category)).reduce<Expense | null>((b, e) => (!b || base(e).gt(base(b)) ? e : b), null);
  if (meal && meal !== priciest && base(meal).gt(0)) {
    facts.push({
      key: 'meal', label: '最豪華的一餐', value: name(meal), defaultOn: true,
      detail: [money ? money(meal.amount, meal.currency) : '', dayTag(range.from, meal.date)].filter(Boolean).join('  ·  '),
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
      key: 'bigDay', label: '花最多的一天', value: dayTag(range.from, bigDay[0]), defaultOn: true,
      detail: [city, money ? `共 ${money(bigDay[1].toNumber(), baseCurrency)}` : `記了 ${countByDay.get(bigDay[0])} 筆`]
        .filter(Boolean).join('  ·  '),
    });
  }

  // Whose card came out most often
  if (members.length > 1) {
    const paid = new Map<string, number>();
    for (const e of spent) {
      for (const [who, amount] of Object.entries(e.payer_data ?? {})) {
        if (Number(amount) > 0 && members.includes(who)) paid.set(who, (paid.get(who) ?? 0) + 1);
      }
    }
    const payer = top([...paid.entries()]);
    if (payer && payer[1] > 1) facts.push({ key: 'payer', label: '最常掏錢的人', value: payer[0], detail: `幫大家付了 ${payer[1]} 次`, defaultOn: true });
  }

  // The shop we kept going back to
  const shops = new Map<string, number>();
  for (const e of inTrip) {
    const n = photoCaption(e.description).trim();
    if (n) shops.set(n, (shops.get(n) ?? 0) + 1);
  }
  const regular = top([...shops.entries()]);
  if (regular && regular[1] > 1) facts.push({ key: 'regular', label: '最常光顧', value: regular[0], detail: `去了 ${regular[1]} 次`, defaultOn: true });

  // Where the money went, as shares (no amounts needed)
  const byCategory = new Map<string, Decimal>();
  for (const e of spent) if (e.category) byCategory.set(e.category, (byCategory.get(e.category) ?? new Decimal(0)).plus(base(e)));
  const catTotal = [...byCategory.values()].reduce((s, v) => s.plus(v), new Decimal(0));
  const topCats = [...byCategory.entries()].sort((a, b) => b[1].comparedTo(a[1])).slice(0, 3);
  if (topCats.length > 1 && catTotal.gt(0)) {
    facts.push({
      key: 'categories', label: '錢都花去哪了', defaultOn: true,
      value: topCats.map(([c, v]) => `${c} ${percent(v, catTotal)}%`).join('  '),
      detail: `前 ${topCats.length} 大分類占了 ${percent(topCats.reduce((s, [, v]) => s.plus(v), new Decimal(0)), catTotal)}%`,
    });
  }

  // The most photogenic day
  const photoDay = top(days.map(d => [d, d.photos.length] as [RecapDay, number]));
  if (photoDay && days.length > 1 && photoDay[1] > 1) {
    facts.push({
      key: 'photoDay', label: '拍最多照片的一天', value: dayTag(range.from, photoDay[0].date), defaultOn: false,
      detail: [photoDay[0].city, `${photoDay[1]} 張照片`].filter(Boolean).join('  ·  '),
    });
  }

  const cities = input.cities ?? [];
  if (cities.length > 1) facts.push({ key: 'cities', label: '一路走過', value: cities.join(' → '), detail: `${cities.length} 個城市`, defaultOn: true });

  // The latest thing anyone logged at night
  const night = inTrip
    .map(e => ({ e, h: hourIn(e.created_at, input.timeZone) }))
    .filter((x): x is { e: Expense; h: number } => x.h !== null && (x.h >= 22 || x.h < 5))
    .reduce<{ e: Expense; h: number } | null>((b, x) => (!b || lateness(x.h) > lateness(b.h) ? x : b), null);
  if (night) facts.push({ key: 'night', label: '夜貓時刻', value: name(night.e), detail: `${clock(night.h)} 記下的`, defaultOn: false });

  // What we kept buying (by how often, not how much)
  const countByCat = new Map<string, number>();
  for (const e of spent) if (e.category) countByCat.set(e.category, (countByCat.get(e.category) ?? 0) + 1);
  const cat = top([...countByCat.entries()]);
  if (cat && cat[1] > 1) facts.push({ key: 'oftenCategory', label: '最常買的是', value: cat[0], detail: `${cat[1]} 筆，占全部的 ${Math.round((cat[1] / spent.length) * 100)}%`, defaultOn: false });

  // The busiest day for the ledger
  const busy = top([...countByDay.entries()]);
  if (busy && countByDay.size > 1 && busy[1] > 1) facts.push({ key: 'busyDay', label: '記帳最勤的一天', value: dayTag(range.from, busy[0]), detail: `一天記了 ${busy[1]} 筆`, defaultOn: false });

  // The smallest happiness
  const cheapest = inTrip.filter(e => base(e).gt(0)).reduce<Expense | null>((b, e) => (!b || base(e).lt(base(b)) ? e : b), null);
  if (cheapest && money) facts.push({ key: 'cheapest', label: '最便宜的小確幸', value: name(cheapest), detail: money(cheapest.amount, cheapest.currency), defaultOn: false });

  // Per person per day, only when amounts are shown
  const tripDays = daysBetween(range.from, range.to) + 1;
  if (money && members.length > 0 && tripDays > 0 && catTotal.gt(0)) {
    facts.push({
      key: 'perPersonDay', label: '平均每人每天', defaultOn: false,
      value: money(catTotal.div(members.length).div(tripDays).toDecimalPlaces(0).toNumber(), baseCurrency),
      detail: `${members.length} 個人 · ${tripDays} 天`,
    });
  }

  return facts;
};

export interface StatInput extends Pick<FactInput, 'expenses' | 'range' | 'members' | 'baseCurrency' | 'rates' | 'money'> {
  /** Photos of the trip (receipts not counted) */
  photoCount: number;
  /** "NT$" for TWD; shown in front of the total */
  currencyPrefix: string;
}

/** The big numbers page. Money rows only exist when amounts are shown. */
export const recapStats = (input: StatInput): RecapStat[] => {
  const { expenses, range, members, baseCurrency, rates, money, photoCount, currencyPrefix } = input;
  const spent = spentOf(expenses);
  const tripDays = daysBetween(range.from, range.to) + 1;
  const base = (e: Expense) => convertToBase(e.amount, e.currency, rates, baseCurrency);
  const total = spent.reduce((s, e) => s.plus(base(e)), new Decimal(0));
  const stats: RecapStat[] = [
    { key: 'days', label: '旅行天數', value: tripDays, suffix: '天', defaultOn: true },
    { key: 'count', label: '一起記下的消費', value: spent.length, suffix: '筆', defaultOn: true },
  ];
  if (photoCount > 0) stats.push({ key: 'photos', label: '拍下的照片', value: photoCount, suffix: '張', defaultOn: true });
  if (money && total.gt(0)) {
    stats.push({ key: 'total', label: '總花費', value: Math.round(total.toNumber()), prefix: currencyPrefix, defaultOn: true });
    if (members.length > 1) stats.push({ key: 'perPerson', label: '平均每人', value: Math.round(total.div(members.length).toNumber()), prefix: currencyPrefix, defaultOn: false });
    if (tripDays > 1) stats.push({ key: 'perDay', label: '平均每天', value: Math.round(total.div(tripDays).toNumber()), prefix: currencyPrefix, defaultOn: false });
    const byCategory = new Map<string, Decimal>();
    for (const e of spent) if (e.category) byCategory.set(e.category, (byCategory.get(e.category) ?? new Decimal(0)).plus(base(e)));
    const cat = [...byCategory.entries()].sort((a, b) => b[1].comparedTo(a[1]))[0];
    if (cat) stats.push({ key: 'topCategory', label: '花最多錢在', value: cat[0], defaultOn: true });
  }
  const currencies = new Set(spent.map(e => e.currency)).size;
  if (currencies > 1) stats.push({ key: 'currencies', label: '用過的幣別', value: currencies, suffix: '種', defaultOn: false });
  const categories = new Set(spent.map(e => e.category).filter(Boolean)).size;
  if (categories > 1) stats.push({ key: 'categoryCount', label: '花錢的分類', value: categories, suffix: '類', defaultOn: false });
  return stats;
};

export interface PersonSpending {
  member: string;
  /** In the base currency, by share (split), not by who paid */
  total: number;
  /** Biggest first, at most three */
  categories: { name: string; amount: number; share: number }[];
}

/** 每個人花在哪些分類最多（看分攤）。給「每個人的花錢重點」那一頁。 */
export const peopleSpending = (
  expenses: Expense[],
  members: string[],
  rates: Record<string, number>,
  baseCurrency: string,
): PersonSpending[] | null => {
  if (members.length < 2) return null;
  const per = new Map<string, Map<string, Decimal>>(members.map(m => [m, new Map()]));
  for (const e of spentOf(expenses)) {
    for (const [who, share] of Object.entries(e.split_data ?? {})) {
      const cats = per.get(who);
      if (!cats) continue;
      const key = e.category || '其他';
      cats.set(key, (cats.get(key) ?? new Decimal(0)).plus(convertToBase(Number(share) || 0, e.currency, rates, baseCurrency)));
    }
  }
  const rows = members.map(member => {
    const cats = [...(per.get(member) ?? new Map<string, Decimal>()).entries()].sort((a, b) => b[1].comparedTo(a[1]));
    const total = cats.reduce((s, [, v]) => s.plus(v), new Decimal(0));
    return {
      member,
      total: Math.round(total.toNumber()),
      categories: cats.slice(0, 3).map(([name, v]) => ({ name, amount: Math.round(v.toNumber()), share: percent(v, total) })),
    };
  });
  return rows.some(r => r.total > 0) ? rows.sort((a, b) => b.total - a.total) : null;
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
  for (const e of spentOf(expenses)) {
    const idx = Math.min(days - 1, Math.max(0, daysBetween(range.from, e.date)));
    for (const [who, share] of Object.entries(e.split_data ?? {})) {
      if (!perDay[who]) continue;
      perDay[who][idx] = perDay[who][idx].plus(convertToBase(Number(share) || 0, e.currency, rates, baseCurrency));
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
