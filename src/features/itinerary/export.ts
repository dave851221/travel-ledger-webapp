import { ITINERARIES, isPlan } from './registry';
import type { ItineraryPlan } from './types';

/**
 * 行程資料 → 給 LINE Bot 讀的 JSON。
 *
 * `vite build` 結束時由 vite.config.ts 的 itineraryJson plugin 呼叫，
 * 每趟旅程輸出一份 `dist/itinerary/<tripId>.json`，跟著網頁一起部署到 GitHub Pages。
 * Bot 用 WEBAPP_URL 去讀（`line-webhook/itinerary.ts`），改了行程只要 push，不必重新部署 Bot。
 *
 * ⚠️ `extra`／`overviewExtra` 是 React 元件，序列化不了也沒意義，一律丟掉 ——
 *    寫在客製區塊裡的內容 Bot 看不到。`{ component }` 整頁自訂的旅程也沒有 JSON。
 * 行程本來就打包在公開的網頁程式裡，多一份 JSON 不會多洩漏什麼。
 */

/** Bot 那邊的型別在 `_shared/tools/itinerary.ts`，格式改了兩邊要一起動 */
export const ITINERARY_JSON_VERSION = 1;

const DROPPED_KEYS = new Set(['extra', 'overviewExtra']);

export const toItineraryJson = (plan: ItineraryPlan): Record<string, unknown> => {
  const text = JSON.stringify(plan, (key, value) => {
    if (DROPPED_KEYS.has(key)) return undefined;
    if (typeof value === 'function') return undefined;
    // React element（$$typeof 是 Symbol，JSON.stringify 看不到，只能用 in 判斷）
    if (value && typeof value === 'object' && '$$typeof' in value) return undefined;
    return value;
  });
  return { version: ITINERARY_JSON_VERSION, ...JSON.parse(text) };
};

/** 旅程 UUID → JSON。只有資料檔格式的行程才輸出。 */
export const exportItineraries = (): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(ITINERARIES)
      .filter(([, entry]) => isPlan(entry))
      .map(([tripId, entry]) => [tripId, toItineraryJson(entry as ItineraryPlan)]),
  );
