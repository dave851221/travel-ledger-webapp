import { describe, it, expect } from 'vitest';
import { buildLiffEchoMarker, buildLiffPageUrl as liffPageUrl, looksLikeLiffEcho, pickLiffNotice, LIFF_NOTICE_TTL_MS } from './liffEcho';

describe('liffEcho', () => {
  it('暗號像人話，機器人認得出來', () => {
    const m = buildLiffEchoMarker(false, ' 拉麵  一蘭 ', 1200, 'JPY');
    expect(m).toBe('✅ 已記帳：拉麵 一蘭 1200 JPY');
    expect(looksLikeLiffEcho(m)).toBe(true);
    expect(looksLikeLiffEcho(buildLiffEchoMarker(true, '拉麵', 1, 'JPY'))).toBe(true);
    expect(looksLikeLiffEcho('拉麵 1200')).toBe(false);
  });

  it('只挑暗號對得上、沒過期的那一列', () => {
    const now = Date.parse('2026-11-19T08:00:00Z');
    const row = (id: number, marker: string, ago: number) => ({
      id, created_at: new Date(now - ago).toISOString(),
      content: JSON.stringify({ marker, text: `T${id}` }),
    });
    const rows = [row(3, '✅ 已記帳：B 1 JPY', 1000), row(2, '✅ 已記帳：A 1 JPY', 2000), row(1, '✅ 已記帳：A 1 JPY', LIFF_NOTICE_TTL_MS + 1)];
    expect(pickLiffNotice(rows, '✅ 已記帳：A 1 JPY', now)?.id).toBe(2);
    expect(pickLiffNotice([rows[2]], '✅ 已記帳：A 1 JPY', now)).toBeNull();
    expect(pickLiffNotice([{ id: 9, created_at: rows[0].created_at, content: 'x' }], 'x', now)).toBeNull();
  });
});

describe('liffPageUrl', () => {
  it('有 LIFF ID 走 liff.line.me，沒有就直接開網頁', () => {
    expect(liffPageUrl('/liff/edit', 'tripId=t&n=1', '123-abc', 'https://w')).toBe('https://liff.line.me/123-abc?route=/liff/edit&tripId=t&n=1');
    expect(liffPageUrl('/liff/edit', 'tripId=t&n=1', '', 'https://w')).toBe('https://w/#/liff/edit?tripId=t&n=1');
  });
});
