import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { exportItineraries, ITINERARY_JSON_VERSION, toItineraryJson } from './export';
import { defineItinerary } from './plan';
import { ITINERARIES, isPlan } from './registry';
// Bot 那邊讀同一份 JSON（supabase/functions/_shared/tools/itinerary.ts）
import { formatDay, formatOverview, MAX_URL_CHARS, searchItinerary } from '../../../supabase/functions/_shared/tools/itinerary';
import type { ItineraryDoc } from '../../../supabase/functions/_shared/tools/types';

describe('toItineraryJson', () => {
  it('drops custom React blocks but keeps the data', () => {
    const json = toItineraryJson(defineItinerary({
      title: 't', theme: 'default',
      overviewExtra: createElement('div', null, 'x'),
      days: [{
        date: '2026-01-01', title: 'd1', extra: createElement('div'),
        items: [{ kind: 'food', title: '拉麵', extra: createElement('span'), notes: ['要排隊'] }],
      }],
    }));
    expect(json.version).toBe(ITINERARY_JSON_VERSION);
    expect(json.overviewExtra).toBeUndefined();
    const day = (json.days as Record<string, unknown>[])[0];
    expect(day.extra).toBeUndefined();
    expect(day.items).toEqual([{ kind: 'food', title: '拉麵', notes: ['要排隊'] }]);
  });
});

describe('exportItineraries', () => {
  it('exports every data-file itinerary and nothing else', () => {
    const exported = exportItineraries();
    const planIds = Object.entries(ITINERARIES).filter(([, e]) => isPlan(e)).map(([id]) => id);
    expect(Object.keys(exported).sort()).toEqual(planIds.sort());
    for (const json of Object.values(exported)) {
      // 一定要能完整地來回序列化，Bot 那邊才讀得到同樣的東西
      expect(JSON.parse(JSON.stringify(json))).toEqual(json);
      expect(Array.isArray(json.days)).toBe(true);
    }
  });
});

describe('Bot 讀得懂輸出的 JSON', () => {
  it.each(Object.entries(exportItineraries()))('%s', (_id, json) => {
    const doc = json as unknown as ItineraryDoc;
    expect(formatOverview(doc)).toContain(doc.title);
    for (const day of doc.days) {
      const text = formatDay(doc, day.date);
      expect(text).toContain(day.date);
      // 網址照樣給（模型回答時要附上），但超過上限的一律拿掉，免得燒 token
      for (const url of text!.match(/https?:\/\/\S+/g) ?? []) expect(url.length).toBeLessThanOrEqual(MAX_URL_CHARS);
    }
    expect(searchItinerary(doc, doc.days[0].title.split(/[\s，・]/)[0]).length).toBeGreaterThan(0);
  });
});
