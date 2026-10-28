import type { ItineraryItem, ItineraryPlan, Note, Place } from './types';

/** Identity helper so trip files get type checking and autocompletion. */
export const defineItinerary = (plan: ItineraryPlan): ItineraryPlan => plan;

export type ItineraryView = 'overview' | 'daily' | 'prep';

/**
 * 依資料決定要出現哪些分頁：天數少就不需要一覽，沒有航班、住宿、預訂、清單就沒有行前。
 * 只剩「每日」時，頁面不顯示分頁切換。
 */
export const availableViews = (plan: ItineraryPlan): ItineraryView[] => {
  const views: ItineraryView[] = [];
  if (plan.days.length >= 3) views.push('overview');
  if (plan.days.length > 0) views.push('daily');
  // 一兩天的小旅行，住宿資訊在每日的「今晚住宿」卡片就看得到，不必為它多開一個分頁
  const staysNeedPrep = (plan.stays?.length ?? 0) > 0 && plan.days.length >= 3;
  const hasPrep = !!(plan.flights?.length || staysNeedPrep || plan.bookings?.length
    || plan.checklist?.items.length || plan.notes?.length);
  if (hasPrep) views.push('prep');
  return views;
};

/** Today's date (YYYY-MM-DD) and minutes since midnight, in the given IANA zone or the device's. */
export const nowIn = (timeZone?: string, now: Date = new Date()): { date: string; minutes: number } => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    // 不認得的時區字串：退回裝置時區，總比整頁壞掉好
    return nowIn(undefined, now);
  }
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
};

/** Index of today's day in the plan, or -1 when the trip isn't happening today. */
export const todayIndex = (plan: ItineraryPlan, today: string): number =>
  plan.days.findIndex(d => d.date === today);

const TIME_RE = /^(\d{2}):(\d{2})(?:–(\d{2}):(\d{2}))?$/;

export const isValidTime = (time: string): boolean => {
  const m = TIME_RE.exec(time);
  if (!m) return false;
  const nums = m.slice(1).filter(Boolean).map(Number);
  return nums.every((n, i) => (i % 2 === 0 ? n <= 23 : n <= 59));
};

/** Start of an item's time window in minutes, or null when it only has a slot. */
export const startMinutes = (item: ItineraryItem): number | null => {
  const m = item.time ? TIME_RE.exec(item.time) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export type ItemState = 'done' | 'now' | 'next' | null;

/**
 * 旅途中當天的時間軸狀態：已經過的變淡、最後一個開始的是「現在」、下一個是「下一站」。
 * 只看有確切時間的項目；只寫時段（早上、午餐）的項目沒有狀態。
 */
export const itemStates = (items: ItineraryItem[], nowMinutes: number): ItemState[] => {
  const starts = items.map(startMinutes);
  let current = -1;
  let next = -1;
  starts.forEach((s, i) => {
    if (s === null) return;
    if (s <= nowMinutes) current = i;
    else if (next === -1) next = i;
  });
  return starts.map((s, i) => {
    if (s === null) return null;
    if (i === current) return 'now';
    if (i === next) return 'next';
    return s <= nowMinutes ? 'done' : null;
  });
};

export const mapsSearchUrl = (query: string): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

/** Where tapping a place should go: its own link, else a Google Maps search. */
export const placeUrl = (place: Place): string =>
  place.href ?? mapsSearchUrl(place.lat !== undefined && place.lng !== undefined ? `${place.lat},${place.lng}` : place.query ?? place.name);

export type RichSegment =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'link'; text: string; href: string };

const RICH_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*/g;

/** Splits `[label](https://…)` links and `**bold**` out of a string. Anything else stays literal. */
export const parseRichText = (text: string): RichSegment[] => {
  const out: RichSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(RICH_RE)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'link', text: m[1], href: m[2] });
    else out.push({ type: 'bold', text: m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
};

/**
 * Turns place names that appear inside plain-text segments into map links,
 * so a title like「日本橋 → 道頓堀」links both stops without repeating them below.
 * Longer names win, so「哇沙謎江戶時代館」isn't split by a shorter overlapping name.
 */
export const linkPlaceNames = (segments: RichSegment[], places: Place[]): RichSegment[] => {
  if (places.length === 0) return segments;
  const sorted = [...places].sort((a, b) => b.name.length - a.name.length);
  return segments.flatMap(seg => {
    if (seg.type !== 'text') return [seg];
    let parts: RichSegment[] = [seg];
    for (const place of sorted) {
      parts = parts.flatMap(p => {
        if (p.type !== 'text' || !p.text.includes(place.name)) return [p];
        const pieces = p.text.split(place.name);
        return pieces.flatMap((piece, i) => {
          const out: RichSegment[] = piece ? [{ type: 'text', text: piece }] : [];
          if (i < pieces.length - 1) out.push({ type: 'link', text: place.name, href: placeUrl(place) });
          return out;
        });
      });
    }
    return parts;
  });
};

/** Places whose names don't appear in the title, so they still need their own links. */
export const unlinkedPlaces = (title: string, places: Place[] = []): Place[] => {
  const text = plainText(title);
  return places.filter(p => !text.includes(p.name));
};

/** Plain text of a rich string, for labels and aria text. */
export const plainText = (text: string): string =>
  parseRichText(text).map(s => s.text).join('');

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** "11/14" and "六" for a YYYY-MM-DD date, without timezone surprises. */
export const dateParts = (iso: string): { md: string; weekday: string } => {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { md: `${m}/${d}`, weekday };
};

export const nightsBetween = (checkIn: string, checkOut: string): number => {
  const toUtc = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(checkOut) - toUtc(checkIn)) / 86_400_000);
};

/** Every note's text, flattened, so validation can check the links inside. */
export const flattenNotes = (notes: Note[] = []): string[] =>
  notes.flatMap(n => (typeof n === 'string' ? [n] : [n.text, ...flattenNotes(n.items)]));
