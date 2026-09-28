import { describe, it, expect } from 'vitest';
import { getDefaultCategory, getDefaultCurrency } from './tripDefaults';
import { buildQuickAddDraft } from './quickAdd';
import type { Trip } from '../types';

const trip: Trip = {
  id: 't1',
  name: '測試旅程',
  access_code: null,
  members: ['代杰', 'Amy'],
  categories: ['餐飲', '交通'],
  base_currency: 'TWD',
  rates: { JPY: 0.21 },
  precision_config: { TWD: 0, JPY: 0 },
  is_archived: false,
  created_at: '2026-09-01T00:00:00Z',
};

describe('getDefaultCurrency', () => {
  it('rates 裡有的幣別照用', () => {
    expect(getDefaultCurrency({ ...trip, default_currency: 'JPY' })).toBe('JPY');
  });

  it('主幣別就算不在 rates 裡也照用 —— 它的匯率依定義是 1', () => {
    expect(getDefaultCurrency({ ...trip, default_currency: 'TWD' })).toBe('TWD');
  });

  it('已經被刪掉匯率的幣別退回主幣別，不能記在沒有匯率的幣別上', () => {
    expect(getDefaultCurrency({ ...trip, default_currency: 'USD' })).toBe('TWD');
  });

  it('沒設定就用主幣別', () => {
    expect(getDefaultCurrency(trip)).toBe('TWD');
  });
});

describe('getDefaultCategory', () => {
  it('在清單裡的分類照用', () => {
    expect(getDefaultCategory({ ...trip, default_category: '交通' })).toBe('交通');
  });

  it('已經從清單移除的分類退回第一個分類', () => {
    expect(getDefaultCategory({ ...trip, default_category: '購物' })).toBe('餐飲');
  });

  it('分類清單是空的就用「其他」', () => {
    expect(getDefaultCategory({ categories: [], default_category: '購物' })).toBe('其他');
  });
});

describe('buildQuickAddDraft 不採用失效的預設值', () => {
  it('預設幣別與分類都失效時退回主幣別與第一個分類', () => {
    const draft = buildQuickAddDraft('拉麵 300', { ...trip, default_currency: 'USD', default_category: '購物' }, '代杰');
    expect(draft?.currency).toBe('TWD');
    expect(draft?.category).toBe('餐飲');
  });
});
