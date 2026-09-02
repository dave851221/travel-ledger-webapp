import React from 'react';
import type { ItineraryAccent } from './ItineraryCard';

const ACCENT_ACTIVE: Record<ItineraryAccent, string> = {
  blue: 'bg-blue-600 border-blue-600',
  teal: 'bg-teal-600 border-teal-600',
  rose: 'bg-rose-600 border-rose-600',
  indigo: 'bg-indigo-600 border-indigo-600',
  amber: 'bg-amber-600 border-amber-600',
  emerald: 'bg-emerald-600 border-emerald-600',
};

const ACCENT_HOVER: Record<ItineraryAccent, string> = {
  blue: 'hover:border-blue-300',
  teal: 'hover:border-teal-300',
  rose: 'hover:border-rose-300',
  indigo: 'hover:border-indigo-300',
  amber: 'hover:border-amber-300',
  emerald: 'hover:border-emerald-300',
};

export interface DayOption {
  /** 內部識別字串，例如 'day1' */
  key: string;
  /** 主標，例如 'Day 1'。省略時自動用 `Day {序號}` */
  label?: string;
  /** 副標，例如 '4/4 抵達' */
  subLabel?: string;
}

export interface DaySelectorProps {
  days: DayOption[];
  activeDay: string;
  onChange: (day: string) => void;
  accent?: ItineraryAccent;
}

/**
 * 橫向捲動的日期頁籤。
 *
 * 天數多時會自己橫向捲動，不會擠壓版面；天數少時就是一排按鈕。
 */
const DaySelector: React.FC<DaySelectorProps> = ({
  days,
  activeDay,
  onChange,
  accent = 'blue',
}) => (
  <div className="flex overflow-x-auto pb-2 no-scrollbar gap-2">
    {days.map((day, idx) => {
      const isActive = activeDay === day.key;
      return (
        <button
          key={day.key}
          onClick={() => onChange(day.key)}
          className={`shrink-0 px-4 py-2 rounded-full text-[10px] sm:text-xs font-bold transition-all border ${
            isActive
              ? `${ACCENT_ACTIVE[accent]} text-white shadow-md`
              : `bg-white dark:bg-slate-900 text-slate-500 border-slate-100 dark:border-slate-800 ${ACCENT_HOVER[accent]}`
          }`}
        >
          {day.label ?? `Day ${idx + 1}`}
          {day.subLabel && (
            <>
              <br />
              <span className="opacity-70 font-normal text-[9px] sm:text-[10px]">{day.subLabel}</span>
            </>
          )}
        </button>
      );
    })}
  </div>
);

export default DaySelector;
