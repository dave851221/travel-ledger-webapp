import React from 'react';

/** 行程頁可用的強調色。與 Tailwind 的顏色名稱對應。 */
export type ItineraryAccent = 'blue' | 'teal' | 'rose' | 'indigo' | 'amber' | 'emerald';

// Tailwind 會掃描原始碼決定要產生哪些 class，
// 所以必須寫成完整字串，不能用 `border-${accent}-600` 這種拼接。
const ACCENT_BORDER: Record<ItineraryAccent, string> = {
  blue: 'border-blue-600',
  teal: 'border-teal-600',
  rose: 'border-rose-600',
  indigo: 'border-indigo-600',
  amber: 'border-amber-600',
  emerald: 'border-emerald-600',
};

export interface ItineraryCardProps {
  /** 時間軸圓點裡的圖示，直接用 emoji 即可（例如 '🚄'、'🍜'、'🏨'） */
  icon: string;
  /** 時間軸圓點的顏色，預設藍色 */
  accent?: ItineraryAccent;
  children: React.ReactNode;
}

/**
 * 時間軸樣式的行程卡片：左側一條連續的線 + 一個圖示圓點，右側是內容。
 *
 * 連續放好幾張就會自動接成一條時間軸，最後一張不會留下多餘的下方間距。
 */
const ItineraryCard: React.FC<ItineraryCardProps> = ({ icon, accent = 'blue', children }) => (
  <div className="relative pl-8 sm:pl-10 pb-8 last:pb-0">
    <div className="absolute left-3.5 sm:left-4 top-0 bottom-0 w-0.5 bg-slate-100 dark:bg-slate-800" />
    <div
      className={`absolute left-0 top-0 w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white dark:bg-slate-800 border-2 ${ACCENT_BORDER[accent]} flex items-center justify-center z-10 shadow-sm text-xs sm:text-sm`}
    >
      {icon}
    </div>
    <div className="bg-slate-50/50 dark:bg-slate-800/30 rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-slate-100 dark:border-slate-800 hover:shadow-md transition-shadow">
      {children}
    </div>
  </div>
);

export default ItineraryCard;
