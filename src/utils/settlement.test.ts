import { describe, it, expect } from 'vitest';
import { calculateSettlements } from './settlement';

describe('calculateSettlements', () => {
  it('兩人單向：欠錢的直接付給該收錢的', () => {
    expect(calculateSettlements({ A: -100, B: 100 }))
      .toEqual([{ from: 'A', to: 'B', amount: 100 }]);
  });

  it('全員已結清時不產生任何轉帳', () => {
    expect(calculateSettlements({ A: 0, B: 0, C: 0 })).toEqual([]);
  });

  it('三人情境：轉帳次數不超過人數減一', () => {
    const r = calculateSettlements({ A: -50, B: -50, C: 100 });
    expect(r).toHaveLength(2);
    expect(r.every((s) => s.to === 'C')).toBe(true);
    expect(r.reduce((sum, s) => sum + s.amount, 0)).toBe(100);
  });

  it('金額最大的債務人優先對上金額最大的債權人', () => {
    const r = calculateSettlements({ A: -80, B: -20, C: 70, D: 30 });
    expect(r[0]).toEqual({ from: 'A', to: 'C', amount: 70 });
  });

  it('轉出總額與轉入總額相等', () => {
    const balances = { A: -120, B: -30, C: 45, D: 105 };
    const total = calculateSettlements(balances).reduce((s, x) => s + x.amount, 0);
    expect(total).toBe(150);
  });

  it('小於 EPSILON(0.01) 的零頭視為已結清，不產生轉帳', () => {
    expect(calculateSettlements({ A: -0.005, B: 0.005 })).toEqual([]);
  });

  it('剛好等於 EPSILON 邊界時不轉帳（需嚴格大於）', () => {
    expect(calculateSettlements({ A: -0.01, B: 0.01 })).toEqual([]);
  });

  it('略大於 EPSILON 時才會產生轉帳', () => {
    const r = calculateSettlements({ A: -0.02, B: 0.02 });
    expect(r).toHaveLength(1);
    expect(r[0].amount).toBeCloseTo(0.02, 10);
  });

  it('空的結餘表回傳空陣列', () => {
    expect(calculateSettlements({})).toEqual([]);
  });

  it('債務與債權不平衡時，只結清到較小的那一邊為止', () => {
    // 總欠 100，但只有 60 的債權
    const r = calculateSettlements({ A: -100, B: 60 });
    expect(r).toEqual([{ from: 'A', to: 'B', amount: 60 }]);
  });

  it('不使用浮點數累加，避免 0.1+0.2 類誤差', () => {
    const r = calculateSettlements({ A: -0.3, B: 0.1, C: 0.2 });
    expect(r.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(0.3, 10);
  });
});
