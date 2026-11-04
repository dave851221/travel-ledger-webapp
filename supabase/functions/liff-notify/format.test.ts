import { describe, it, expect } from 'vitest';
import { buildSavedText } from './format.ts';

describe('buildSavedText', () => {
  const expense = {
    date: '2026-11-05',
    category: '餐飲',
    description: '一蘭拉麵',
    amount: 3960,
    currency: 'JPY',
    payer_data: { 代杰: 3960 },
    split_data: { 代杰: 1980, 小明: 1980, 小華: 0 },
  };

  it('lists title, amount, category, payers and split', () => {
    const text = buildSavedText(expense, false);
    expect(text).toBe([
      '✅ 已透過 LIFF 存入：一蘭拉麵',
      '💰 3960 JPY',
      '📅 2026-11-05 · 🏷️ 餐飲',
      '',
      '👛 付款人',
      '• 代杰 3960',
      '',
      '🧾 分帳明細',
      '• 代杰 1980',
      '• 小明 1980',
    ].join('\n'));
  });

  it('uses the update header and currency precision', () => {
    const text = buildSavedText({ ...expense, amount: 12.5, currency: 'USD', payer_data: { 代杰: 12.5 }, split_data: {} }, true);
    expect(text.startsWith('✏️ 已透過 LIFF 更新：一蘭拉麵\n💰 12.50 USD')).toBe(true);
    expect(text).toContain('• 代杰 12.50');
    expect(text.endsWith('🧾 分帳明細\n• （無）')).toBe(true);
  });
});
