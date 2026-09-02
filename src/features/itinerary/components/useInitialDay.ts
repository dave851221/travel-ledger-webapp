import { getLocalDateString } from '../../../utils/date';

/**
 * 如果今天正好在旅程期間，就回傳當天對應的 day key，否則回傳第一天。
 *
 * 用法：
 * ```ts
 * const TRIP_DATES = { '2027-03-14': 'day1', '2027-03-15': 'day2' };
 * const [activeDay, setActiveDay] = useState(() => getInitialDay(TRIP_DATES, 'day1'));
 * ```
 *
 * 傳給 useState 時記得用函式形式（`() => getInitialDay(...)`），
 * 否則每次 render 都會重算一次。
 *
 * 刻意用 getLocalDateString 而不是 toISOString()：UTC+8 的凌晨會被算成前一天。
 */
export const getInitialDay = <K extends string>(
  tripDates: Record<string, K>,
  fallback: K,
): K => tripDates[getLocalDateString()] ?? fallback;
