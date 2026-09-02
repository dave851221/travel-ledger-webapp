/**
 * 行程頁的共用元件庫。
 *
 * 這些是「積木」而不是「模具」—— 每個行程頁仍然是自由發揮的 React 元件，
 * 想用幾塊就用幾塊。簡單的兩日遊可以只用 DaySelector 和 ItineraryCard，
 * 完全不必碰 TripMap。
 *
 * 用法見 docs/ITINERARY_AUTHORING.md。
 */
export { default as ItineraryCard } from './ItineraryCard';
export type { ItineraryCardProps, ItineraryAccent } from './ItineraryCard';

export { default as DaySelector } from './DaySelector';
export type { DaySelectorProps, DayOption } from './DaySelector';

export { default as TripMap } from './TripMap';
export type { TripMapProps } from './TripMap';

export { getInitialDay } from './useInitialDay';
