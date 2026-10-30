import { describe, it, expect } from 'vitest';
import { toTripRates } from './exchangeRates';

describe('toTripRates', () => {
  it('把「1 主幣別 = ? 外幣」轉成「1 外幣 = ? 主幣別」', () => {
    const { rates } = toTripRates({ TWD: 1, JPY: 4.847731, USD: 0.03072 }, ['TWD', 'JPY', 'USD'], 'TWD');
    expect(rates).toEqual({ JPY: '0.206282', USD: '32.5521' });
  });

  it('主幣別不輸出（它對自己的匯率依定義是 1）', () => {
    const { rates } = toTripRates({ TWD: 1, JPY: 5 }, ['TWD', 'JPY'], 'TWD');
    expect(rates).not.toHaveProperty('TWD');
  });

  it('來源沒有或數值不合理的幣別列為 missing，不給匯率', () => {
    const { rates, missing } = toTripRates({ JPY: 5, XXX: 0 }, ['JPY', 'XXX', 'ABC'], 'TWD');
    expect(rates).toEqual({ JPY: '0.2' });
    expect(missing).toEqual(['XXX', 'ABC']);
  });
});
