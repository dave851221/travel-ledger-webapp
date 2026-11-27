import { describe, expect, it } from 'vitest';
import { formatTripDates, formatTripDatesShort, normalizeTripDates, tripDayCount, tripStampParts, tripTime } from './tripDates';

const t = (start_date: string | null, end_date: string | null = null) => ({ start_date, end_date, created_at: '2025-01-15T10:00:00Z' });

describe('normalizeTripDates', () => {
  it('accepts empty, one day and a range', () => {
    expect(normalizeTripDates('', '')).toEqual({ start_date: null, end_date: null });
    expect(normalizeTripDates('2026-11-20', '')).toEqual({ start_date: '2026-11-20', end_date: null });
    expect(normalizeTripDates('2026-11-20', '2026-11-27')).toEqual({ start_date: '2026-11-20', end_date: '2026-11-27' });
  });

  it('treats the same start and end as one day', () => {
    expect(normalizeTripDates('2026-11-20', '2026-11-20')).toEqual({ start_date: '2026-11-20', end_date: null });
  });

  it('rejects an end without a start, an end before the start, and bad formats', () => {
    expect(normalizeTripDates('', '2026-11-20')).toHaveProperty('error');
    expect(normalizeTripDates('2026-11-20', '2026-11-19')).toHaveProperty('error');
    expect(normalizeTripDates('2026/11/20', '')).toHaveProperty('error');
  });
});

describe('formatting', () => {
  it('formats full dates', () => {
    expect(formatTripDates(t(null))).toBeNull();
    expect(formatTripDates(t('2026-11-20'))).toBe('2026/11/20');
    expect(formatTripDates(t('2026-11-20', '2026-11-27'))).toBe('2026/11/20 – 11/27');
    expect(formatTripDates(t('2026-12-30', '2027-01-03'))).toBe('2026/12/30 – 2027/1/3');
  });

  it('formats short dates', () => {
    expect(formatTripDatesShort(t('2026-11-20'))).toBe('11/20');
    expect(formatTripDatesShort(t('2026-11-20', '2026-11-27'))).toBe('11/20–27');
    expect(formatTripDatesShort(t('2026-11-28', '2026-12-03'))).toBe('11/28–12/3');
    expect(formatTripDatesShort(t('2026-12-30', '2027-01-03'))).toBe('12/30–2027/1/3');
  });

  it('counts days inclusively', () => {
    expect(tripDayCount(t(null))).toBeNull();
    expect(tripDayCount(t('2026-11-20'))).toBe(1);
    expect(tripDayCount(t('2026-11-20', '2026-11-27'))).toBe(8);
    expect(tripDayCount(t('2026-02-27', '2026-03-02'))).toBe(4);
  });
});

describe('stamp and sort time', () => {
  it('uses the start date when set, otherwise the creation time', () => {
    expect(tripStampParts(t('2026-04-04', '2026-04-11'))).toEqual({ year: 2026, month: 4 });
    expect(tripStampParts(t(null))).toEqual({ year: 2025, month: 1 });
    expect(tripTime(t('2026-04-04'))).toBeGreaterThan(tripTime(t(null)));
  });
});
