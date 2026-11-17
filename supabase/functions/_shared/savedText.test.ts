import { describe, it, expect } from 'vitest';
import { buildSavedText } from './savedText.ts';

const expense = {
  date: '2026-11-05',
  category: '餐飲',
  description: '居酒屋',
  amount: 3300,
  currency: 'JPY',
  payer_data: { 代杰: 3300 },
  split_data: { 代杰: 1650, 賢佑: 1650 },
};

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

  it('appends the solo suffix to the title', () => {
    const text = buildSavedText(expense, { header: '✅ 已存入', titleSuffix: '（只算 代杰）' });
    expect(text.startsWith('✅ 已存入：居酒屋（只算 代杰）\n💰 3300 JPY')).toBe(true);
  });

  it('puts the note after the meta line', () => {
    const text = buildSavedText(expense, { header: '✏️ 已修改', titleSuffix: '（由 代杰 修改）', note: '改了：金額' });
    expect(text.split('\n').slice(0, 4)).toEqual([
      '✏️ 已修改：居酒屋（由 代杰 修改）', '💰 3300 JPY', '📅 2026-11-05 · 🏷️ 餐飲', '改了：金額',
    ]);
  });
});
