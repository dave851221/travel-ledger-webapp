import { describe, expect, it } from 'vitest';
import { currencySymbol, formatMoney, formatNumber, groupDigits } from './money';

describe('groupDigits', () => {
  it('groups the integer part only', () => {
    expect(groupDigits('1234567.891')).toBe('1,234,567.891');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('-1000')).toBe('-1,000');
    expect(groupDigits('0.5')).toBe('0.5');
  });
});

describe('formatMoney', () => {
  const prec = { TWD: 0, JPY: 0, USD: 2 };

  it('rounds with the currency precision and adds the symbol', () => {
    expect(formatMoney(39600, 'JPY', prec)).toBe('¥39,600');
    expect(formatMoney(18600.4, 'TWD', prec)).toBe('NT$18,600');
    expect(formatMoney(12.5, 'USD', prec)).toBe('US$12.50');
  });

  it('uses a true minus sign and optional plus sign', () => {
    expect(formatMoney(-7980, 'TWD', prec)).toBe('−NT$7,980');
    expect(formatMoney(12670, 'TWD', prec, { signed: true })).toBe('+NT$12,670');
  });

  it('never signs a value that rounds to zero', () => {
    expect(formatMoney(-0.2, 'TWD', prec, { signed: true })).toBe('NT$0');
    expect(formatMoney(0, 'TWD', prec, { signed: true })).toBe('NT$0');
  });

  it('falls back to the ISO code for unknown currencies', () => {
    expect(currencySymbol('MYR')).toBe('MYR ');
    expect(formatMoney(10, 'MYR', { MYR: 2 })).toBe('MYR 10.00');
  });
});

describe('formatNumber', () => {
  it('formats without a symbol', () => {
    expect(formatNumber(23610, 'TWD', { TWD: 0 })).toBe('23,610');
  });
});
