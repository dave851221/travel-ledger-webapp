/**
 * 旅程日期（trips.start_date / end_date，選填）。
 *
 * - 一天的旅程只填 start_date，end_date 是 NULL
 * - 一段時間：start_date ～ end_date（含頭尾），end_date 一定不早於 start_date（資料庫也有 CHECK）
 * - 都沒填的舊旅程，首頁退回用建立時間（畫面上標「建立於」）
 */
import type { Trip } from '../types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const parts = (iso: string) => iso.split('-').map(Number) as [number, number, number];

/** 表單的兩格日期 → 要存的值；不合理時回傳錯誤訊息 */
export function normalizeTripDates(start: string, end: string): { start_date: string | null; end_date: string | null } | { error: string } {
  const s = start.trim();
  const e = end.trim();
  if (!s && !e) return { start_date: null, end_date: null };
  if (!s) return { error: '有結束日期的話，也要填開始日期' };
  if (!ISO_DATE.test(s) || (e && !ISO_DATE.test(e))) return { error: '日期格式不正確' };
  if (e && e < s) return { error: '結束日期不能早於開始日期' };
  // 同一天就當成一天的旅程
  return { start_date: s, end_date: e && e !== s ? e : null };
}

/** 有沒有自己填的日期 */
export const hasTripDates = (trip: Pick<Trip, 'start_date'>): boolean => !!trip.start_date && ISO_DATE.test(trip.start_date);

/**
 * 排序與「最近的旅程」用的時間：有填日期用開始日期，沒有就用建立時間。
 * 日期當成本地午夜，跟建立時間比較時差幾小時不影響。
 */
export function tripTime(trip: Pick<Trip, 'start_date' | 'created_at'>): number {
  if (hasTripDates(trip)) {
    const [y, m, d] = parts(trip.start_date!);
    return new Date(y, m - 1, d).getTime();
  }
  return new Date(trip.created_at).getTime() || 0;
}

/** 首頁日期章：年、月 */
export function tripStampParts(trip: Pick<Trip, 'start_date' | 'created_at'>): { year: number; month: number } {
  if (hasTripDates(trip)) {
    const [y, m] = parts(trip.start_date!);
    return { year: y, month: m };
  }
  const d = new Date(trip.created_at);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/**
 * 日期文字：`2026/11/20`、`2026/11/20 – 11/27`、跨年 `2026/12/30 – 2027/1/3`。
 * 沒填日期回傳 null。
 */
export function formatTripDates(trip: Pick<Trip, 'start_date' | 'end_date'>): string | null {
  if (!trip.start_date || !ISO_DATE.test(trip.start_date)) return null;
  const [sy, sm, sd] = parts(trip.start_date);
  const head = `${sy}/${sm}/${sd}`;
  if (!trip.end_date || !ISO_DATE.test(trip.end_date) || trip.end_date <= trip.start_date) return head;
  const [ey, em, ed] = parts(trip.end_date);
  return ey === sy ? `${head} – ${em}/${ed}` : `${head} – ${ey}/${em}/${ed}`;
}

/** 幾天（含頭尾）；沒填回傳 null */
export function tripDayCount(trip: Pick<Trip, 'start_date' | 'end_date'>): number | null {
  if (!trip.start_date || !ISO_DATE.test(trip.start_date)) return null;
  if (!trip.end_date || !ISO_DATE.test(trip.end_date) || trip.end_date <= trip.start_date) return 1;
  const [sy, sm, sd] = parts(trip.start_date);
  const [ey, em, ed] = parts(trip.end_date);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000) + 1;
}

/** 清單用的短日期（年份已經畫在日期章上）：`11/20`、`11/20–27`、`11/28–12/3`、跨年 `12/30–2027/1/3` */
export function formatTripDatesShort(trip: Pick<Trip, 'start_date' | 'end_date'>): string | null {
  if (!trip.start_date || !ISO_DATE.test(trip.start_date)) return null;
  const [sy, sm, sd] = parts(trip.start_date);
  const head = `${sm}/${sd}`;
  if (!trip.end_date || !ISO_DATE.test(trip.end_date) || trip.end_date <= trip.start_date) return head;
  const [ey, em, ed] = parts(trip.end_date);
  if (ey !== sy) return `${head}–${ey}/${em}/${ed}`;
  return em === sm ? `${head}–${ed}` : `${head}–${em}/${ed}`;
}
