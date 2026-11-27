/**
 * 首頁旅程清單的分組與排序（純函式，homeLayout.test.ts）。
 *
 * 預設排法：分組依「還沒封存的旅程裡最新的日期」（有填旅程日期用開始日，沒有用建立時間）排，越新越上面；全部封存的分組排在後面；
 * 「未分類」最後。組內進行中的排前面，各自依日期新到舊。
 *
 * 使用者可以自訂順序（首頁的「排序」）。存下來的只有兩份清單：分組名稱的順序、每組裡旅程 id 的順序。
 * 套用時以存下來的順序為準；之後才出現的分組或旅程（存的時候還沒有）放在最上面 ——
 * 新建的旅程多半就是接下來要用的那一趟。只有「未分類」與已封存的新旅程例外，照預設放最後。
 */
import type { Trip } from '../../types';
import { tripTime } from '../../utils/tripDates';

export const UNCATEGORIZED = '未分類';

export interface TripGroup {
  category: string;
  trips: Trip[];
}

export interface HomeLayout {
  /** 分組名稱的順序（「未分類」也算一組） */
  groups: string[];
  /** 每組裡旅程 id 的順序 */
  trips: Record<string, string[]>;
}

/** 存一份的上限：防止壞資料把畫面拖垮（正常用不到這麼多） */
const MAX_GROUPS = 200;
const MAX_TRIPS_PER_GROUP = 500;

export const groupKey = (trip: Pick<Trip, 'category'>): string =>
  (trip.category && trip.category.trim()) || UNCATEGORIZED;

/** 有填旅程日期用開始日期，沒有就用建立時間 */
const time = (t: Trip) => tripTime(t);
const newest = (list: Trip[]) => list.reduce((max, t) => Math.max(max, time(t)), -Infinity);

/** 預設排法（沒有自訂順序時、以及新出現的項目之間的相對順序） */
export function defaultGroups(trips: Trip[]): TripGroup[] {
  const byNewest = [...trips].sort((a, b) => time(b) - time(a));
  const ordered = [...byNewest.filter(t => !t.is_archived), ...byNewest.filter(t => t.is_archived)];
  const buckets = new Map<string, Trip[]>();
  ordered.forEach(t => {
    const key = groupKey(t);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  });
  const named: TripGroup[] = [];
  let uncategorized: TripGroup | null = null;
  buckets.forEach((groupTrips, category) => {
    const entry = { category, trips: groupTrips };
    if (category === UNCATEGORIZED) uncategorized = entry;
    else named.push(entry);
  });
  // 封存的旅程不算 —— 否則剛封存一趟舊旅行就會把整組頂到最上面
  named.sort((a, b) => {
    const aActive = newest(a.trips.filter(t => !t.is_archived));
    const bActive = newest(b.trips.filter(t => !t.is_archived));
    if (aActive !== bActive) return bActive - aActive;
    return newest(b.trips) - newest(a.trips);
  });
  return uncategorized ? [...named, uncategorized] : named;
}

/** 依存下來的順序排；不在清單裡的依 `isTail` 放最前或最後（彼此維持原本的相對順序） */
function orderBy<T>(items: T[], saved: string[] | undefined, keyOf: (item: T) => string, isTail: (item: T) => boolean): T[] {
  if (!saved || saved.length === 0) return items;
  const rank = new Map<string, number>();
  saved.forEach((k, i) => { if (!rank.has(k)) rank.set(k, i); });
  const known = items.filter(it => rank.has(keyOf(it))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  const fresh = items.filter(it => !rank.has(keyOf(it)));
  return [...fresh.filter(it => !isTail(it)), ...known, ...fresh.filter(isTail)];
}

/** 套用自訂順序。layout 為 null 時就是預設排法 */
export function applyLayout(trips: Trip[], layout: HomeLayout | null): TripGroup[] {
  const groups = defaultGroups(trips);
  if (!layout) return groups;
  return orderBy(groups, layout.groups, g => g.category, g => g.category === UNCATEGORIZED).map(g => ({
    category: g.category,
    trips: orderBy(g.trips, layout.trips[g.category], t => t.id, t => t.is_archived),
  }));
}

/** 把畫面上目前的順序存成 layout（只記現有的分組與旅程，舊的、刪掉的自然消失） */
export function layoutFromGroups(groups: TripGroup[]): HomeLayout {
  return {
    groups: groups.map(g => g.category),
    trips: Object.fromEntries(groups.map(g => [g.category, g.trips.map(t => t.id)])),
  };
}

/** 兩份排法是不是同一個順序 */
export function sameOrder(a: TripGroup[], b: TripGroup[]): boolean {
  return JSON.stringify(layoutFromGroups(a)) === JSON.stringify(layoutFromGroups(b));
}

/** 從資料庫或 localStorage 讀到的東西不一定可信：收斂成 HomeLayout，看不懂就當作沒有 */
export function sanitizeLayout(raw: unknown): HomeLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { groups?: unknown; trips?: unknown };
  if (!Array.isArray(obj.groups)) return null;
  const groups = obj.groups.filter((g): g is string => typeof g === 'string').slice(0, MAX_GROUPS);
  const trips: Record<string, string[]> = {};
  if (obj.trips && typeof obj.trips === 'object' && !Array.isArray(obj.trips)) {
    Object.entries(obj.trips as Record<string, unknown>).slice(0, MAX_GROUPS).forEach(([k, v]) => {
      if (Array.isArray(v)) trips[k] = v.filter((id): id is string => typeof id === 'string').slice(0, MAX_TRIPS_PER_GROUP);
    });
  }
  return { groups, trips };
}

/** 把一個項目從 from 移到 to（拖曳與上下鍵共用） */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Dashboard 的「其他旅程」（同一組的其他旅程）照首頁的順序排；沒有自訂順序就維持原樣 */
export function orderSiblings(siblings: Trip[], category: string | null | undefined, layout: HomeLayout | null): Trip[] {
  const saved = layout?.trips[(category && category.trim()) || UNCATEGORIZED];
  return orderBy(siblings, saved, t => t.id, t => t.is_archived);
}

/**
 * 首頁最上面的「最近的旅程」：還沒封存的旅程裡，今天正在進行的那一趟優先（有填日期、今天落在日期內）；
 * 沒有的話取日期最新的一趟（沒填日期的用建立時間）。`today` 是 YYYY-MM-DD。
 */
export function pickFeatured(trips: Trip[], today: string): Trip | null {
  const active = trips.filter(t => !t.is_archived);
  const ongoing = active.find(t => t.start_date && t.start_date <= today && (t.end_date || t.start_date) >= today);
  if (ongoing) return ongoing;
  return active.reduce<Trip | null>((best, t) => (!best || time(t) > time(best) ? t : best), null);
}
