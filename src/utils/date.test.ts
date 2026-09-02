import { describe, it, expect } from 'vitest';
import { getLocalDateString } from './date';

describe('getLocalDateString', () => {
  it('回傳 YYYY-MM-DD 格式', () => {
    expect(getLocalDateString(new Date(2026, 8, 2))).toBe('2026-09-02');
  });

  it('月與日補零', () => {
    expect(getLocalDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('用當地時間而非 UTC —— 這正是這個函式存在的理由', () => {
    // UTC+8 的凌晨 0:30，toISOString() 會退回前一天，getLocalDateString 不應該
    const d = new Date(2026, 8, 2, 0, 30);
    expect(getLocalDateString(d)).toBe('2026-09-02');
  });

  it('當地時間深夜也維持在同一天', () => {
    expect(getLocalDateString(new Date(2026, 8, 2, 23, 59))).toBe('2026-09-02');
  });

  it('不帶參數時使用今天', () => {
    expect(getLocalDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('跨年邊界', () => {
    expect(getLocalDateString(new Date(2026, 11, 31))).toBe('2026-12-31');
    expect(getLocalDateString(new Date(2027, 0, 1))).toBe('2027-01-01');
  });
});
