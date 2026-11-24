import { MUSIC_STYLES } from './music';
import { describe, expect, it } from 'vitest';
import type { Expense } from '../../types';
import { type RecapDay, autoPick, buildTimeline, evenlySpaced, photoCaption, recapDays, shotsFromPicks, tripDateRange, MAX_PHOTOS, PER_DAY_MAX } from './plan';

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
  it('groups photos by day, oldest first, marks receipts and skips photos outside the range', () => {
    const list = [
      exp('2026-11-15', ['b1', 'r1'], { receipt_photo_urls: ['r1'] }),
      exp('2026-11-14', ['a1', 'a2']),
      exp('2026-05-01', ['old']),
    ];
    const days = recapDays(list, { from: '2026-11-14', to: '2026-11-16' }, [{ date: '2026-11-15', city: '京都' }]);
    expect(days.map(d => [d.date, d.dayNumber, d.city, d.photos.map(p => `${p.path}:${p.kind}`)])).toEqual([
      ['2026-11-14', 1, undefined, ['a1:item', 'a2:item']],
      ['2026-11-15', 2, '京都', ['b1:item', 'r1:receipt']],
    ]);
  });
});

describe('autoPick', () => {
  const day = (date: string, n: number) => ({ date, dayNumber: 1, photos: Array.from({ length: n }, (_, i) => ({ path: `${date}-${i}`, date, caption: '', amount: 0, currency: 'JPY', kind: 'item' as const })) });

  it('spreads picks evenly inside a day', () => {
    expect(evenlySpaced(12, 3)).toEqual([2, 6, 10]);
    expect(evenlySpaced(2, 4)).toEqual([0, 1]);
  });

  it('follows the photos, not the calendar: busy days get more, thin days may get none', () => {
    const days = [day('d1', 1), day('d2', 12), day('d3', 1), day('d4', 7), day('d5', 12), day('d6', 1)];
    const picks = autoPick(days, 14);
    expect(picks.length).toBe(14);
    const count = (d: string) => picks.filter(p => p.startsWith(`${d}-`)).length;
    expect(count('d2')).toBeGreaterThanOrEqual(count('d4'));
    expect(count('d4')).toBeGreaterThan(count('d1'));
    expect(count('d1') + count('d3') + count('d6')).toBeLessThanOrEqual(2);
  });

  it('never picks receipts on its own', () => {
    const d = day('r', 4);
    const mixed: RecapDay = { ...d, photos: d.photos.map((p, i) => ({ ...p, kind: i < 3 ? 'receipt' : 'item' })) };
    expect(autoPick([mixed], 22)).toEqual(['r-3']);
  });

  it('keeps one day from taking over and uses everything when there are few photos', () => {
    const many = autoPick([day('a', 40), day('b', 2)], 22);
    expect(many.filter(p => p.startsWith('a-')).length).toBeLessThanOrEqual(PER_DAY_MAX);
    expect(autoPick([day('a', 3), day('b', 2)], 22)).toHaveLength(5);
  });
});

describe('photoCaption', () => {
  it("drops the bot's bracketed explanation", () => {
    expect(photoCaption('關東煮 (日式燉煮小吃)')).toBe('關東煮');
    expect(photoCaption('もみじ守（楓葉造型御守，季節限定）')).toBe('もみじ守');
    expect(photoCaption('和幸（炸豬排）')).toBe('和幸');
    expect(photoCaption('(只有括號)')).toBe('(只有括號)');
    expect(photoCaption('夾娃娃')).toBe('夾娃娃');
  });
});

describe('buildTimeline', () => {
  const shotsOf = (n: number, perDay = 3) => {
    const days = Array.from({ length: Math.ceil(n / perDay) }, (_, d) => ({
      date: `2026-11-${String(10 + d).padStart(2, '0')}`, dayNumber: d + 1,
      photos: Array.from({ length: perDay }, (_, i) => ({ path: `p${d}-${i}`, date: '', caption: '', amount: 0, currency: 'JPY', kind: 'item' as const })),
    }));
    return shotsFromPicks(days, days.flatMap(d => d.photos.map(p => p.path)).slice(0, n));
  };

  it.each([4, 5, 12, 18])('stays around 30–46 seconds with %i photos and the default pages', n => {
    for (const bpm of [92, 118]) {
      const tl = buildTimeline(shotsOf(n), bpm, null, ['stats', 'facts']);
      expect(tl.duration).toBeGreaterThanOrEqual(29.5);
      expect(tl.duration).toBeLessThanOrEqual(47);
    }
  });

  it('lasts about as long whichever music is picked', () => {
    for (const n of [6, 12, 18]) {
      const lengths = MUSIC_STYLES.map(s => s.bpm).map(bpm => buildTimeline(shotsOf(n), bpm, null, ['stats', 'facts']).duration);
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(4);
    }
  });

  it('never cuts faster than two beats a photo, even when that runs long', () => {
    const tl = buildTimeline(shotsOf(MAX_PHOTOS), 118, null, ['stats', 'facts', 'people', 'race']);
    for (const s of tl.segments) if (s.kind === 'shot') expect((s.end - s.start) / tl.beat).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  it('keeps every page on to about 45 seconds with the usual 18 photos', () => {
    const tl = buildTimeline(shotsOf(18), 118, null, ['race', 'stats', 'facts', 'people']);
    expect(tl.segments.filter(s => s.kind !== 'shot').map(s => s.kind)).toEqual(['intro', 'stats', 'facts', 'people', 'race', 'outro']);
    expect(tl.duration).toBeLessThanOrEqual(48);
    const bare = buildTimeline(shotsOf(18), 118, null, []);
    expect(bare.segments.some(s => s.kind === 'stats')).toBe(false);
    expect(bare.duration).toBeLessThanOrEqual(46.5);
  });

  it('cuts on beats and starts the stats on a new bar', () => {
    const tl = buildTimeline(shotsOf(17), 118, null, ['stats', 'facts', 'race']);
    for (const s of tl.segments) expect(Math.abs(s.start / tl.beat - Math.round(s.start / tl.beat))).toBeLessThan(1e-9);
    expect(tl.marks.stats % 4).toBe(0);
    expect(tl.marks.outro % 4).toBe(0);
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
