import { formatAmount } from './finance';

/**
 * Display helpers for money. Rounding is still done by `formatAmount`
 * (Decimal, per-currency precision); these only add grouping and a symbol,
 * working on the string so no float ever touches the value.
 */

const SYMBOLS: Record<string, string> = {
  TWD: 'NT$',
  JPY: '¥',
  CNY: 'CN¥',
  USD: 'US$',
  EUR: '€',
  GBP: '£',
  KRW: '₩',
  HKD: 'HK$',
  THB: '฿',
  SGD: 'S$',
  AUD: 'A$',
  VND: '₫',
};

export const currencySymbol = (currency: string): string => SYMBOLS[currency] ?? `${currency} `;

/** Adds thousands separators to a plain decimal string such as "-12345.60". */
export const groupDigits = (plain: string): string => {
  const negative = plain.startsWith('-');
  const unsigned = negative ? plain.slice(1) : plain;
  const [int, frac] = unsigned.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`;
};

/** "12,345" — rounded to the currency's precision, grouped, no symbol. */
export const formatNumber = (
  amount: number,
  currency: string,
  precision: Record<string, number> = {},
): string => groupDigits(formatAmount(amount, currency, precision));

export interface FormatMoneyOptions {
  /** Prefix "+" on positive amounts (balances). Negatives always get "−". */
  signed?: boolean;
}

/** "NT$12,345", "¥4,560", "−€12.50". */
export const formatMoney = (
  amount: number,
  currency: string,
  precision: Record<string, number> = {},
  { signed = false }: FormatMoneyOptions = {},
): string => {
  const plain = formatAmount(amount, currency, precision);
  const isNegative = plain.startsWith('-') && /[1-9]/.test(plain);
  const isPositive = !plain.startsWith('-') && /[1-9]/.test(plain);
  const digits = groupDigits(plain.replace(/^-/, ''));
  const sign = isNegative ? '−' : signed && isPositive ? '+' : '';
  return `${sign}${currencySymbol(currency)}${digits}`;
};
