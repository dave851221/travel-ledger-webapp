/**
 * Date helpers.
 *
 * 一律不要用 `new Date().toISOString().split('T')[0]` 取「今天」——
 * 那會回傳 UTC 日期，台灣（UTC+8）在 00:00~08:00 之間會少一天。
 */

/** 以裝置本地時區取得 YYYY-MM-DD */
export const getLocalDateString = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
