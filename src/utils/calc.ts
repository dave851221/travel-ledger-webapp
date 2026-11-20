import Decimal from 'decimal.js';

/**
 * Arithmetic for the amount calculator (ExpenseModal).
 *
 * The expression is a plain string of digits, `.`, the operators `+ − × ÷`
 * (ASCII `+ - * /` are accepted too) and parentheses. Everything is computed
 * with decimal.js so `0.1 + 0.2` is exactly `0.3`.
 */

export const CALC_OPERATORS = ['+', '−', '×', '÷'] as const;
export type CalcOperator = (typeof CALC_OPERATORS)[number];

const normalize = (expr: string) =>
  expr.replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−').replace(/\s+/g, '');

type Token = { kind: 'num'; value: Decimal } | { kind: 'op'; value: CalcOperator } | { kind: 'paren'; value: '(' | ')' };

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const raw = expr.slice(i, j);
      if ((raw.match(/\./g) ?? []).length > 1 || raw === '.') return null;
      tokens.push({ kind: 'num', value: new Decimal(raw.startsWith('.') ? `0${raw}` : raw) });
      i = j;
    } else if ((CALC_OPERATORS as readonly string[]).includes(ch)) {
      tokens.push({ kind: 'op', value: ch as CalcOperator });
      i++;
    } else if (ch === '(' || ch === ')') {
      tokens.push({ kind: 'paren', value: ch });
      i++;
    } else {
      return null;
    }
  }
  return tokens;
}

/** Recursive-descent parser: expr := term (± term)* ; term := factor (×÷ factor)* ; factor := −factor | num | (expr) */
function parse(tokens: Token[]): Decimal | null {
  let pos = 0;
  const peek = () => tokens[pos];

  const factor = (): Decimal | null => {
    const t = peek();
    if (!t) return null;
    if (t.kind === 'op' && (t.value === '−' || t.value === '+')) {
      pos++;
      const v = factor();
      return v && (t.value === '−' ? v.negated() : v);
    }
    if (t.kind === 'num') {
      pos++;
      return t.value;
    }
    if (t.kind === 'paren' && t.value === '(') {
      pos++;
      const v = expr();
      const close = peek();
      // A missing ")" at the very end is forgiven, like a pocket calculator
      if (close?.kind === 'paren' && close.value === ')') pos++;
      else if (close) return null;
      return v;
    }
    return null;
  };

  const term = (): Decimal | null => {
    let left = factor();
    while (left) {
      const t = peek();
      if (t?.kind !== 'op' || (t.value !== '×' && t.value !== '÷')) break;
      pos++;
      const right = factor();
      if (!right) return null;
      if (t.value === '÷' && right.isZero()) return null;
      left = t.value === '×' ? left.times(right) : left.dividedBy(right);
    }
    return left;
  };

  const expr = (): Decimal | null => {
    let left = term();
    while (left) {
      const t = peek();
      if (t?.kind !== 'op' || (t.value !== '+' && t.value !== '−')) break;
      pos++;
      const right = term();
      if (!right) return null;
      left = t.value === '+' ? left.plus(right) : left.minus(right);
    }
    return left;
  };

  const result = expr();
  return result && pos === tokens.length ? result : null;
}

/**
 * Evaluates the expression, or returns null when it is empty, incomplete or
 * invalid (dividing by zero included). A trailing operator is ignored so the
 * live preview keeps showing the last good value while the user types.
 */
export function evaluateExpression(input: string): Decimal | null {
  let expr = normalize(input);
  while (expr && (CALC_OPERATORS as readonly string[]).includes(expr[expr.length - 1])) expr = expr.slice(0, -1);
  if (!expr) return null;
  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return null;
  const v = parse(tokens);
  return v && v.isFinite() ? v : null;
}

/** True when the expression has an operator, i.e. there is something to compute. */
export const hasOperation = (input: string) => /[+×÷*/()]|.[−-]/.test(normalize(input));

/**
 * Appends one key press to the expression, keeping it well-formed:
 * a second operator replaces the first, `.` cannot repeat inside a number,
 * a leading zero is replaced by the next digit.
 */
export function appendKey(expr: string, key: string): string {
  const last = expr[expr.length - 1] ?? '';
  const isOp = (c: string) => (CALC_OPERATORS as readonly string[]).includes(c);
  if (isOp(key)) {
    if (!expr || last === '(') return key === '−' ? expr + key : expr;
    if (isOp(last)) {
      const trimmed = expr.slice(0, -1);
      // "(" followed by a lone "−" can only become "−" again, or be dropped
      if (!trimmed || trimmed.endsWith('(')) return key === '−' ? expr : trimmed;
      return trimmed + key;
    }
    return expr + key;
  }
  if (key === '.') {
    const current = expr.split(/[+−×÷()]/).pop() ?? '';
    if (current.includes('.')) return expr;
    if (last === ')') return expr;
    return expr + (current === '' ? '0.' : '.');
  }
  if (key === '(') return /[0-9.)]/.test(last) ? `${expr}×(` : `${expr}(`;
  if (key === ')') {
    const open = (expr.match(/\(/g) ?? []).length - (expr.match(/\)/g) ?? []).length;
    if (open <= 0 || isOp(last) || last === '(' || !last) return expr;
    return `${expr})`;
  }
  if (/^[0-9]$/.test(key) || key === '00') {
    if (last === ')') return `${expr}×${key === '00' ? '0' : key}`;
    const current = expr.split(/[+−×÷()]/).pop() ?? '';
    if (current === '0') return expr.slice(0, -1) + (key === '00' ? '0' : key);
    if (current === '' && key === '00') return `${expr}0`;
    return expr + key;
  }
  return expr;
}

/** Shows a computed value as plain digits (no exponent), trimmed to `decimals` places. */
export const formatCalcResult = (v: Decimal, decimals: number) =>
  v.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed();
