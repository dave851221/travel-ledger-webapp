import type { Expense } from '../../types';
import { photoKind, type PhotoKind } from '../../utils/album';

/**
 * 回顧影片的「劇本」：挑哪些照片、每一段在第幾秒、跟音樂的第幾拍對齊。
 * 這裡全是純函式（vitest 測得到），畫面與聲音分別在 render.ts／music.ts。
 */

export interface RecapPhoto {
  /** Storage path, unique across the trip */
  path: string;
  date: string;
  /** What it was: the expense's description without the bot's explanation in brackets */
  caption: string;
  /** The expense's full description, for the picker's detail view */
  description?: string;
  /** The expense's total, shown beside the caption when amounts are on */
  amount: number;
  currency: string;
  /** Receipts can go in the video too, but are never picked automatically */
  kind: PhotoKind;
}

/**
 * 「關東煮 (日式燉煮小吃)」→「關東煮」。LINE 機器人記帳時常在後面補一段括號說明，放在影片裡太囉嗦。
 * 整句都是括號、或去掉後是空的，就保留原文。
 */
export const photoCaption = (description: string): string => {
  const text = (description ?? '').trim();
  const short = text.replace(/\s*[（(][^（）()]*[)）]\s*$/u, '').trim();
  return short || text;
};

export interface RecapDay {
  date: string;
  /** 1-based, counted from the first day of the trip */
  dayNumber: number;
  /** From the itinerary when there is one, e.g. 京都 */
  city?: string;
  /** From the itinerary, e.g. 清水寺・二三年坂・嵐山 */
  title?: string;
  photos: RecapPhoto[];
}

export interface DayMeta {
  date: string;
  city?: string;
  title?: string;
}

const DAY_MS = 86_400_000;
const toDay = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export const daysBetween = (from: string, to: string): number => Math.round((toDay(to) - toDay(from)) / DAY_MS);

/**
 * 旅程實際出遊的日期範圍。有行程表就用行程表的第一天到最後一天；
 * 沒有的話從支出日期裡找「最密集的一段」—— 機票、住宿常在幾個月前就記了，
 * 直接取最早到最晚會變成「186 天的旅程」。相隔超過 2 天就切成另一段，取支出最多的那段。
 */
export const tripDateRange = (expenses: Expense[], itineraryDates: string[] = []): { from: string; to: string } | null => {
  const plan = itineraryDates.filter(Boolean).sort();
  if (plan.length > 0) return { from: plan[0], to: plan[plan.length - 1] };

  const counts = new Map<string, number>();
  for (const e of expenses) {
    if (e.deleted_at || e.is_settlement || !e.date) continue;
    counts.set(e.date, (counts.get(e.date) ?? 0) + 1);
  }
  const dates = [...counts.keys()].sort();
  if (dates.length === 0) return null;

  let best = { from: dates[0], to: dates[0], n: 0 };
  let cur = { from: dates[0], to: dates[0], n: 0 };
  for (const d of dates) {
    if (daysBetween(cur.to, d) > 2) cur = { from: d, to: d, n: 0 };
    cur.to = d;
    cur.n += counts.get(d) ?? 0;
    if (cur.n > best.n) best = { ...cur };
  }
  return { from: best.from, to: best.to };
};

/**
 * 範圍內每一天的照片（商品照片與收據都列，收據只在使用者勾選時才進影片），舊到新。
 * 同一天裡依支出建立時間排。沒有照片的日子不列。
 */
export const recapDays = (
  expenses: Expense[],
  range: { from: string; to: string },
  meta: DayMeta[] = [],
): RecapDay[] => {
  const byDate = new Map<string, RecapPhoto[]>();
  const seen = new Set<string>();
  const sorted = expenses
    .filter(e => !e.deleted_at && !e.is_settlement && e.date >= range.from && e.date <= range.to)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  for (const e of sorted) {
    for (const path of e.photo_urls ?? []) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const list = byDate.get(e.date) ?? [];
      list.push({ path, date: e.date, caption: photoCaption(e.description ?? ''), description: e.description ?? '', amount: Number(e.amount) || 0, currency: e.currency, kind: photoKind(e, path) });
      byDate.set(e.date, list);
    }
  }
  const metaByDate = new Map(meta.map(m => [m.date, m]));
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, photos]) => ({
      date,
      dayNumber: daysBetween(range.from, date) + 1,
      city: metaByDate.get(date)?.city,
      title: metaByDate.get(date)?.title,
      photos,
    }));
};

/** `k` indices spread evenly over `n` items (the middle of each equal slice). */
export const evenlySpaced = (n: number, k: number): number[] => {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  if (k <= 0) return [];
  return Array.from({ length: k }, (_, i) => Math.min(n - 1, Math.floor(((i + 0.5) * n) / k)));
};

export const AUTO_TOTAL = 18;
/** Even a day full of photos shouldn't take over the video */
export const PER_DAY_MAX = 6;
/** More than this and even two beats a photo runs past 45 seconds */
export const MAX_PHOTOS = 26;

/**
 * 自動挑照片：**照片本身為主，不硬照日子平均**（David 2026-11-24：有些日子照片少，硬塞一張很勉強）。
 * 每天分到的張數跟那天的照片數成正比（最大餘數法），照片少的日子可能一張都不挑；
 * 同一天裡平均分散，避免連續幾張都是同一頓飯。
 */
export const autoPick = (allDays: RecapDay[], total = AUTO_TOTAL): string[] => {
  const days = allDays.map(d => ({ ...d, photos: d.photos.filter(p => p.kind === 'item') }));
  const all = days.reduce<number>((n, d) => n + d.photos.length, 0);
  if (all === 0) return [];
  const want = Math.min(total, all);
  const cap = (d: RecapDay) => Math.min(d.photos.length, PER_DAY_MAX);
  const share = days.map(d => (want * d.photos.length) / all);
  const quota = days.map((d, i) => Math.min(cap(d), Math.floor(share[i])));
  let left = want - quota.reduce<number>((a, b) => a + b, 0);
  // Largest remainder first; a day at its cap passes its turn on
  while (left > 0) {
    let best = -1;
    let bestScore = -Infinity;
    days.forEach((d, i) => {
      if (quota[i] >= cap(d)) return;
      const score = share[i] - quota[i];
      if (score > bestScore) { best = i; bestScore = score; }
    });
    if (best < 0) break;
    quota[best] += 1;
    left -= 1;
  }
  return days.flatMap((d, i) => evenlySpaced(d.photos.length, quota[i]).map(j => d.photos[j].path));
};

// ---------------------------------------------------------------------------
// Timeline

export type TransitionKind = 'zoom' | 'whip' | 'rise' | 'shutter' | 'reveal' | 'fade';

export interface IntroSegment { kind: 'intro'; start: number; end: number }
export interface ShotSegment {
  kind: 'shot';
  start: number;
  end: number;
  photo: RecapPhoto;
  day: RecapDay;
  /** First photo of its day: gets the stronger cut */
  dayStart: boolean;
  /** Index among the shots, picks the Ken Burns direction */
  index: number;
}
export interface StatsSegment { kind: 'stats'; start: number; end: number }
/** The fun-facts page after the numbers */
export interface FactsSegment { kind: 'facts'; start: number; end: number }
/** Everyone's running total, racing day by day */
export interface RaceSegment { kind: 'race'; start: number; end: number }
/** Where each person's money went */
export interface PeopleSegment { kind: 'people'; start: number; end: number }
export interface OutroSegment { kind: 'outro'; start: number; end: number; photo: RecapPhoto | null }
export type Segment = IntroSegment | ShotSegment | StatsSegment | FactsSegment | PeopleSegment | RaceSegment | OutroSegment;

export interface Timeline {
  bpm: number;
  beat: number;
  duration: number;
  segments: Segment[];
  /** How the cut into segment i (i ≥ 1) looks */
  transitions: TransitionKind[];
  /** Beat index where the photos start (the drop) and where the pages after them start (the breakdown) */
  marks: { drop: number; stats: number; outro: number; end: number };
}

/**
 * 每一段想要的長度用「秒」定，再換成整小節的拍數：換音樂（速度不同）時影片長度才不會跟著大幅變動。
 * 以前用固定拍數，92 BPM 的「溫暖」會比 118 BPM 的「輕快」長好幾秒（David 2026-11-24 問過）。
 */
const INTRO_SECONDS = 4;
const OUTRO_SECONDS = 4;
/** A relaxed pace for one photo */
const PHOTO_SECONDS = 1.3;
const barsFor = (seconds: number, beat: number) => Math.max(1, Math.round(seconds / beat / 4)) * 4;
/** Beats of the opening title at this tempo (the music's drop) */
export const introBeats = (bpm: number) => barsFor(INTRO_SECONDS, 60 / bpm);

/** The optional pages after the photos, in the order they play */
export type ExtraSection = 'stats' | 'facts' | 'people' | 'race';
// Kept short: David wants the whole video around 40-odd seconds (2026-11-24)
const EXTRA_SECONDS: Record<ExtraSection, number> = { stats: 4, facts: 6, people: 4, race: 6 };
const EXTRA_ORDER: ExtraSection[] = ['stats', 'facts', 'people', 'race'];
const MIN_SECONDS = 30;
const MAX_SECONDS = 46;
/** Even with very few photos, no single photo stays longer than this */
const MAX_SHOT_BEATS = 8;

/** Plain cuts inside a day rotate through these so no two in a row look alike */
// Mostly clean dissolves; the moving ones are spaced out so the video doesn't keep pulsing blur
const IN_DAY: TransitionKind[] = ['fade', 'whip', 'fade', 'rise', 'fade', 'shutter', 'fade', 'reveal'];

/**
 * 依照片數與速度排出整支影片。全部以「拍」為單位，所以每一刀都落在拍點上。
 * 平均每張約 1.3 秒（多出來的拍先給每天的第一張）；照片多時壓縮（每張至少 2 拍）、少時拉長，總長落在 30～46 秒。
 * 照片段結束時補到整小節（4 拍），統計段才會正好在新的一小節開始。
 */
export const buildTimeline = (
  shots: { photo: RecapPhoto; day: RecapDay }[],
  bpm: number,
  outroPhoto: RecapPhoto | null,
  sections: ExtraSection[] = ['stats'],
): Timeline => {
  const beat = 60 / bpm;
  const INTRO_BEATS = barsFor(INTRO_SECONDS, beat);
  const OUTRO_BEATS = barsFor(OUTRO_SECONDS, beat);
  const extras = EXTRA_ORDER.filter(k => sections.includes(k));
  const extraBeatsOf = (k: ExtraSection) => barsFor(EXTRA_SECONDS[k], beat);
  const extraBeats = extras.reduce<number>((n, k) => n + extraBeatsOf(k), 0);
  const fixed = INTRO_BEATS + extraBeats + OUTRO_BEATS;
  const maxSeconds = MAX_SECONDS;
  const n = shots.length;
  const dayStarts = shots.map((s, i) => i === 0 || s.day.date !== shots[i - 1].day.date);
  const maxBeats = Math.floor(maxSeconds / beat - fixed - 3); // leave room for rounding up to a bar
  const minBeats = Math.ceil(MIN_SECONDS / beat - fixed);

  // A relaxed pace is ~1.3 s a photo; squeeze or stretch to fit 30–46 s. The photos also soak up
  // whatever the other sections gained or lost by snapping to whole bars, so the total stays put
  const nominal = INTRO_SECONDS + OUTRO_SECONDS + extras.reduce<number>((t, k) => t + EXTRA_SECONDS[k], 0) + n * PHOTO_SECONDS;
  const natural = Math.round(nominal / beat) - fixed;
  // Never under two beats a photo: faster than that the cuts become a strobe
  const budget = Math.min(n * MAX_SHOT_BEATS, Math.max(n * 2, Math.min(maxBeats, Math.max(minBeats, natural))));
  const lens = shots.map(() => Math.floor(budget / Math.max(1, n)));
  let extra = budget - lens.reduce<number>((a, x) => a + x, 0);
  // Spare beats go to the first photo of each day (a new place to take in), then the rest
  const order = [
    ...shots.map((_, i) => i).filter(i => dayStarts[i]),
    ...shots.map((_, i) => i).filter(i => !dayStarts[i]),
  ];
  for (let k = 0; extra > 0 && order.length > 0; k = (k + 1) % order.length, extra--) lens[order[k]] += 1;

  // Round the photo section up to a whole bar, one extra beat each for the last few photos
  const total = lens.reduce<number>((a, x) => a + x, 0);
  const pad = (4 - ((INTRO_BEATS + total) % 4)) % 4;
  for (let k = 0; k < pad && n > 0; k++) lens[n - 1 - (k % n)] += 1;

  const segments: Segment[] = [{ kind: 'intro', start: 0, end: INTRO_BEATS * beat }];
  let at = INTRO_BEATS;
  shots.forEach((s, i) => {
    segments.push({ kind: 'shot', start: at * beat, end: (at + lens[i]) * beat, photo: s.photo, day: s.day, dayStart: dayStarts[i], index: i });
    at += lens[i];
  });
  const stats = at;
  for (const kind of extras) {
    segments.push({ kind, start: at * beat, end: (at + extraBeatsOf(kind)) * beat });
    at += extraBeatsOf(kind);
  }
  const outro = at;
  segments.push({ kind: 'outro', start: at * beat, end: (at + OUTRO_BEATS) * beat, photo: outroPhoto });
  at += OUTRO_BEATS;

  const transitions: TransitionKind[] = segments.map((seg, i) => {
    if (i === 0) return 'fade';
    if (seg.kind === 'shot' && seg.index === 0) return 'zoom';
    if (seg.kind === 'shot') return seg.dayStart ? 'zoom' : IN_DAY[seg.index % IN_DAY.length];
    if (seg.kind === 'stats') return 'shutter';
    if (seg.kind === 'facts') return 'rise';
    if (seg.kind === 'race') return 'reveal';
    if (seg.kind === 'people') return 'whip';
    return 'zoom';
  });

  return {
    bpm,
    beat,
    duration: at * beat,
    segments,
    transitions,
    marks: { drop: INTRO_BEATS, stats, outro, end: at },
  };
};

/** The segment showing at `t`, with the one before it (for transitions). */
export const segmentAt = (tl: Timeline, t: number): number => {
  const segs = tl.segments;
  for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start) return i;
  return 0;
};

/** Shots in story order from the picked paths. Unknown paths are skipped. */
export const shotsFromPicks = (days: RecapDay[], picks: string[]): { photo: RecapPhoto; day: RecapDay }[] => {
  const wanted = new Set(picks);
  return days.flatMap(day => day.photos.filter(p => wanted.has(p.path)).map(photo => ({ photo, day })));
};
