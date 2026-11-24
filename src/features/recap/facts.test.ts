import { describe, expect, it } from 'vitest';
import type { Expense } from '../../types';
import { peopleSpending, recapFacts, recapStats, spendingRace, visitedCities } from './facts';
import type { RecapDay } from './plan';

let seq = 0;
const exp = (date: string, amount: number, payer: string, extra: Partial<Expense> = {}): Expense => ({
  id: `e${++seq}`, trip_id: 't', date, category: '飲食', description: `item${seq} (說明)`, amount, currency: 'JPY',
  payer_data: { [payer]: amount }, split_data: {}, adjustment_member: null, photo_urls: [], is_settlement: false,
  deleted_at: null, created_at: '', ...extra,
});
const day = (date: string, n: number, city?: string): RecapDay => ({
  date, dayNumber: 1, city, photos: Array.from({ length: n }, (_, i) => ({ path: `${date}${i}`, date, caption: '', amount: 0, currency: 'JPY', kind: 'item' })),
});

const base = {
  range: { from: '2026-11-14', to: '2026-11-16' },
  members: ['甲', '乙'],
  baseCurrency: 'TWD',
  rates: { JPY: 0.2 },
};

describe('recapFacts', () => {
  const expenses = [
    exp('2026-11-14', 1000, '甲'),
    exp('2026-11-15', 36000, '乙', { description: '壽喜燒 (餐廳)' }),
    exp('2026-11-15', 500, '甲'),
    exp('2026-11-16', 800, '甲', { category: '交通' }),
    exp('2026-11-16', 9999, '乙', { is_settlement: true }),
  ];
  const days = [day('2026-11-14', 1, '京都'), day('2026-11-15', 5, '京都'), day('2026-11-16', 2, '大阪')];

  it('finds the priciest bill, the big day, the main payer and the photo day', () => {
    const facts = recapFacts({ ...base, expenses, days, money: (a, c) => `${c}${a}`, cities: ['京都', '大阪'] });
    const byLabel = Object.fromEntries(facts.map(f => [f.label, f]));
    expect(byLabel['最貴的一筆'].value).toBe('壽喜燒');
    expect(byLabel['最貴的一筆'].detail).toContain('JPY36000');
    expect(byLabel['花最多的一天'].value).toBe('Day 2 · 11.15');
    expect(byLabel['最常掏錢的人'].value).toBe('甲');
    expect(byLabel['拍最多照片的一天'].detail).toContain('5 張');
    expect(byLabel['最常光顧']).toBeUndefined();
    expect(facts.every(f => f.key)).toBe(true);
  });

  it('shows no amounts when they are hidden', () => {
    const facts = recapFacts({ ...base, expenses, days, money: null });
    for (const f of facts) expect(`${f.value}${f.detail}`).not.toMatch(/JPY|TWD|¥|NT\$/);
    expect(facts.some(f => f.key === 'cheapest' || f.key === 'perPersonDay')).toBe(false);
  });
});

describe('visitedCities', () => {
  it('splits moves and keeps order', () => {
    expect(visitedCities(['京都', '京都', '京都 → 大阪', '宇治 → 大阪', undefined, '神戶'])).toEqual(['京都', '大阪', '宇治', '神戶']);
  });
});

describe('spendingRace', () => {
  it('adds up each share day by day, bookings at the start line', () => {
    const list = [
      exp('2026-05-01', 1000, '甲', { split_data: { 甲: 500, 乙: 500 } }),
      exp('2026-11-15', 300, '甲', { split_data: { 甲: 100, 乙: 200 } }),
      exp('2026-11-16', 50, '乙', { split_data: { 乙: 50 }, currency: 'TWD' }),
    ];
    const race = spendingRace(list, base.range, base.members, base.rates, base.baseCurrency)!;
    expect(race.dates).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    expect(race.totals['甲']).toEqual([100, 120, 120]);
    expect(race.totals['乙']).toEqual([100, 140, 190]);
  });

  it('needs at least two people', () => {
    expect(spendingRace([], base.range, ['甲'], base.rates, base.baseCurrency)).toBeNull();
  });
});

describe('recapStats', () => {
  it('drops the money rows when amounts are hidden', () => {
    const list = [exp('2026-11-14', 1000, '甲'), exp('2026-11-15', 500, '乙', { category: '交通', currency: 'TWD' })];
    const withMoney = recapStats({ ...base, expenses: list, money: (a, c) => `${c}${a}`, photoCount: 3, currencyPrefix: 'NT$' });
    expect(withMoney.map(s => s.key)).toEqual(['days', 'count', 'photos', 'total', 'perPerson', 'perDay', 'topCategory', 'currencies', 'categoryCount']);
    expect(withMoney.find(s => s.key === 'total')?.value).toBe(700);
    const hidden = recapStats({ ...base, expenses: list, money: null, photoCount: 3, currencyPrefix: 'NT$' });
    expect(hidden.map(s => s.key)).toEqual(['days', 'count', 'photos', 'currencies', 'categoryCount']);
  });
});

describe('peopleSpending', () => {
  it("ranks each person's categories by their own share", () => {
    const list = [
      exp('2026-11-14', 1000, '甲', { split_data: { 甲: 800, 乙: 200 } }),
      exp('2026-11-15', 500, '乙', { category: '購物', split_data: { 乙: 500 } }),
    ];
    const rows = peopleSpending(list, base.members, base.rates, base.baseCurrency)!;
    expect(rows.map(r => r.member)).toEqual(['甲', '乙']);
    expect(rows[1].categories.map(c => `${c.name}:${c.share}`)).toEqual(['購物:71', '飲食:29']);
  });
});
