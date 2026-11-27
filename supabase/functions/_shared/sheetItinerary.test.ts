import { describe, expect, it } from 'vitest';
import { buildSheetItinerary, fetchSheetItinerary, normalizeSheetDate, normalizeSheetTime, parseCsv, sheetIdFromUrl } from './sheetItinerary.ts';

const csv = (rows: string[][]) => rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');

const MAIN = [
  ['日期', '時間', '類型', '行程', '地點', '備註', '連結', '預訂'],
  ['11/14', '', '📅 當天標題', '抵達京都', '京都', '! 記得換日幣', '', ''],
  ['', '9:30:00', '✈️ 航班', '桃園 → 關西 CI152', '', '', '', '✅ 已付款'],
  ['', '13:00-14:30', '🚆 交通', '搭 Haruka 到京都', '', '', '', ''],
  ['', '下午 3:00', '🏯 景點', '伏見稻荷', '伏見稻荷大社', '人很多\n早點去', 'https://maps.app.goo.gl/abc', ''],
  ['', '晚上', '🍜 美食', '晚餐', '', '', 'https://tabelog.com/x', '⏳ 待預訂'],
  ['2026/11/15', '', '🏯 景點', '清水寺、二年坂', '清水寺、二年坂', '', '', ''],
  ['', '', '', '', '', '', '', ''],
];
const STAYS = [
  ['入住日期', '退房日期', '住宿名稱', '地址', '連結', '備註'],
  ['11/14', '11/16', '京都站前飯店', '京都市下京區', 'https://example.com/h', '含早餐'],
];
const CHECK = [['要準備的東西'], ['護照'], ['網卡'], ['']];

describe('sheetItinerary', () => {
  it('parses quoted CSV with newlines', () => {
    expect(parseCsv('a,"b,c","d\n""e"""\r\n1,2,3')).toEqual([['a', 'b,c', 'd\n"e"'], ['1', '2', '3']]);
  });

  it('reads sheet ids from links', () => {
    expect(sheetIdFromUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(sheetIdFromUrl('https://example.com')).toBeNull();
  });

  it('normalizes dates and times', () => {
    expect(normalizeSheetDate('11/14', 2026)).toBe('2026-11-14');
    expect(normalizeSheetDate('2027-1-2', 2026)).toBe('2027-01-02');
    expect(normalizeSheetDate('11/14/2026', 2025)).toBe('2026-11-14');
    expect(normalizeSheetDate('11月14日（五）', 2026)).toBe('2026-11-14');
    expect(normalizeSheetDate('明天', 2026)).toBeNull();
    expect(normalizeSheetTime('9:30:00')).toEqual({ time: '09:30' });
    expect(normalizeSheetTime('下午 3:00')).toEqual({ time: '15:00' });
    expect(normalizeSheetTime('13:00-14:30')).toEqual({ time: '13:00–14:30' });
    expect(normalizeSheetTime('早上')).toEqual({ slot: '早上' });
  });

  it('builds days, items, flights, stays and checklist', () => {
    const doc = buildSheetItinerary({ main: MAIN, stays: STAYS, checklist: CHECK }, '京都五日', 2026)!;
    expect(doc.days.map(d => d.date)).toEqual(['2026-11-14', '2026-11-15']);
    const [d1, d2] = doc.days;
    expect(d1.title).toBe('抵達京都');
    expect(d1.city).toBe('京都');
    expect(d1.tips).toEqual([{ text: '記得換日幣', tone: 'warn' }]);
    expect(d1.items.map(i => i.kind)).toEqual(['flight', 'train', 'sight', 'food']);
    expect(d1.items[0].booking).toEqual({ status: 'paid' });
    expect(d1.items[2].places).toEqual([{ name: '伏見稻荷大社', href: 'https://maps.app.goo.gl/abc' }]);
    expect(d1.items[2].notes).toEqual(['人很多', '早點去']);
    expect(d1.items[3]).toMatchObject({ slot: '晚上', title: '[晚餐](https://tabelog.com/x)', booking: { status: 'todo' } });
    expect(d2.title).toBe('Day 2');
    expect(d2.items[0].places).toEqual([{ name: '清水寺' }, { name: '二年坂' }]);
    expect(doc.flights).toEqual([{ label: '桃園 → 關西 CI152', date: '2026-11-14', depart: '09:30' }]);
    expect(doc.stays?.[0]).toMatchObject({ id: 'stay1', name: '京都站前飯店', checkIn: '2026-11-14', checkOut: '2026-11-16', href: 'https://example.com/h' });
    expect(d1.stay).toBe('stay1');
    expect(d2.stay).toBe('stay1');
    expect(doc.checklist).toEqual({ items: ['護照', '網卡'] });
  });

  it('returns null when the main tab has no days', () => {
    expect(buildSheetItinerary({ main: [['日期', '行程']] }, 'x', 2026)).toBeNull();
    expect(buildSheetItinerary({ main: [['隨便', '東西']] }, 'x', 2026)).toBeNull();
  });

  it('fetches tabs and reports private sheets', async () => {
    const ok = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
    const f = (async (url: string) => {
      if (url.includes(encodeURIComponent('行程'))) return ok(csv(MAIN));
      if (url.includes(encodeURIComponent('住宿'))) return ok(csv(STAYS));
      return ok(csv(MAIN)); // gviz 找不到分頁時回第一個分頁：不能當成行前準備
    }) as typeof fetch;
    const r = await fetchSheetItinerary('id', '京都', 2026, f);
    expect(r.ok && r.doc.days.length).toBe(2);
    expect(r.ok && r.doc.checklist).toBeUndefined();

    const priv = (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    expect(await fetchSheetItinerary('id', 'x', 2026, priv)).toEqual({ ok: false, error: 'not_shared' });
  });
});
