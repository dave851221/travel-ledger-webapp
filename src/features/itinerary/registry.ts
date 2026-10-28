import type React from 'react';
import type { ItineraryPlan } from './types';
import Nagoya2026 from './trips/Nagoya2026';
import Osaka2025 from './trips/Osaka2025';
import TaichungEscape2026 from './trips/TaichungEscape2026';
import Jiuzhaigou2026 from './trips/Jiuzhaigou2026';
import Osaka2026 from './trips/Osaka2026';

/**
 * 旅程 UUID → 行程頁。
 *
 * 一般情況放一份 ItineraryPlan（用 defineItinerary 寫），版面由 ItineraryView 處理。
 * 格式真的裝不下時，才放 `{ component: MyPage }` 自己寫整頁。
 * 新增方式見 docs/ITINERARY_AUTHORING.md。
 */
export type ItineraryEntry = ItineraryPlan | { component: React.FC };

export const ITINERARIES: Record<string, ItineraryEntry> = {
  '2377dcbd-856a-45b3-bb31-eb79b092ca3d': Nagoya2026,
  'ef04ab47-1fa7-4503-99d2-0b084bebe59f': Osaka2025,
  'd7374216-327b-4377-a968-a57bdb1548ea': TaichungEscape2026,
  '851bce67-cdad-4ec9-a25a-4f656f4c2c5a': Jiuzhaigou2026,
  '4feebf82-4405-4b27-9d02-d8bbda3a7a3b': Osaka2026,
};

export const isPlan = (entry: ItineraryEntry): entry is ItineraryPlan => 'days' in entry;

/** Checks if a trip has an itinerary page */
export const hasItinerary = (tripId: string): boolean => !!ITINERARIES[tripId];

export const getItinerary = (tripId: string): ItineraryEntry | null => ITINERARIES[tripId] ?? null;
