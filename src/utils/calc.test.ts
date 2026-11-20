import { describe, it, expect } from 'vitest';
import { appendKey, evaluateExpression, formatCalcResult, hasOperation } from './calc';

const ev = (s: string) => evaluateExpression(s)?.toString() ?? null;

describe('evaluateExpression', () => {
  it('respects operator precedence and parentheses', () => {
    expect(ev('1+2×3')).toBe('7');
    expect(ev('(1+2)×3')).toBe('9');
    expect(ev('10−4−3')).toBe('3');
    expect(ev('100÷4÷5')).toBe('5');
    expect(ev('2*3+8/4-1')).toBe('7');
  });

  it('uses exact decimals', () => {
    expect(ev('0.1+0.2')).toBe('0.3');
    expect(ev('1200×1.1')).toBe('1320');
  });

  it('handles unary minus and a forgiven closing paren', () => {
    expect(ev('−5+8')).toBe('3');
    expect(ev('3×(−2)')).toBe('-6');
    expect(ev('(1+2')).toBe('3');
  });

  it('ignores a trailing operator', () => {
    expect(ev('12+')).toBe('12');
    expect(ev('12×3−')).toBe('36');
  });

  it('returns null for invalid input', () => {
    expect(ev('')).toBeNull();
    expect(ev('5÷0')).toBeNull();
    expect(ev('1..2')).toBeNull();
    expect(ev('abc')).toBeNull();
    expect(ev('()')).toBeNull();
    expect(ev('1)')).toBeNull();
  });
});

describe('appendKey', () => {
  const type = (keys: string[]) => keys.reduce(appendKey, '');

  it('replaces a repeated operator', () => {
    expect(type(['1', '+', '×', '2'])).toBe('1×2');
  });

  it('does not start with a binary operator but allows a minus', () => {
    expect(type(['+'])).toBe('');
    expect(type(['−', '5'])).toBe('−5');
  });

  it('keeps one decimal point per number', () => {
    expect(type(['.', '5', '.', '1'])).toBe('0.51');
    expect(type(['1', '.', '5', '+', '.', '2'])).toBe('1.5+0.2');
  });

  it('drops a leading zero', () => {
    expect(type(['0', '7'])).toBe('7');
    expect(type(['5', '+', '0', '0', '3'])).toBe('5+3');
  });

  it('inserts implicit multiplication around parentheses', () => {
    expect(type(['2', '(', '3', '+', '1', ')', '4'])).toBe('2×(3+1)×4');
  });

  it('only closes an open, non-empty parenthesis', () => {
    expect(type([')'])).toBe('');
    expect(type(['(', ')'])).toBe('(');
    expect(type(['(', '1', '+', ')'])).toBe('(1+');
  });

  it('handles the 00 key', () => {
    expect(type(['1', '00'])).toBe('100');
    expect(type(['00'])).toBe('0');
  });
});

describe('hasOperation', () => {
  it('ignores a leading minus', () => {
    expect(hasOperation('−5')).toBe(false);
    expect(hasOperation('120')).toBe(false);
    expect(hasOperation('5−2')).toBe(true);
    expect(hasOperation('5×2')).toBe(true);
  });
});

describe('formatCalcResult', () => {
  it('rounds to the currency precision without exponent', () => {
    expect(formatCalcResult(evaluateExpression('1000÷3')!, 0)).toBe('333');
    expect(formatCalcResult(evaluateExpression('10÷3')!, 2)).toBe('3.33');
    expect(formatCalcResult(evaluateExpression('1.5')!, 0)).toBe('2');
  });
});
