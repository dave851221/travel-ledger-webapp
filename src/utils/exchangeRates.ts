import Decimal from 'decimal.js';

/**
 * 今日匯率（設定頁的「更新為今日匯率」）。
 *
 * 來源是 ExchangeRate-API 的免費端點 open.er-api.com：免金鑰、允許瀏覽器直接呼叫（CORS *）、
 * 每天更新一次、有台幣。條款要求在畫面上標示資料來源，見 SettingsModal。
 */
export const EXCHANGE_RATE_SOURCE_URL = 'https://www.exchangerate-api.com';

interface OpenErResponse {
  result: 'success' | 'error';
  time_last_update_unix?: number;
  /** 1 單位 base = ? 單位該幣別 */
  rates?: Record<string, number>;
  'error-type'?: string;
}

export interface LatestRates {
  /** 旅程格式「1 單位該幣別 = ? 主幣別」，已轉成表單用的字串 */
  rates: Record<string, string>;
  /** 來源沒有的幣別（維持原本的匯率） */
  missing: string[];
  /** 來源資料的更新時間 */
  updatedAt: Date | null;
}

/**
 * 把來源的匯率換成旅程的格式。
 *
 * 來源回的是「1 主幣別 = ? 外幣」（1 TWD = 4.85 JPY），旅程存的是「1 外幣 = ? 主幣別」，
 * 所以要取倒數。取 6 位有效數字，與設定頁換主幣別時的換算一致。
 */
export const toTripRates = (
  apiRates: Record<string, number>,
  codes: string[],
  base: string,
): { rates: Record<string, string>; missing: string[] } => {
  const rates: Record<string, string> = {};
  const missing: string[] = [];
  for (const code of codes) {
    if (code === base) continue;
    const perBase = apiRates[code];
    if (typeof perBase !== 'number' || !isFinite(perBase) || perBase <= 0) {
      missing.push(code);
      continue;
    }
    rates[code] = new Decimal(1).dividedBy(perBase).toSignificantDigits(6).toString();
  }
  return { rates, missing };
};

export const fetchLatestRates = async (base: string, codes: string[]): Promise<LatestRates> => {
  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
  if (!res.ok) throw new Error(`匯率服務暫時無法使用（HTTP ${res.status}）`);
  const body = (await res.json()) as OpenErResponse;
  if (body.result !== 'success' || !body.rates) {
    throw new Error(body['error-type'] === 'unsupported-code'
      ? `匯率服務不支援主幣別 ${base}`
      : '匯率服務暫時無法使用');
  }
  return {
    ...toTripRates(body.rates, codes, base),
    updatedAt: body.time_last_update_unix ? new Date(body.time_last_update_unix * 1000) : null,
  };
};
