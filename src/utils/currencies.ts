/**
 * 常用幣別與中文名稱。建立旅程、設定頁的幣別選單用；不在清單上的幣別一樣可以自己輸入 3 碼代碼。
 * 代碼一律是 ISO 4217（LINE 機器人與收據辨識輸出的就是這個，見 SettingsModal 的 addCurrency）。
 */
export interface CurrencyInfo {
  code: string;
  name: string;
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'TWD', name: '新台幣' },
  { code: 'JPY', name: '日圓' },
  { code: 'KRW', name: '韓元' },
  { code: 'CNY', name: '人民幣' },
  { code: 'HKD', name: '港幣' },
  { code: 'MOP', name: '澳門幣' },
  { code: 'USD', name: '美元' },
  { code: 'EUR', name: '歐元' },
  { code: 'GBP', name: '英鎊' },
  { code: 'THB', name: '泰銖' },
  { code: 'SGD', name: '新加坡幣' },
  { code: 'MYR', name: '馬來西亞令吉' },
  { code: 'VND', name: '越南盾' },
  { code: 'PHP', name: '菲律賓披索' },
  { code: 'IDR', name: '印尼盾' },
  { code: 'AUD', name: '澳幣' },
  { code: 'NZD', name: '紐西蘭幣' },
  { code: 'CAD', name: '加拿大幣' },
  { code: 'CHF', name: '瑞士法郎' },
  { code: 'TRY', name: '土耳其里拉' },
  { code: 'AED', name: '阿聯酋迪拉姆' },
];

const NAMES = new Map(CURRENCIES.map(c => [c.code, c.name]));

/** 「KRW 韓元」；不在清單上的只顯示代碼 */
export const currencyLabel = (code: string): string => {
  const name = NAMES.get(code);
  return name ? `${code} ${name}` : code;
};

/** 中文名稱，不在清單上回空字串 */
export const currencyName = (code: string): string => NAMES.get(code) ?? '';

/** 使用者自己輸入的代碼：去空白、轉大寫，必須是 3 個英文字母 */
export const normalizeCurrencyCode = (raw: string): string | null => {
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

/**
 * 每個幣別一個識別色（設定頁的匯率清單用，David 2026-11-27：不同幣別要分得出來）。
 * 中間調的 hex，淺色深色都看得清楚；背景用時再加透明度。清單外的幣別依代碼雜湊挑一個。
 */
const CURRENCY_COLORS: Record<string, string> = {
  TWD: '#2e9e6a', JPY: '#d9534f', KRW: '#4a6fc0', CNY: '#c2527a', HKD: '#d9822b', MOP: '#a3784a',
  USD: '#3f8f5f', EUR: '#5c6fd0', GBP: '#7d4fb8', THB: '#c99a1e', SGD: '#d0644a', MYR: '#3f9aa6',
  VND: '#b0636f', PHP: '#4a8fc0', IDR: '#8a8f3c', AUD: '#c27a3a', NZD: '#5f9a5b', CAD: '#c24a4a',
  CHF: '#a33b3b', TRY: '#c25a7a', AED: '#6a8a3c',
};
const FALLBACK_COLORS = ['#5c7fa8', '#3f9aa6', '#a3784a', '#7d72b8', '#b0636f', '#5f9a5b', '#8a8f3c', '#a86a9c'];

export const currencyColor = (code: string): string => {
  if (CURRENCY_COLORS[code]) return CURRENCY_COLORS[code];
  let h = 0;
  for (const ch of code) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
};
