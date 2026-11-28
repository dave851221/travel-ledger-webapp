import type { LucideIcon } from 'lucide-react';
import {
  Anchor, Building2, Citrus, Cloud, Flower, Flower2, KeyRound, Leaf, Map, Mountain, Palmtree, Shell, Sparkles, Sprout, Sun, Waves,
} from 'lucide-react';

/**
 * 行程頁的「色系」。顏色定義在 src/index.css 的 `.it-theme-<key>`（淺色與深色各一組），
 * 這裡放名稱、封面圖示與標題字體。要新增色系：兩邊各加一筆，key 要一致。
 * 開放版的管理員可以在行程分頁換色系（app.trips.itinerary_color，David 2026-11-28）。
 */
export type ThemeKey =
  | 'default' | 'maple' | 'sakura' | 'lake' | 'plum' | 'mystery' | 'alpine'
  | 'sunset' | 'ocean' | 'matcha' | 'lavender' | 'sand' | 'coral' | 'slate' | 'gold' | 'sky' | 'citrus';

export type TitleFont = 'sans' | 'serif' | 'hand';

export interface ThemeSpec {
  label: string;
  /** 封面右上角的淡色圖示 */
  motif: LucideIcon;
  titleFont: TitleFont;
  /** 選擇器上的色塊（淺色模式的封面漸層兩端） */
  swatch: [string, string];
}

export const THEMES: Record<ThemeKey, ThemeSpec> = {
  default: { label: '藏青', motif: Map, titleFont: 'sans', swatch: ['#14213d', '#2b4377'] },
  maple: { label: '楓紅', motif: Leaf, titleFont: 'serif', swatch: ['#6e2618', '#d08a3c'] },
  sakura: { label: '櫻花', motif: Flower2, titleFont: 'serif', swatch: ['#6f2a45', '#e3a0b4'] },
  lake: { label: '湖水', motif: Waves, titleFont: 'hand', swatch: ['#0d4f5c', '#5bb7a6'] },
  plum: { label: '梅紫', motif: Flower2, titleFont: 'serif', swatch: ['#4b1e3a', '#c77a8f'] },
  mystery: { label: '星夜', motif: KeyRound, titleFont: 'sans', swatch: ['#17132e', '#5a4bc4'] },
  alpine: { label: '山林', motif: Mountain, titleFont: 'hand', swatch: ['#1f3b2a', '#8fb48a'] },
  sunset: { label: '夕陽', motif: Sun, titleFont: 'sans', swatch: ['#7a2e14', '#f0a04b'] },
  ocean: { label: '海洋', motif: Anchor, titleFont: 'sans', swatch: ['#0b2e5a', '#2f7fd0'] },
  matcha: { label: '抹茶', motif: Sprout, titleFont: 'hand', swatch: ['#3f5222', '#a3b86c'] },
  lavender: { label: '薰衣草', motif: Flower, titleFont: 'serif', swatch: ['#3d2f6b', '#a993d9'] },
  sand: { label: '沙丘', motif: Palmtree, titleFont: 'serif', swatch: ['#6b4f2a', '#d9b98a'] },
  coral: { label: '珊瑚', motif: Shell, titleFont: 'sans', swatch: ['#7d2a35', '#f08a7e'] },
  slate: { label: '石墨', motif: Building2, titleFont: 'sans', swatch: ['#1f2329', '#5b6573'] },
  gold: { label: '金秋', motif: Sparkles, titleFont: 'serif', swatch: ['#5a3d0c', '#d4a43a'] },
  sky: { label: '晴空', motif: Cloud, titleFont: 'hand', swatch: ['#1d5f99', '#8cc8ef'] },
  citrus: { label: '柑橘', motif: Citrus, titleFont: 'sans', swatch: ['#8a5a00', '#f2c230'] },
};

export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];
export const isThemeKey = (v: unknown): v is ThemeKey => typeof v === 'string' && v in THEMES;

/**
 * 行程頁的「呈現方式」（版面），跟色系分開選（app.trips.itinerary_style）。
 * 樣式在 src/index.css 的 `.it-style-<key>`；titleFont 有值時蓋過色系的字體。
 */
export type StyleKey = 'classic' | 'journal' | 'magazine' | 'minimal';

export interface StyleSpec { label: string; hint: string; titleFont?: TitleFont }

export const STYLES: Record<StyleKey, StyleSpec> = {
  classic: { label: '經典', hint: '彩色封面＋時間軸' },
  journal: { label: '手帳', hint: '手寫字、紙張質感、虛線格', titleFont: 'hand' },
  magazine: { label: '雜誌', hint: '大封面、大標題，適合分享', titleFont: 'serif' },
  minimal: { label: '簡約', hint: '白底細線、字小行距密，一頁看更多' },
};

export const STYLE_KEYS = Object.keys(STYLES) as StyleKey[];
export const isStyleKey = (v: unknown): v is StyleKey => typeof v === 'string' && v in STYLES;

/** 存在資料庫的值 → 目前有的呈現方式（2026-11-28 拿掉「卡片」、「精簡」併進「簡約」，舊值照樣認得） */
export function normalizeStyle(v: unknown): StyleKey | null {
  if (v === 'compact') return 'minimal';
  if (v === 'cards') return 'classic';
  return isStyleKey(v) ? v : null;
}

export const TITLE_FONT_FAMILY: Record<TitleFont, string> = {
  sans: "'Noto Sans TC', system-ui, sans-serif",
  serif: "'Noto Serif TC', 'Songti TC', serif",
  hand: "'LXGW WenKai TC', 'Kaiti TC', serif",
};

/** 只在用到時才向 Google Fonts 要字型，沒用到的行程頁不必下載 */
export const TITLE_FONT_HREF: Partial<Record<TitleFont, string>> = {
  serif: 'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@600;700&display=swap',
  hand: 'https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC:wght@400;700&display=swap',
};
