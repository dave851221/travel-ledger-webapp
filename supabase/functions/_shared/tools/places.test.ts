import { describe, it, expect, beforeEach } from 'vitest';
import { distanceMeters, searchPlaces } from './places.ts';
import type { ItineraryDoc, ToolContext } from './types.ts';

const PLAN: ItineraryDoc = {
  version: 1,
  title: '台中',
  timeZone: 'Asia/Taipei',
  days: [
    {
      date: '2026-10-31', title: '密室', city: '台中',
      items: [{ time: '11:30', kind: 'activity', title: 'ROOMIN', places: [{ name: 'ROOMIN', lat: 24.1415, lng: 120.6797 }] }],
    },
    {
      date: '2026-11-01', title: '劇本殺', city: '台中',
      items: [{ time: '13:00', kind: 'activity', title: '劇本殺', places: [{ name: '貓頭鷹', query: '貓頭鷹劇本殺 台中' }] }],
    },
  ],
};

const SEARCH = 'https://places.googleapis.com/v1/places:searchText';
const MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }
let calls: Call[] = [];
let searchResponse: { status: number; body: unknown } = { status: 200, body: {} };
let geocodeResponse: unknown = {};
let matrixOk = true;

const fakeFetch = ((url: string, init: RequestInit) => {
  const headers = init.headers as Record<string, string>;
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  calls.push({ url, headers, body });
  const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
  if (url === MATRIX) {
    if (!matrixOk) return json({ error: { message: 'Routes API disabled' } }, 403);
    const perMode: Record<string, number> = { WALK: 600, TRANSIT: 420, DRIVE: 300 };
    const destinations = body.destinations as unknown[];
    return json(destinations.map((_d, i) => ({
      originIndex: 0, destinationIndex: i, condition: 'ROUTE_EXISTS', duration: `${perMode[body.travelMode as string] * (i + 1)}s`,
    })));
  }
  if (headers['X-Goog-FieldMask'] === 'places.displayName,places.location') return json(geocodeResponse);
  return json(searchResponse.body, searchResponse.status);
}) as unknown as typeof fetch;

const ctxWith = (placesApiKey?: string, today = '2026-10-31') => ({
  db: null, today, trip: { id: 't', timezone: 'Asia/Taipei' },
  loadItinerary: () => Promise.resolve(PLAN), fetch: fakeFetch, placesApiKey,
}) as unknown as ToolContext;

const searchCall = () => calls.find((c) => c.url === SEARCH && c.headers['X-Goog-FieldMask'].includes('googleMapsUri'))!;

beforeEach(() => {
  calls = [];
  matrixOk = true;
  geocodeResponse = {};
});

describe('distanceMeters', () => {
  it('台中兩點的直線距離', () => {
    // 市府路 ROOMIN → 宮原眼科，大約 600 公尺
    const d = distanceMeters({ lat: 24.1415, lng: 120.6797 }, { lat: 24.1378, lng: 120.6838 });
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(700);
  });
});

describe('searchPlaces', () => {
  it('沒給 near：以當天行程為中心偏好附近，附上距離與三種交通的分鐘數；歇業的濾掉、追蹤參數拿掉', async () => {
    searchResponse = {
      status: 200,
      body: {
        places: [
          {
            displayName: { text: '宮原眼科' }, formattedAddress: '台中市中區中山路20號',
            googleMapsUri: 'https://maps.google.com/?cid=1&g_mp=Cidnb29nbGUubWFwcy5wbGFjZXM',
            rating: 4.3, userRatingCount: 51234, businessStatus: 'OPERATIONAL', location: { latitude: 24.1378, longitude: 120.6838 },
          },
          { displayName: { text: '舊店' }, googleMapsUri: 'https://maps.google.com/?cid=2', businessStatus: 'CLOSED_PERMANENTLY' },
          { displayName: { text: '沒有連結' } },
        ],
      },
    };
    const out = await searchPlaces({ query: '宮原眼科' }, ctxWith('KEY'));
    const { headers, body } = searchCall();
    expect(headers['X-Goog-Api-Key']).toBe('KEY');
    expect(body).toMatchObject({
      textQuery: '宮原眼科', languageCode: 'zh-TW', regionCode: 'TW',
      locationBias: { circle: { center: { latitude: 24.1415, longitude: 120.6797 } } },
    });
    expect(body.locationRestriction).toBeUndefined();
    expect(calls.filter((c) => c.url === MATRIX).map((c) => c.body.travelMode).sort()).toEqual(['DRIVE', 'TRANSIT', 'WALK']);
    expect(out).toMatchObject({
      query: '宮原眼科', from: '台中',
      places: [{
        name: '宮原眼科', address: '台中市中區中山路20號', maps_url: 'https://maps.google.com/?cid=1',
        rating: 4.3, rating_count: 51234, walk_min: 10, transit_min: 7, drive_min: 5,
      }],
    });
    expect((out.places as { distance_m: number }[])[0].distance_m).toBeGreaterThan(500);
    expect((out.places as unknown[])).toHaveLength(1);
  });

  it('給了 near：行程上同名但沒座標的地點用它的搜尋字 geocode，只在半徑內找，範圍外的切掉', async () => {
    geocodeResponse = { places: [{ displayName: { text: '貓頭鷹劇本殺' }, location: { latitude: 24.15, longitude: 120.66 } }] };
    searchResponse = {
      status: 200,
      body: {
        places: [
          { displayName: { text: '近的' }, googleMapsUri: 'https://maps.google.com/?cid=10', location: { latitude: 24.152, longitude: 120.661 } },
          // 矩形角落、但超出 1000 公尺的圓
          { displayName: { text: '角落' }, googleMapsUri: 'https://maps.google.com/?cid=11', location: { latitude: 24.1585, longitude: 120.6695 } },
        ],
      },
    };
    const out = await searchPlaces({ query: '拉麵', near: '貓頭鷹', date: '2026-11-01' }, ctxWith('KEY'));
    const geocode = calls.find((c) => c.headers['X-Goog-FieldMask'] === 'places.displayName,places.location')!;
    expect(geocode.body.textQuery).toBe('貓頭鷹劇本殺 台中');
    const { body } = searchCall();
    expect(body.locationBias).toBeUndefined();
    const rect = (body.locationRestriction as { rectangle: { low: { latitude: number }; high: { latitude: number } } }).rectangle;
    expect(rect.low.latitude).toBeLessThan(24.15);
    expect(rect.high.latitude).toBeGreaterThan(24.15);
    expect(out).toMatchObject({ from: '貓頭鷹', radius_m: 1000 });
    expect((out.places as { name: string }[]).map((p) => p.name)).toEqual(['近的']);
  });

  it('near 找不到位置就問使用者，不亂猜', async () => {
    const out = await searchPlaces({ query: '拉麵', near: '不存在的地方' }, ctxWith('KEY'));
    expect(out.error).toMatch(/Could not locate/);
  });

  it('半徑內沒有就明講，不拿遠的充數', async () => {
    searchResponse = { status: 200, body: {} };
    const out = await searchPlaces({ query: '米其林三星', near: 'ROOMIN', radius_m: 800 }, ctxWith('KEY'));
    expect(out).toMatchObject({ places: [], from: 'ROOMIN', radius_m: 800 });
    expect(out.note).toMatch(/Nothing within 800 m/);
  });

  it('路線 API 失敗時照樣回結果，只是沒有分鐘數', async () => {
    matrixOk = false;
    searchResponse = {
      status: 200,
      body: { places: [{ displayName: { text: '宮原眼科' }, googleMapsUri: 'https://maps.google.com/?cid=1', location: { latitude: 24.1378, longitude: 120.6838 } }] },
    };
    const out = await searchPlaces({ query: '宮原眼科' }, ctxWith('KEY'));
    const place = (out.places as Record<string, unknown>[])[0];
    expect(place.distance_m).toBeDefined();
    expect(place.walk_min).toBeUndefined();
  });

  it('全部都歇業時只回名稱與狀態，不給連結', async () => {
    searchResponse = {
      status: 200,
      body: { places: [{ displayName: { text: '三圓綠豆湯' }, googleMapsUri: 'https://maps.google.com/?cid=3', businessStatus: 'CLOSED_PERMANENTLY' }] },
    };
    const out = await searchPlaces({ query: '三圓綠豆湯' }, ctxWith('KEY'));
    expect(out).toMatchObject({ places: [], closed: ['三圓綠豆湯（已歇業）'] });
    expect(JSON.stringify(out)).not.toContain('cid=3');
  });

  it('沒有 key 就不打 API，叫模型不要附連結', async () => {
    const out = await searchPlaces({ query: '宮原眼科' }, ctxWith(undefined));
    expect(calls).toHaveLength(0);
    expect(out.error).toMatch(/not configured/);
  });

  it('API 失敗時明講，不要給連結', async () => {
    searchResponse = { status: 403, body: { error: { message: 'API key not valid' } } };
    expect((await searchPlaces({ query: '宮原眼科' }, ctxWith('KEY'))).error).toMatch(/HTTP 403/);
  });
});
