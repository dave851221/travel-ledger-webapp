import { describe, expect, it } from 'vitest';
import {
  availableViews, dateParts, defineItinerary, flattenNotes, isValidTime, itemStates, linkPlaceNames,
  nightsBetween, nowIn, parseRichText, plainText, startMinutes, unlinkedPlaces,
} from './plan';
import { ITINERARIES, isPlan } from './registry';
import { THEMES } from './themes';
import type { ItineraryItem, ItineraryPlan } from './types';

const plan = (over: Partial<ItineraryPlan> = {}): ItineraryPlan => defineItinerary({
  title: 't', theme: 'default',
  days: [{ date: '2026-01-01', title: 'd1', items: [] }],
  ...over,
});
const days = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `2026-01-0${i + 1}`, title: `d${i + 1}`, items: [] }));

describe('availableViews', () => {
  it('shows only the daily view for a short trip with nothing else', () => {
    expect(availableViews(plan({ days: days(2) }))).toEqual(['daily']);
  });

  it('adds the overview from three days on', () => {
    expect(availableViews(plan({ days: days(3) }))).toEqual(['overview', 'daily']);
  });

  it('adds prep when there are flights, bookings, a checklist or notes', () => {
    expect(availableViews(plan({ days: days(2), flights: [{ label: '去程', date: '2026-01-01', depart: '10:00' }] }))).toContain('prep');
    expect(availableViews(plan({ days: days(2), checklist: { storageKey: 'k', items: ['護照'] } }))).toContain('prep');
  });

  it('does not open a prep tab just for the hotel of a two-day trip', () => {
    const stays = [{ id: 'h', name: 'H', checkIn: '2026-01-01', checkOut: '2026-01-02' }];
    expect(availableViews(plan({ days: days(2), stays }))).toEqual(['daily']);
    expect(availableViews(plan({ days: days(3), stays }))).toContain('prep');
  });
});

describe('time helpers', () => {
  it('validates times and ranges', () => {
    expect(isValidTime('09:00')).toBe(true);
    expect(isValidTime('13:30–16:55')).toBe(true);
    expect(isValidTime('9:00')).toBe(false);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('10:00~11:00')).toBe(false);
  });

  it('reads the start of a time window', () => {
    expect(startMinutes({ kind: 'info', title: '', time: '13:30–16:55' })).toBe(810);
    expect(startMinutes({ kind: 'info', title: '', slot: '早上' })).toBeNull();
  });

  it('marks done / now / next and leaves slot-only items alone', () => {
    const items: ItineraryItem[] = [
      { kind: 'food', title: 'a', time: '08:00' },
      { kind: 'sight', title: 'b', time: '10:00' },
      { kind: 'sight', title: 'c', slot: '下午' },
      { kind: 'food', title: 'd', time: '18:00' },
      { kind: 'food', title: 'e', time: '20:00' },
    ];
    expect(itemStates(items, 11 * 60)).toEqual(['done', 'now', null, 'next', null]);
    expect(itemStates(items, 7 * 60)).toEqual(['next', null, null, null, null]);
  });

  it("computes today's date in another time zone", () => {
    const at = new Date('2026-11-14T16:30:00Z'); // 01:30 the next day in Tokyo
    expect(nowIn('Asia/Tokyo', at)).toEqual({ date: '2026-11-15', minutes: 90 });
    expect(nowIn('Not/AZone', at).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('dates', () => {
  it('formats month/day and weekday without timezone drift', () => {
    expect(dateParts('2026-11-14')).toEqual({ md: '11/14', weekday: '六' });
  });
  it('counts nights', () => {
    expect(nightsBetween('2026-11-17', '2026-11-22')).toBe(5);
  });
});

describe('rich text', () => {
  it('splits links and bold out of a string', () => {
    expect(parseRichText('到[兼六園](https://x.y/z)看**櫻花**')).toEqual([
      { type: 'text', text: '到' },
      { type: 'link', text: '兼六園', href: 'https://x.y/z' },
      { type: 'text', text: '看' },
      { type: 'bold', text: '櫻花' },
    ]);
    expect(plainText('到[兼六園](https://x.y/z)')).toBe('到兼六園');
  });

  it('leaves non-http links literal', () => {
    expect(parseRichText('[x](javascript:alert(1))')).toEqual([{ type: 'text', text: '[x](javascript:alert(1))' }]);
  });

  it('links place names inside a title, longest name first', () => {
    const segs = linkPlaceNames(parseRichText('日本橋 → 道頓堀'), [{ name: '日本橋' }, { name: '道頓堀', href: 'https://m/d' }]);
    expect(segs.map(s => s.type)).toEqual(['link', 'text', 'link']);
    expect(segs[2]).toMatchObject({ text: '道頓堀', href: 'https://m/d' });
    expect(unlinkedPlaces('密室《時光列車》', [{ name: '哇沙謎江戶時代館' }])).toHaveLength(1);
  });
});

/**
 * 每一份已登記的行程都要通過這些檢查。AI 寫新行程時最常犯的錯在這裡都會被擋下來。
 */
describe.each(Object.entries(ITINERARIES).filter(([, e]) => isPlan(e)))('itinerary %s', (_id, entry) => {
  const p = entry as ItineraryPlan;
  const allText = [
    ...p.days.flatMap(d => [d.title, ...flattenNotes(d.tips), ...d.items.flatMap(it => [it.title, ...flattenNotes(it.notes)])]),
    ...flattenNotes(p.notes),
    ...(p.stays ?? []).flatMap(s => flattenNotes(s.notes)),
    ...(p.bookings ?? []).map(b => b.item),
  ];

  it('uses a known theme', () => {
    expect(Object.keys(THEMES)).toContain(p.theme);
  });

  it('has days in order, one per date, with valid dates', () => {
    expect(p.days.length).toBeGreaterThan(0);
    p.days.forEach(d => expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/));
    const dates = p.days.map(d => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('gives every item a time or a slot, with times in order within a day', () => {
    p.days.forEach(d => {
      let last = -1;
      d.items.forEach(it => {
        expect(it.time || it.slot, `${d.date} ${it.title}`).toBeTruthy();
        if (it.time) {
          expect(isValidTime(it.time), `${d.date} ${it.time}`).toBe(true);
          const s = startMinutes(it)!;
          expect(s, `${d.date} ${it.title} 的時間比前一項早`).toBeGreaterThanOrEqual(last);
          last = s;
        }
      });
    });
  });

  it('only refers to stays that exist, and stays have sane dates', () => {
    const ids = new Set((p.stays ?? []).map(s => s.id));
    expect(ids.size).toBe((p.stays ?? []).length);
    p.days.forEach(d => { if (d.stay) expect(ids.has(d.stay), `${d.date} stay ${d.stay}`).toBe(true); });
    (p.stays ?? []).forEach(s => expect(nightsBetween(s.checkIn, s.checkOut), s.name).toBeGreaterThan(0));
  });

  it('writes links as [label](https://…) only', () => {
    allText.forEach(t => {
      // a "[label](" that did not parse into a link means a typo in the URL
      const leftover = parseRichText(t).filter(s => s.type === 'text').some(s => /\]\(/.test(s.text));
      expect(leftover, t).toBe(false);
    });
    [...p.days.flatMap(d => d.items.flatMap(it => it.places ?? [])), ...(p.stays ?? [])].forEach(x => {
      if (x.href) expect(x.href).toMatch(/^https:\/\//);
    });
  });

  it('keeps route coordinates on the globe', () => {
    p.days.forEach(d => (d.route ?? []).forEach(([lat, lng]) => {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lng)).toBeLessThanOrEqual(180);
    }));
  });
});

it('gives every checklist its own storage key', () => {
  const keys = Object.values(ITINERARIES).filter(isPlan).map(p => p.checklist?.storageKey).filter(Boolean);
  expect(new Set(keys).size).toBe(keys.length);
});
