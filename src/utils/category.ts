import type { LucideIcon } from 'lucide-react';
import { ArrowLeftRight, BedDouble, ShoppingBag, Tag, Ticket, TramFront, Utensils } from 'lucide-react';

export interface CategoryVisual {
  /** Mid-tone hex that reads on both light and dark surfaces; tint it for backgrounds */
  color: string;
  icon: LucideIcon;
}

// Matched against the category name, so custom names like「午餐」「計程車」still get the right look.
const KEYWORD_VISUALS: Array<[RegExp, CategoryVisual]> = [
  [/結清/, { color: '#2e9e6a', icon: ArrowLeftRight }],
  [/食|飯|餐|吃|飲/, { color: '#d9822b', icon: Utensils }],
  [/住|宿|店/, { color: '#4a6fc0', icon: BedDouble }],
  [/行|車|交通|機|票券/, { color: '#2e9a80', icon: TramFront }],
  [/樂|玩|門票|景點|遊/, { color: '#8a68c4', icon: Ticket }],
  [/買|物|街|藥妝/, { color: '#c2527a', icon: ShoppingBag }],
];

// Fallback hues for custom categories, deliberately muted so they don't fight the amber accent.
const PALETTE = ['#5c7fa8', '#3f9aa6', '#a3784a', '#7d72b8', '#b0636f', '#5f9a5b', '#8a8f3c', '#a86a9c'];

function polyHash(str: string): number {
  let h = 0;
  for (const ch of str) {
    h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(h);
}

/**
 * Colour and icon for a category badge or tile.
 * Pass the trip's full categories array so each custom category
 * gets a deterministically distinct colour via its array index.
 */
export function getCategoryVisual(category: string, categories?: string[]): CategoryVisual {
  for (const [re, visual] of KEYWORD_VISUALS) {
    if (re.test(category)) return visual;
  }

  const idx = categories ? categories.indexOf(category) : -1;
  const color = idx >= 0 ? PALETTE[idx % PALETTE.length] : PALETTE[polyHash(category) % PALETTE.length];
  return { color, icon: Tag };
}
