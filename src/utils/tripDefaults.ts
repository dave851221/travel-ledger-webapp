import type { Trip } from '../types';

/**
 * 旅程的「記帳預設值」—— 讀取時一律走這裡，不要直接用 `trip.default_*`。
 *
 * 設定頁刪掉幣別或分類時，舊版不會連帶修正預設值，資料庫裡可能還留著
 * 一個已經沒有匯率的 `default_currency`。直接拿來用的話，新增的支出會記在
 * 沒有匯率的幣別上，統計以 1:1 換算，金額默默失真。
 */

/** 記帳預設幣別：必須是主幣別或 rates 裡有的幣別，否則退回主幣別 */
export const getDefaultCurrency = (
  trip: Pick<Trip, 'default_currency' | 'base_currency' | 'rates'>,
): string => {
  const c = trip.default_currency;
  if (c && (c === trip.base_currency || Object.prototype.hasOwnProperty.call(trip.rates ?? {}, c))) {
    return c;
  }
  return trip.base_currency;
};

/** 記帳預設分類：必須在分類清單裡，否則退回第一個分類（清單是空的就用「其他」） */
export const getDefaultCategory = (
  trip: Pick<Trip, 'default_category' | 'categories'>,
): string => {
  const list = trip.categories ?? [];
  const c = trip.default_category;
  if (c && list.includes(c)) return c;
  return list[0] || '其他';
};
