import type { Expense } from '../types';

export type PhotoKind = 'item' | 'receipt';

export interface AlbumPhoto {
  /** Storage path, unique across the album */
  path: string;
  expense: Expense;
  kind: PhotoKind;
}

export interface AlbumDay {
  date: string;
  photos: AlbumPhoto[];
}

/** A photo is a receipt only when the expense says so; everything else is an item photo. */
export const photoKind = (expense: Expense, path: string): PhotoKind =>
  (expense.receipt_photo_urls ?? []).includes(path) ? 'receipt' : 'item';

/**
 * Every photo of the given kind, grouped by the expense's date (newest day first).
 * Within a day, newer expenses come first and each expense keeps its own photo order.
 * Settlements never carry photos worth showing, and trashed expenses are left out.
 */
export const albumDays = (expenses: Expense[], kind: PhotoKind): AlbumDay[] => {
  const sorted = expenses
    .filter(e => !e.deleted_at && !e.is_settlement && (e.photo_urls?.length ?? 0) > 0)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const days: AlbumDay[] = [];
  for (const expense of sorted) {
    const photos = expense.photo_urls
      .filter(path => path && photoKind(expense, path) === kind)
      .map(path => ({ path, expense, kind }));
    if (photos.length === 0) continue;
    const last = days[days.length - 1];
    if (last && last.date === expense.date) last.photos.push(...photos);
    else days.push({ date: expense.date, photos });
  }
  return days;
};

/** How many photos of each kind there are, for the toggle's counters. */
export const albumCounts = (expenses: Expense[]): Record<PhotoKind, number> => {
  const counts: Record<PhotoKind, number> = { item: 0, receipt: 0 };
  for (const e of expenses) {
    if (e.deleted_at || e.is_settlement) continue;
    for (const path of e.photo_urls ?? []) if (path) counts[photoKind(e, path)] += 1;
  }
  return counts;
};
