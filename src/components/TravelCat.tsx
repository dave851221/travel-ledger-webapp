import React from 'react';

/**
 * 旅行喵喵：開放版（旅行小本本）的吉祥物，一隻揹著小背包的橘貓（原創角色）。
 * 只在開放版出現；舊版（旅遊小本本）照舊用車票圖示。
 * 顏色固定，不跟深淺色主題變（角色本身的顏色）。
 */

const FUR = '#FFB547';
const FUR_DARK = '#E8913A';
const INK = '#3B2A1E';
const PINK = '#FF8FA3';

/** 貓臉（logo、小圖示用）。viewBox 64×64 */
export const CatFace: React.FC<{ size?: number; className?: string; title?: string }> = ({ size = 32, className, title }) => (
  <svg viewBox="0 0 64 64" width={size} height={size} className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    <CatHead />
  </svg>
);

/** 頭（給其他圖重用），畫在 64×64 的範圍裡 */
const CatHead: React.FC = () => (
  <g>
    <path d="M10 30 L15 7 L30 19 Z" fill={FUR} />
    <path d="M54 30 L49 7 L34 19 Z" fill={FUR} />
    <path d="M14.5 24 L17 13 L24.5 19.5 Z" fill={PINK} />
    <path d="M49.5 24 L47 13 L39.5 19.5 Z" fill={PINK} />
    <ellipse cx="32" cy="37" rx="23" ry="20" fill={FUR} />
    <rect x="30.5" y="18" width="3" height="8" rx="1.5" fill={FUR_DARK} />
    <rect x="24.5" y="19.5" width="3" height="6" rx="1.5" fill={FUR_DARK} transform="rotate(-14 26 22)" />
    <rect x="36.5" y="19.5" width="3" height="6" rx="1.5" fill={FUR_DARK} transform="rotate(14 38 22)" />
    <ellipse cx="23" cy="36" rx="3" ry="3.8" fill={INK} />
    <ellipse cx="41" cy="36" rx="3" ry="3.8" fill={INK} />
    <circle cx="24" cy="34.6" r="1.1" fill="#fff" />
    <circle cx="42" cy="34.6" r="1.1" fill="#fff" />
    <ellipse cx="17" cy="43" rx="4" ry="2.4" fill={PINK} opacity=".45" />
    <ellipse cx="47" cy="43" rx="4" ry="2.4" fill={PINK} opacity=".45" />
    <path d="M30 41.5 h4 l-2 2.4 z" fill={PINK} />
    <path d="M28.5 45 q1.75 2.2 3.5 0 q1.75 2.2 3.5 0" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round" />
    <path d="M8 38 h8 M8.5 43 l7.5 -1.5 M56 38 h-8 M55.5 43 l-7.5 -1.5" stroke={INK} strokeWidth="1.1" strokeLinecap="round" opacity=".55" />
  </g>
);

/**
 * 揹著背包的旅行喵喵（登入頁、空狀態、完成畫面用）。viewBox 120×120
 * mood：happy＝一般；sleepy＝閉眼（沒資料時）
 */
export const CatTraveler: React.FC<{ size?: number; className?: string; title?: string }> = ({ size = 120, className, title }) => (
  <svg viewBox="0 0 120 120" width={size} height={size} className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    {/* 尾巴 */}
    <path d="M86 96 C104 96 108 78 100 70" fill="none" stroke={FUR} strokeWidth="7" strokeLinecap="round" />
    <path d="M100.5 71 l-2 -4" stroke={FUR_DARK} strokeWidth="7" strokeLinecap="round" />
    {/* 背包（在身體後面） */}
    <rect x="72" y="58" width="24" height="30" rx="7" fill="#8A5A3B" />
    <rect x="75" y="66" width="18" height="10" rx="3" fill="#A8714C" />
    <circle cx="84" cy="71" r="1.6" fill="#F3D27A" />
    {/* 身體 */}
    <ellipse cx="58" cy="86" rx="27" ry="22" fill={FUR} />
    <ellipse cx="58" cy="92" rx="15" ry="13" fill="#FFE2B8" />
    {/* 背帶 */}
    <path d="M44 66 Q50 82 47 102" fill="none" stroke="#8A5A3B" strokeWidth="4" strokeLinecap="round" />
    {/* 腳 */}
    <ellipse cx="45" cy="106" rx="8" ry="5" fill={FUR} />
    <ellipse cx="71" cy="106" rx="8" ry="5" fill={FUR} />
    {/* 圍巾 */}
    <path d="M36 66 Q58 76 80 66 L80 71 Q58 81 36 71 Z" fill="#E4574B" />
    <path d="M70 72 l6 12 l-7 -2 z" fill="#E4574B" />
    {/* 頭 */}
    <g transform="translate(26 6) scale(1)">
      <CatHead />
    </g>
  </svg>
);
