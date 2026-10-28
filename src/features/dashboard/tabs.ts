import type { LucideIcon } from 'lucide-react';
import { ChartPie, Compass, Images, LayoutList, Map, Scale, Trash2 } from 'lucide-react';

export type TabType = 'ledger' | 'stats' | 'settlement' | 'itinerary' | 'album' | 'recycle' | 'siblings';

export interface TabDef {
  key: TabType;
  label: string;
  icon: LucideIcon;
}

export const TAB_LEDGER: TabDef = { key: 'ledger', label: '帳目', icon: LayoutList };
export const TAB_STATS: TabDef = { key: 'stats', label: '統計', icon: ChartPie };
export const TAB_SETTLEMENT: TabDef = { key: 'settlement', label: '結清', icon: Scale };
export const TAB_ITINERARY: TabDef = { key: 'itinerary', label: '行程', icon: Map };
export const TAB_ALBUM: TabDef = { key: 'album', label: '相簿', icon: Images };
export const TAB_SIBLINGS: TabDef = { key: 'siblings', label: '其他旅程', icon: Compass };
export const TAB_RECYCLE: TabDef = { key: 'recycle', label: '垃圾桶', icon: Trash2 };

/** The tabs that live in the phone's bottom bar. 相簿、其他旅程與垃圾桶 are in the ⋯ menu. */
export const primaryTabs = (hasItinerary: boolean): TabDef[] =>
  hasItinerary ? [TAB_LEDGER, TAB_STATS, TAB_SETTLEMENT, TAB_ITINERARY] : [TAB_LEDGER, TAB_STATS, TAB_SETTLEMENT];
