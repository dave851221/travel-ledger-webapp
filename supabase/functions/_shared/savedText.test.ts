import { describe, it, expect } from 'vitest';
import { buildSavedText, MAX_LISTED_ITEMS, sanitizeItemOwners } from './savedText.ts';

const expense = {
  date: '2026-11-05',
  category: '餐飲',
  description: '居酒屋',
  amount: 3300,
  currency: 'JPY',
  payer_data: { 代杰: 3300 },
  split_data: { 代杰: 1650, 賢佑: 1650 },
};
const items = [
  { name: '雞皮', amount: 500 },
  { name: '啤酒', amount: 1000 },
  { name: '毛豆', amount: 1500 },
];

describe('buildSavedText', () => {
  it('lists title, amount, meta, payers, split and footer', () => {
    const text = buildSavedText(expense, { header: '✅ 已存入', footer: '（由 代杰 記錄）' });
    expect(text).toBe([
      '✅ 已存入：居酒屋',
      '💰 3300 JPY',
      '📅 2026-11-05 · 🏷️ 餐飲',
      '',
      '👛 付款人',
      '• 代杰 3300',
      '',
      '🧾 分帳明細',
      '• 代杰 1650',
      '• 賢佑 1650',
      '',
      '（由 代杰 記錄）',
    ].join('\n'));
  });

  it('lists receipt items when nobody knows who had what', () => {
    const text = buildSavedText(expense, { header: '✅ 已存入', titleSuffix: '（只算 代杰）', items });
    expect(text.startsWith('✅ 已存入：居酒屋（只算 代杰）')).toBe(true);
    expect(text.endsWith('🛒 品項\n• 雞皮 500\n• 啤酒 1000\n• 毛豆 1500')).toBe(true);
  });

  it('writes each person\'s items next to their share instead of a separate list', () => {
    const text = buildSavedText(expense, {
      header: '✅ 已存入', items, itemOwners: [['賢佑'], ['代杰', '賢佑'], ['代杰']],
    });
    expect(text).toContain('• 代杰 1650（啤酒、毛豆）');
    expect(text).toContain('• 賢佑 1650（雞皮、啤酒）');
    expect(text).not.toContain('🛒 品項');
  });

  it('ignores owners that do not match the saved split', () => {
    const text = buildSavedText(expense, {
      header: '✅ 已存入', items, itemOwners: [['小明'], ['代杰'], ['代杰']],
    });
    expect(text).toContain('• 賢佑 1650\n');
    expect(text).toContain('🛒 品項');
  });

  it('puts the note after the meta line', () => {
    const text = buildSavedText(expense, { header: '✏️ 已修改', titleSuffix: '（由 代杰 修改）', note: '改了：金額' });
    expect(text.split('\n').slice(0, 4)).toEqual([
      '✏️ 已修改：居酒屋（由 代杰 修改）', '💰 3300 JPY', '📅 2026-11-05 · 🏷️ 餐飲', '改了：金額',
    ]);
  });

  it('caps long item lists', () => {
    const many = Array.from({ length: MAX_LISTED_ITEMS + 3 }, (_, i) => ({ name: `品項${i}`, amount: 100 }));
    const text = buildSavedText(expense, { header: '✅ 已存入', items: many });
    expect(text.endsWith('…另外 3 項')).toBe(true);
  });
});

describe('sanitizeItemOwners', () => {
  it('keeps arrays of names and drops junk', () => {
    expect(sanitizeItemOwners([['a', ''], 'x', ['b']])).toEqual([['a'], [], ['b']]);
    expect(sanitizeItemOwners('nope')).toBeUndefined();
    expect(sanitizeItemOwners([])).toBeUndefined();
  });
});
