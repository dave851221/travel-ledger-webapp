import { describe, it, expect } from 'vitest';
import {
  dayCoordinates,
  formatDay,
  formatOverview,
  getItineraryDay,
  itineraryTodayLine,
  linkedText,
  MAX_URL_CHARS,
  noteLines,
  plainText,
  searchItinerary,
} from './itinerary.ts';
import { describeWeatherCode, getWeather } from './weather.ts';
import type { ItineraryDoc, ToolContext } from './types.ts';

const PLAN: ItineraryDoc = {
  version: 1,
  title: '名古屋賞櫻',
  timeZone: 'Asia/Tokyo',
  flights: [{ label: '去程', date: '2026-04-04', number: 'CI150', to: '名古屋 NGO', arrive: '21:05' }],
  stays: [
    { id: 'suimeikan', name: '下呂溫泉水明館', city: '下呂', checkIn: '2026-04-05', checkOut: '2026-04-06', notes: ['可免費停車，入浴稅 ¥150', { text: '最晚 19:00 入住', tone: 'warn' }] },
  ],
  bookings: [{ date: '2026-04-06', item: '[白川鄉](https://example.com) 停車場', status: 'todo' }],
  days: [
    { date: '2026-04-04', title: '抵達名古屋', city: '名古屋', items: [{ time: '21:05', kind: 'flight', title: '抵達中部機場' }] },
    {
      date: '2026-04-05', title: '犬山祭', city: '犬山', stay: 'suimeikan',
      route: [[35.38, 136.94]],
      tips: ['**早點出門**'],
      items: [
        { time: '09:00', kind: 'sight', title: '[犬山城](https://maps.app.goo.gl/x)', booking: { status: 'paid' }, notes: ['門票 ¥1,000'] },
        { slot: '午餐', kind: 'food', title: '五平餅', undecided: true, places: [{ name: '本町通', lat: 35.38, lng: 136.94 }] },
      ],
    },
  ],
};

describe('行程的文字格式', () => {
  it('連結只留名稱、粗體去掉', () => {
    expect(plainText('前往[犬山城](https://x)，**16:00 打烊**')).toBe('前往犬山城，16:00 打烊');
  });

  it('備註攤平，warn 加上 ⚠️', () => {
    expect(noteLines([{ text: '必看', tone: 'warn', items: ['子項'] }])).toEqual(['· ⚠️ 必看', '  · 子項']);
  });

  it('某一天：時間、類型、預約、未定、當晚住宿都在，行程附的網址跟著名稱', () => {
    const text = formatDay(PLAN, '2026-04-05')!;
    expect(text).toContain('第 2/2 天｜犬山｜犬山祭');
    expect(text).toContain('09:00 [景點] 犬山城 https://maps.app.goo.gl/x 〔已付清〕');
    expect(text).toContain('午餐 [餐飲] 五平餅 地點：本町通 （未定）');
    expect(text).toContain('今晚住宿：下呂溫泉水明館');
    expect(text).toContain('⚠️ 最晚 19:00 入住');
    // 住宿沒有附地圖、也沒寫地址：用名稱組一個地圖搜尋連結
    expect(text).toContain('地圖：https://www.google.com/maps/search/?api=1&query=');
    expect(formatDay(PLAN, '2026-05-01')).toBeNull();
  });

  it('地點、車票的網址都附上；太長的網址只留名稱', () => {
    const long = `https://www.google.com/maps/place/${'x'.repeat(MAX_URL_CHARS)}`;
    expect(linkedText(`[清水寺](https://maps.app.goo.gl/a)與[金閣寺](${long})`)).toBe('清水寺 https://maps.app.goo.gl/a與金閣寺');
    const plan: ItineraryDoc = {
      ...PLAN,
      stays: [{ id: 's', name: '飯店', checkIn: '2026-04-05', checkOut: '2026-04-06', href: 'https://maps.app.goo.gl/h' }],
      days: [{
        date: '2026-04-05', title: 'd', stay: 's',
        items: [{
          time: '16:02', kind: 'train', title: '小火車',
          places: [{ name: 'トロッコ嵯峨', href: 'https://maps.app.goo.gl/s' }, { name: '嵐山', query: '嵐山' }],
          booking: { status: 'paid', href: 'https://linkt.to/t' },
        }],
      }],
    };
    const text = formatDay(plan, '2026-04-05')!;
    expect(text).toContain('地點：トロッコ嵯峨 https://maps.app.goo.gl/s、嵐山');
    expect(text).toContain('〔已付清 https://linkt.to/t〕');
    expect(text).toContain('地圖：https://maps.app.goo.gl/h');
  });

  it('總覽：每天一行，加上航班、住宿與待預訂提醒', () => {
    const text = formatOverview(PLAN);
    expect(text).toContain('D2 2026-04-05（日） 犬山：犬山祭（住 下呂溫泉水明館）');
    expect(text).toContain('CI150');
    expect(text).toContain('白川鄉 https://example.com 停車場〔待預訂〕');
    expect(text).toContain('還有 1 項待預訂或未確認');
  });
});

describe('searchItinerary', () => {
  it('多個詞命中越多排越前面，住宿的備註也搜得到', () => {
    const hits = searchItinerary(PLAN, '水明館 停車');
    expect(hits[0]).toContain('住宿 下呂溫泉水明館');
    expect(hits[0]).toContain('可免費停車');
  });

  it('預訂狀態的字眼也搜得到；沒命中回空陣列', () => {
    expect(searchItinerary(PLAN, '待預訂')[0]).toContain('白川鄉');
    expect(searchItinerary(PLAN, '迪士尼')).toEqual([]);
    expect(searchItinerary(PLAN, '  ')).toEqual([]);
  });
});

describe('itineraryTodayLine', () => {
  it('出發前、旅途中、結束後各一種說法', () => {
    expect(itineraryTodayLine(PLAN, '2026-04-01')).toContain('還沒出發');
    expect(itineraryTodayLine(PLAN, '2026-04-05')).toContain('今天第 2 天・犬山・犬山祭・今晚住 下呂溫泉水明館');
    expect(itineraryTodayLine(PLAN, '2026-04-09')).toContain('行程已結束');
  });
});

describe('工具的 execute', () => {
  const ctx = (plan: ItineraryDoc | null): ToolContext =>
    ({ db: null, today: '2026-04-05', trip: { id: 't' }, loadItinerary: () => Promise.resolve(plan) }) as unknown as ToolContext;

  it('沒有行程表時回錯誤讓模型照實說', async () => {
    expect(await getItineraryDay('2026-04-05', ctx(null))).toHaveProperty('error');
  });

  it('不在行程裡的日期回錯誤並附上有哪些天', async () => {
    const out = await getItineraryDay('2026-06-01', ctx(PLAN));
    expect(out.days).toEqual(['2026-04-04', '2026-04-05']);
  });

  it('沒給日期就是今天', async () => {
    expect(String((await getItineraryDay(undefined, ctx(PLAN))).text)).toContain('犬山祭');
  });
});

describe('getWeather', () => {
  const urls: string[] = [];
  const fakeFetch = ((url: string) => {
    urls.push(url);
    if (url.includes('geocoding')) {
      return Promise.resolve(new Response(JSON.stringify({ results: [{ latitude: 36.14, longitude: 137.25, name: '高山市', admin1: '岐阜縣' }] })));
    }
    return Promise.resolve(new Response(JSON.stringify({
      daily: {
        weather_code: [61], temperature_2m_max: [15], temperature_2m_min: [6],
        precipitation_probability_max: [80], precipitation_sum: [4.2], wind_speed_10m_max: [12],
      },
      hourly: {
        time: ['2026-04-05T08:00', '2026-04-05T14:00', '2026-04-05T20:00'],
        precipitation_probability: [10, 80, 40],
      },
    })));
  }) as unknown as typeof fetch;
  const ctx = {
    db: null, today: '2026-04-05', trip: { id: 't', timezone: 'Asia/Tokyo' },
    loadItinerary: () => Promise.resolve(PLAN), fetch: fakeFetch,
  } as unknown as ToolContext;

  it('沒給地點就用行程那一天的座標，降雨機率分成早中晚', async () => {
    urls.length = 0;
    const out = await getWeather({}, ctx);
    expect(urls[0]).toContain('latitude=35.38');
    expect(out).toMatchObject({
      place: '犬山', weather: '小雨', temp_max_c: 15, temp_min_c: 6,
      rain_probability_by_period: { morning: 10, afternoon: 80, evening: 40 },
    });
  });

  it('給了地點就先 geocode，並用旅程時區限定國家', async () => {
    urls.length = 0;
    const out = await getWeather({ place: 'Takayama', date: '2026-04-05' }, ctx);
    expect(urls[0]).toContain('countryCode=JP');
    expect(out.place).toBe('高山市，岐阜縣');
  });

  it('行程裡沒有那一天的地點時請模型問使用者', async () => {
    const out = await getWeather({ date: '2026-04-20' }, ctx);
    expect(out).toHaveProperty('error');
  });

  it('認不得的天氣代碼照樣回得出東西', () => {
    expect(describeWeatherCode(0)).toBe('晴');
    expect(describeWeatherCode(42)).toBe('代碼 42');
  });

  it('dayCoordinates：路線優先，沒有就找有座標的地點', () => {
    expect(dayCoordinates(PLAN.days[1])).toEqual({ lat: 35.38, lng: 136.94 });
    expect(dayCoordinates(PLAN.days[0])).toBeNull();
  });
});
