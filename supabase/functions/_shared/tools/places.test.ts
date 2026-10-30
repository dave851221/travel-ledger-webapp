import { describe, it, expect } from 'vitest';
import { searchPlaces } from './places.ts';
import type { ItineraryDoc, ToolContext } from './types.ts';

const PLAN: ItineraryDoc = {
  version: 1,
  title: '台中',
  timeZone: 'Asia/Taipei',
  days: [{
    date: '2026-10-31', title: '密室', city: '台中',
    items: [{ time: '11:30', kind: 'activity', title: 'ROOMIN', places: [{ name: 'ROOMIN', lat: 24.15, lng: 120.66 }] }],
  }],
};

const calls: { url: string; init: RequestInit }[] = [];
let response: { status: number; body: unknown } = { status: 200, body: {} };
const fakeFetch = ((url: string, init: RequestInit) => {
  calls.push({ url, init });
  return Promise.resolve(new Response(JSON.stringify(response.body), { status: response.status }));
}) as unknown as typeof fetch;

const ctxWith = (placesApiKey?: string) => ({
  db: null, today: '2026-10-31', trip: { id: 't', timezone: 'Asia/Taipei' },
  loadItinerary: () => Promise.resolve(PLAN), fetch: fakeFetch, placesApiKey,
}) as unknown as ToolContext;

describe('searchPlaces', () => {
  it('帶 key 與 field mask，以行程那一天的座標為中心、限定旅程的國家', async () => {
    calls.length = 0;
    response = {
      status: 200,
      body: {
        places: [
          { displayName: { text: '宮原眼科' }, formattedAddress: '台中市中區中山路20號', googleMapsUri: 'https://maps.google.com/?cid=1&g_mp=Cidnb29nbGUubWFwcy5wbGFjZXM', rating: 4.3, userRatingCount: 51234, businessStatus: 'OPERATIONAL' },
          { displayName: { text: '舊店' }, googleMapsUri: 'https://maps.google.com/?cid=2', businessStatus: 'CLOSED_PERMANENTLY' },
          { displayName: { text: '沒有連結' } },
        ],
      },
    };
    const out = await searchPlaces({ query: '宮原眼科 台中' }, ctxWith('KEY'));
    const { url, init } = calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('KEY');
    expect(headers['X-Goog-FieldMask']).toContain('places.googleMapsUri');
    expect(JSON.parse(init.body as string)).toMatchObject({
      textQuery: '宮原眼科 台中', languageCode: 'zh-TW', regionCode: 'TW',
      locationBias: { circle: { center: { latitude: 24.15, longitude: 120.66 } } },
    });
    expect(out).toEqual({
      query: '宮原眼科 台中',
      places: [
        { name: '宮原眼科', address: '台中市中區中山路20號', maps_url: 'https://maps.google.com/?cid=1', rating: 4.3, rating_count: 51234 },
        { name: '舊店', address: null, maps_url: 'https://maps.google.com/?cid=2', rating: null, rating_count: null, status: '已歇業' },
      ],
    });
  });

  it('沒有 key 就不打 API，叫模型不要附連結', async () => {
    calls.length = 0;
    const out = await searchPlaces({ query: '宮原眼科' }, ctxWith(undefined));
    expect(calls).toHaveLength(0);
    expect(out.error).toMatch(/not configured/);
  });

  it('查不到、或 API 失敗時明講，不要給連結', async () => {
    response = { status: 200, body: {} };
    expect(await searchPlaces({ query: '不存在的店' }, ctxWith('KEY'))).toMatchObject({ places: [] });
    response = { status: 403, body: { error: { message: 'API key not valid' } } };
    expect((await searchPlaces({ query: '宮原眼科' }, ctxWith('KEY'))).error).toMatch(/HTTP 403/);
  });
});
