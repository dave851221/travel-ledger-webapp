import { describe, expect, it } from 'vitest';
import type { Expense } from '../types';
import {
  ALBUM_MIN_COLUMNS,
  albumCellOffset,
  albumCounts,
  albumDays,
  albumGridHeight,
  albumLayoutColumns,
  albumMaxColumns,
  clampAlbumColumns,
  defaultAlbumColumns,
  photoKind,
  pinchColumnsFraction,
  rubberBandColumns,
} from './album';

const exp = (over: Partial<Expense>): Expense => ({
  id: 'x', trip_id: 't', date: '2026-11-15', category: '餐飲', description: 'd', amount: 100, currency: 'JPY',
  payer_data: {}, split_data: {}, adjustment_member: null, photo_urls: [], receipt_photo_urls: [],
  is_settlement: false, deleted_at: null, created_at: '2026-11-15T10:00:00Z',
  ...over,
});

describe('album', () => {
  const lunch = exp({ id: 'a', photo_urls: ['p/1.jpg', 'p/2.jpg'], receipt_photo_urls: ['p/2.jpg'] });
  const dinner = exp({ id: 'b', created_at: '2026-11-15T20:00:00Z', photo_urls: ['p/3.jpg'] });
  const nextDay = exp({ id: 'c', date: '2026-11-16', photo_urls: ['p/4.jpg'], receipt_photo_urls: ['p/4.jpg'] });
  const trashed = exp({ id: 'd', photo_urls: ['p/5.jpg'], deleted_at: '2026-11-15T21:00:00Z' });
  const all = [lunch, dinner, nextDay, trashed];

  it('treats photos as items unless they are marked as receipts', () => {
    expect(photoKind(lunch, 'p/1.jpg')).toBe('item');
    expect(photoKind(lunch, 'p/2.jpg')).toBe('receipt');
    expect(photoKind(exp({ photo_urls: ['p/9.jpg'], receipt_photo_urls: undefined }), 'p/9.jpg')).toBe('item');
  });

  it('groups by day, newest first, and newer expenses first within a day', () => {
    const items = albumDays(all, 'item');
    expect(items.map(d => d.date)).toEqual(['2026-11-15']);
    expect(items[0].photos.map(p => p.path)).toEqual(['p/3.jpg', 'p/1.jpg']);
    expect(albumDays(all, 'receipt').map(d => [d.date, d.photos.map(p => p.path)])).toEqual([
      ['2026-11-16', ['p/4.jpg']],
      ['2026-11-15', ['p/2.jpg']],
    ]);
  });

  it('leaves out trashed expenses and settlements', () => {
    const settle = exp({ id: 's', is_settlement: true, photo_urls: ['p/6.jpg'] });
    expect(albumCounts([...all, settle])).toEqual({ item: 2, receipt: 2 });
  });
});

describe('album grid columns', () => {
  const PHONE = 390;
  const DESKTOP = 1440;

  it('starts bigger on small screens', () => {
    expect(defaultAlbumColumns(PHONE)).toBe(4);
    expect(defaultAlbumColumns(800)).toBe(6);
    expect(defaultAlbumColumns(DESKTOP)).toBe(8);
  });

  it('stays inside the range for the screen width', () => {
    expect(clampAlbumColumns(1, PHONE)).toBe(ALBUM_MIN_COLUMNS);
    expect(clampAlbumColumns(99, PHONE)).toBe(albumMaxColumns(PHONE));
    expect(clampAlbumColumns(99, DESKTOP)).toBe(albumMaxColumns(DESKTOP));
    expect(clampAlbumColumns(5.4, PHONE)).toBe(5);
  });

  it('follows the fingers between whole column counts', () => {
    expect(pinchColumnsFraction(4, 100, 200)).toBe(2);
    expect(pinchColumnsFraction(4, 100, 125)).toBe(3.2);
    expect(pinchColumnsFraction(4, 100, 100)).toBe(4);
    expect(pinchColumnsFraction(4, 200, 100)).toBe(8);
  });

  it('ignores a pinch with no measurable distance', () => {
    expect(pinchColumnsFraction(4, 0, 100)).toBe(4);
    expect(pinchColumnsFraction(4, 100, 0)).toBe(4);
  });

  it('resists past the limits instead of stopping dead', () => {
    expect(rubberBandColumns(3.4, PHONE)).toBe(3.4);
    expect(rubberBandColumns(1, PHONE)).toBeCloseTo(1.7);
    expect(rubberBandColumns(10, PHONE)).toBeCloseTo(7.9);
    expect(rubberBandColumns(10, DESKTOP)).toBe(10);
  });

  it('lays out enough columns to scale up, never down', () => {
    expect(albumLayoutColumns(3.2, PHONE)).toBe(4);
    expect(albumLayoutColumns(4, PHONE)).toBe(4);
    // What a float tween really lands on must not tip into the next column
    expect(albumLayoutColumns(3.1 + (4 - 3.1), PHONE)).toBe(4);
    expect(albumLayoutColumns(1.7, PHONE)).toBe(ALBUM_MIN_COLUMNS);
    expect(albumLayoutColumns(7.9, PHONE)).toBe(albumMaxColumns(PHONE));
  });

  it('finds a photo in the grid from the arithmetic alone', () => {
    // 4 columns of 100 with 2px gaps: (406 - 6) / 4
    expect(albumCellOffset(0, 4, 406, 2)).toEqual({ x: 0, y: 0, size: 100 });
    expect(albumCellOffset(6, 4, 406, 2)).toEqual({ x: 204, y: 102, size: 100 });
  });

  it('measures the grid, including a part-filled last row', () => {
    expect(albumGridHeight(4, 4, 406, 2)).toBe(100);
    expect(albumGridHeight(5, 4, 406, 2)).toBe(202);
    expect(albumGridHeight(0, 4, 406, 2)).toBe(0);
  });
});
