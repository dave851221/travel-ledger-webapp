import type { LucideIcon } from 'lucide-react';
import { Flower2, KeyRound, Leaf, Map, Mountain, Waves } from 'lucide-react';

/**
 * 行程頁的風格。顏色定義在 src/index.css 的 `.it-theme-<key>`（淺色與深色各一組），
 * 這裡只放封面圖示與標題字體。要新增風格：兩邊各加一筆，key 要一致。
 */
export type ThemeKey = 'default' | 'maple' | 'sakura' | 'lake' | 'plum' | 'mystery' | 'alpine';

export type TitleFont = 'sans' | 'serif' | 'hand';

export interface ThemeSpec {
  /** 封面右上角的淡色圖示 */
  motif: LucideIcon;
  titleFont: TitleFont;
}

export const THEMES: Record<ThemeKey, ThemeSpec> = {
  default: { motif: Map, titleFont: 'sans' },
  maple: { motif: Leaf, titleFont: 'serif' },
  sakura: { motif: Flower2, titleFont: 'serif' },
  lake: { motif: Waves, titleFont: 'hand' },
  plum: { motif: Flower2, titleFont: 'serif' },
  mystery: { motif: KeyRound, titleFont: 'sans' },
  alpine: { motif: Mountain, titleFont: 'hand' },
};

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
