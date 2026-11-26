import { describe, expect, it } from 'vitest';
import type { Trip } from '../../types';
import {
  applyLayout, defaultGroups, layoutFromGroups, moveItem, orderSiblings, sameOrder, sanitizeLayout, UNCATEGORIZED,
} from './homeLayout';

const trip = (id: string, category: string | null, created: string, archived = false): Trip => ({
  id, name: id, members: ['a'], categories: [], category, base_currency: 'TWD', rates: { TWD: 1 },
  precision_config: {}, is_archived: archived, created_at: `${created}T00:00:00Z`,
});

const trips = [
  trip('family-old', '家族', '2024-01-01', true),
  trip('family-new', '家族', '2026-05-01'),
  trip('friends', '朋友', '2026-08-01'),
  trip('loose', null, '2026-10-01'),
  trip('all-archived', '密室', '2026-09-01', true),
];

const shape = (groups: ReturnType<typeof defaultGroups>) => groups.map(g => [g.category, g.trips.map(t => t.id)]);

describe('defaultGroups', () => {
  it('sorts groups by newest active trip, archived-only groups after, 未分類 last', () => {
    expect(shape(defaultGroups(trips))).toEqual([
      ['朋友', ['friends']],
      ['家族', ['family-new', 'family-old']],
      ['密室', ['all-archived']],
      [UNCATEGORIZED, ['loose']],
    ]);
  });

  it('puts active trips before archived ones inside a group, regardless of input order', () => {
    const list = [trip('x-arch', 'G', '2026-12-01', true), trip('x-old', 'G', '2020-01-01'), trip('x-new', 'G', '2025-01-01')];
    expect(shape(defaultGroups(list))).toEqual([['G', ['x-new', 'x-old', 'x-arch']]]);
  });
});

describe('applyLayout', () => {
  it('is the default order without a layout', () => {
    expect(applyLayout(trips, null)).toEqual(defaultGroups(trips));
  });

  it('round-trips a custom order', () => {
    const custom = [...defaultGroups(trips)].reverse().map(g => ({ ...g, trips: [...g.trips].reverse() }));
    expect(shape(applyLayout(trips, layoutFromGroups(custom)))).toEqual(shape(custom));
  });

  it('puts new groups and new active trips on top, new archived trips and a new 未分類 at the bottom', () => {
    const layout = { groups: ['家族', '朋友'], trips: { 家族: ['family-old', 'family-new'] } };
    const more = [...trips, trip('family-newest', '家族', '2026-11-01'), trip('family-arch2', '家族', '2023-01-01', true)];
    expect(shape(applyLayout(more, layout))).toEqual([
      ['密室', ['all-archived']],
      ['家族', ['family-newest', 'family-old', 'family-new', 'family-arch2']],
      ['朋友', ['friends']],
      [UNCATEGORIZED, ['loose']],
    ]);
  });

  it('ignores stale ids and groups that no longer exist', () => {
    const layout = { groups: ['gone', '朋友', '家族'], trips: { 家族: ['deleted', 'family-new', 'family-old'], gone: ['x'] } };
    expect(shape(applyLayout(trips, layout)).slice(0, 3)).toEqual([
      ['密室', ['all-archived']],
      ['朋友', ['friends']],
      ['家族', ['family-new', 'family-old']],
    ]);
  });
});

describe('sameOrder / layoutFromGroups', () => {
  it('detects changes', () => {
    const a = defaultGroups(trips);
    expect(sameOrder(a, defaultGroups(trips))).toBe(true);
    expect(sameOrder(a, moveItem(a, 0, 1))).toBe(false);
  });
});

describe('sanitizeLayout', () => {
  it('rejects garbage', () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout('x')).toBeNull();
    expect(sanitizeLayout({ trips: {} })).toBeNull();
  });

  it('drops non-string entries', () => {
    expect(sanitizeLayout({ groups: ['a', 1, null], trips: { a: ['x', 2], b: 'nope' } }))
      .toEqual({ groups: ['a'], trips: { a: ['x'] } });
  });
});

describe('moveItem', () => {
  it('moves and clamps', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, -5)).toEqual([3, 1, 2]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
  });
});

describe('orderSiblings', () => {
  it('follows the saved order of that group', () => {
    const sibs = [trip('b', 'G', '2026-01-01'), trip('a', 'G', '2025-01-01')];
    expect(orderSiblings(sibs, 'G', { groups: ['G'], trips: { G: ['a', 'b'] } }).map(t => t.id)).toEqual(['a', 'b']);
    expect(orderSiblings(sibs, 'G', null).map(t => t.id)).toEqual(['b', 'a']);
  });
});
