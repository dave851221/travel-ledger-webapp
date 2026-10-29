import { describe, it, expect } from 'vitest';
import { buildSummaryCard, expenseSections, formatMoney, shortDate, totalRows } from './summary-cards.ts';
import { sumByCurrency } from '../_shared/finance.ts';

const PRECISION = { JPY: 0, TWD: 0, USD: 2 };

/** 整張卡片裡所有的 text 元件（LINE 拒收空字串，任何一個是空的整則訊息都送不出去） */
function texts(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(texts);
  const obj = node as Record<string, unknown>;
  const own = obj.type === 'text' ? [String(obj.text)] : [];
  return [...own, ...Object.values(obj).flatMap(texts)];
}

describe('summary cards', () => {
  it('金額加千分位與幣別符號，捨入照旅程精度', () => {
    expect(formatMoney(12345.6, 'TWD', PRECISION)).toBe('NT$12,346');
    expect(formatMoney(4800, 'JPY', PRECISION)).toBe('¥4,800');
    expect(formatMoney(12.5, 'USD', PRECISION)).toBe('US$12.50');
    expect(formatMoney(-3611, 'TWD', PRECISION)).toBe('−NT$3,611');
    expect(formatMoney(100, 'XYZ', PRECISION)).toBe('XYZ 100.00'); // 精度沒設的幣別預設 2 位
  });

  it('日期縮成「月/日（星期）」', () => {
    expect(shortDate('2026-11-16')).toBe('11/16（一）');
  });

  it('依日期分段，超過上限的筆數回報出來', () => {
    const rows = [
      { description: '拉麵', amount: 4800, currency: 'JPY', date: '2026-11-16' },
      { description: '壽喜燒', amount: 6620, currency: 'JPY', date: '2026-11-16' },
      { description: '地鐵', amount: 600, currency: 'JPY', date: '2026-11-15' },
    ];
    const { sections, omitted } = expenseSections(rows, PRECISION, { groupByDate: true, showCategory: false, maxRows: 2 });
    expect(sections).toEqual([{ heading: '11/16（一）', rows: [
      { label: '拉麵', sub: undefined, value: '¥4,800' },
      { label: '壽喜燒', sub: undefined, value: '¥6,620' },
    ] }]);
    expect(omitted).toBe(1);
  });

  it('多幣別的合計：第一列寫筆數，其餘列沒有標籤', () => {
    const rows = [{ amount: 4800, currency: 'JPY' }, { amount: 300, currency: 'TWD' }];
    expect(totalRows(sumByCurrency(rows), 2, PRECISION)).toEqual([
      { label: '共 2 筆', value: '¥4,800' },
      { label: '', value: 'NT$300' },
    ]);
  });

  it('卡片裡沒有任何空字串的 text', () => {
    const card = buildSummaryCard({
      title: '📅 今日支出',
      sections: [{ rows: [{ label: '', value: '¥1' }, { label: '拉麵', sub: '', value: '¥2' }] }],
      totals: [{ label: '共 2 筆', value: '¥3' }, { label: '', value: 'NT$1' }],
      notes: [],
      webUrl: 'https://example.com',
      altText: '今日支出',
    });
    expect(texts(card).every((t) => t.length > 0)).toBe(true);
    expect(card.altText).toBe('今日支出');
  });
});
