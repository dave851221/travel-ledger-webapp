import { describe, expect, it } from 'vitest';
import type { Expense } from '../../types';
import { autoPick, buildTimeline, evenlySpaced, recapDays, shotsFromPicks, tripDateRange, MAX_PHOTOS } from './plan';

let seq = 0;
const exp = (date: string, photos: string[], extra: Partial<Expense> = {}): Expense => ({
  id: `e${++seq}`, trip_id: 't', date, category: '餐飲', description: `d${seq}`, amount: 100, currency: 'JPY',
  payer_data: {}, split_data: {}, adjustment_member: null, photo_urls: photos, is_settlement: false,
  deleted_at: null, created_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`, ...extra,
});

describe('tripDateRange', () => {
  it('prefers the itinerary dates', () => {
    expect(tripDateRange([exp('2026-05-01', [])], ['2026-11-16', '2026-11-14'])).toEqual({ from: '2026-11-14', to: '2026-11-16' });
  });

  it('skips bookings made months before the trip', () => {
    const list = [
      exp('2026-05-23', []), exp('2026-07-04', []),
      ...['2026-11-14', '2026-11-15', '2026-11-15', '2026-11-17', '2026-11-18'].map(d => exp(d, [])),
    ];
    expect(tripDateRange(list)).toEqual({ from: '2026-11-14', to: '2026-11-18' });
  });

  it('ignores settlements and trashed expenses', () => {
    const list = [exp('2026-01-01', [], { is_settlement: true }), exp('2026-01-02', [], { deleted_at: 'x' }), exp('2026-03-03', [])];
    expect(tripDateRange(list)).toEqual({ from: '2026-03-03', to: '2026-03-03' });
  });
});

describe('recapDays', () => {
  it('groups item photos by day, oldest first, without receipts or photos outside the range', () => {
    const list = [
      exp('2026-11-15', ['b1', 'r1'], { receipt_photo_urls: ['r1'] }),
      exp('2026-11-14', ['a1', 'a2']),
      exp('2026-05-01', ['old']),
    ];
    const days = recapDays(list, { from: '2026-11-14', to: '2026-11-16' }, [{ date: '2026-11-15', city: '京都' }]);
    expect(days.map(d => [d.date, d.dayNumber, d.city, d.photos.map(p => p.path)])).toEqual([
      ['2026-11-14', 1, undefined, ['a1', 'a2']],
      ['2026-11-15', 2, '京都', ['b1']],
    ]);
  });
});

describe('autoPick', () => {
  const day = (date: string, n: number) => ({ date, dayNumber: 1, photos: Array.from({ length: n }, (_, i) => ({ path: `${date}-${i}`, date, caption: '' })) });

  it('spreads picks evenly inside a day', () => {
    expect(evenlySpaced(12, 3)).toEqual([2, 6, 10]);
    expect(evenlySpaced(2, 4)).toEqual([0, 1]);
  });

  it('takes 2–4 a day and never more than the total', () => {
    const days = [day('d1', 3), day('d2', 12), day('d3', 1), day('d4', 7), day('d5', 12)];
    const picks = autoPick(days, 14);
    expect(picks.length).toBe(14);
    for (const d of days) {
      const n = picks.filter(p => p.startsWith(d.date)).length;
      expect(n).toBeGreaterThanOrEqual(Math.min(2, d.photos.length));
      expect(n).toBeLessThanOrEqual(4);
    }
  });

  it('still covers every day when there are many days', () => {
    const days = Array.from({ length: 20 }, (_, i) => day(`x${String(i).padStart(2, '0')}`, 5));
    const picks = autoPick(days, 22);
    expect(new Set(picks.map(p => p.slice(0, 3))).size).toBe(20);
    expect(picks.length).toBeLessThanOrEqual(22);
  });
});

describe('buildTimeline', () => {
  const shotsOf = (n: number, perDay = 3) => {
    const days = Array.from({ length: Math.ceil(n / perDay) }, (_, d) => ({
      date: `2026-11-${String(10 + d).padStart(2, '0')}`, dayNumber: d + 1,
      photos: Array.from({ length: perDay }, (_, i) => ({ path: `p${d}-${i}`, date: '', caption: '' })),
    }));
    return shotsFromPicks(days, days.flatMap(d => d.photos.map(p => p.path)).slice(0, n));
  };

  it.each([4, 5, 12, 22, MAX_PHOTOS])('stays between 30 and 45 seconds with %i photos', n => {
    for (const bpm of [92, 118]) {
      const tl = buildTimeline(shotsOf(n), bpm, null);
      expect(tl.duration).toBeGreaterThanOrEqual(29.5);
      expect(tl.duration).toBeLessThanOrEqual(45.5);
    }
  });

  it('cuts on beats and starts the stats on a new bar', () => {
    const tl = buildTimeline(shotsOf(17), 118, null);
    for (const s of tl.segments) expect(Math.abs(s.start / tl.beat - Math.round(s.start / tl.beat))).toBeLessThan(1e-9);
    expect(tl.marks.stats % 4).toBe(0);
    const segs = tl.segments;
    segs.slice(1).forEach((s, i) => expect(s.start).toBeCloseTo(segs[i].end));
  });

  it('opens each day with a stronger cut', () => {
    const tl = buildTimeline(shotsOf(6), 118, null);
    tl.segments.forEach((s, i) => {
      if (s.kind === 'shot' && s.dayStart) expect(tl.transitions[i]).toBe('zoom');
    });
  });
});
