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
