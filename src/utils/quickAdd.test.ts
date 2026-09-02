import { describe, it, expect } from 'vitest';
import { parseQuickAddInput, buildQuickAddDraft } from './quickAdd';
import type { Trip } from '../types';

const trip: Trip = {
  id: 't1',
  name: '測試旅程',
  access_code: null,
  members: ['代杰', 'Amy', 'Bob'],
  categories: ['餐飲', '交通', '其他'],
  base_currency: 'TWD',
  rates: { TWD: 1, JPY: 0.21 },
  precision_config: { TWD: 0, JPY: 0 },
  is_archived: false,
  created_at: '2026-09-01T00:00:00Z',
};

describe('parseQuickAddInput', () => {
  it('把最後一個數字當金額，其餘當描述', () => {
    expect(parseQuickAddInput('拉麵 3000')).toEqual({ description: '拉麵', amount: 3000 });
  });

  it('金額寫在前面也能解析', () => {
    expect(parseQuickAddInput('3000 拉麵')).toEqual({ description: '拉麵', amount: 3000 });
  });

  it('描述中含數字時取最後一個數字 —— 7-11 咖啡 55 的金額是 55', () => {
    expect(parseQuickAddInput('7-11 咖啡 55')).toEqual({ description: '7-11 咖啡', amount: 55 });
  });

  it('支援千分位逗號', () => {
    expect(parseQuickAddInput('住宿 12,500')).toEqual({ description: '住宿', amount: 12500 });
  });

  it('支援小數', () => {
    expect(parseQuickAddInput('咖啡 4.5')).toEqual({ description: '咖啡', amount: 4.5 });
  });

  it('沒有空格也能拆開', () => {
    expect(parseQuickAddInput('晚餐1200')).toEqual({ description: '晚餐', amount: 1200 });
  });

  it('只有金額時描述為空字串', () => {
    expect(parseQuickAddInput('500')).toEqual({ description: '', amount: 500 });
  });

  it('沒有數字時回傳 null', () => {
    expect(parseQuickAddInput('拉麵')).toBeNull();
  });

  it('空字串回傳 null', () => {
    expect(parseQuickAddInput('   ')).toBeNull();
  });

  it('金額為 0 或負數時回傳 null', () => {
    expect(parseQuickAddInput('退款 0')).toBeNull();
  });

  it('多餘空白會被收斂', () => {
    expect(parseQuickAddInput('  機場   接送   800 ')).toEqual({
      description: '機場 接送',
      amount: 800,
    });
  });
});

describe('buildQuickAddDraft', () => {
  it('套用旅程預設值：主幣別、第一個分類、全員均分', () => {
    const draft = buildQuickAddDraft('拉麵 3000', trip, '代杰')!;
    expect(draft.description).toBe('拉麵');
    expect(draft.amount).toBe(3000);
    expect(draft.currency).toBe('TWD');
    expect(draft.category).toBe('餐飲');
    expect(draft.payer_data).toEqual({ 代杰: 3000 });
    expect(draft.split_data).toEqual({ 代杰: 1000, Amy: 1000, Bob: 1000 });
  });

  it('分帳總和永遠等於金額（含除不盡的情況）', () => {
    const draft = buildQuickAddDraft('午餐 1000', trip, 'Amy')!;
    const sum = Object.values(draft.split_data).reduce((a, b) => a + b, 0);
    expect(sum).toBe(1000);
    // 1000 / 3 除不盡，餘數歸給目前使用者
    expect(draft.adjustment_member).toBe('Amy');
    expect(draft.split_data.Amy).toBeGreaterThan(draft.split_data.Bob);
  });

  it('尊重旅程設定的預設付款人與預設分攤成員', () => {
    const draft = buildQuickAddDraft('計程車 600', {
      ...trip,
      default_payer: ['Bob'],
      default_split_members: ['代杰', 'Bob'],
    }, '代杰')!;
    expect(draft.payer_data).toEqual({ Bob: 600 });
    expect(draft.split_data).toEqual({ 代杰: 300, Bob: 300 });
  });

  it('尊重旅程設定的預設幣別與預設分類', () => {
    const draft = buildQuickAddDraft('壽司 4000', {
      ...trip,
      default_currency: 'JPY',
      default_category: '其他',
    }, '代杰')!;
    expect(draft.currency).toBe('JPY');
    expect(draft.category).toBe('其他');
  });

  it('描述留空時用分類名代入', () => {
    expect(buildQuickAddDraft('500', trip, '代杰')!.description).toBe('餐飲');
  });

  it('沒有身分時退回第一位成員當付款人', () => {
    expect(buildQuickAddDraft('晚餐 900', trip, null)!.payer_data).toEqual({ 代杰: 900 });
  });

  it('身分不在成員名單中時也退回第一位成員', () => {
    expect(buildQuickAddDraft('晚餐 900', trip, '路人')!.payer_data).toEqual({ 代杰: 900 });
  });

  it('解析不出金額時回傳 null', () => {
    expect(buildQuickAddDraft('拉麵', trip, '代杰')).toBeNull();
  });

  it('日期為今天', () => {
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(buildQuickAddDraft('晚餐 100', trip, '代杰')!.date).toBe(expected);
  });
});
