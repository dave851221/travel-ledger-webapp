import React, { useState } from 'react';
import { DaySelector, ItineraryCard, getInitialDay } from '../components';

/**
 * 行程頁範本 —— 複製這個檔案改名後開始寫。
 *
 * 這不是強制模板，只是一個能跑的起點。想加地圖就 import TripMap，
 * 想要完全不一樣的版面就整個重寫，行程頁本來就是自由發揮的 React 元件。
 *
 * 完成後記得到 registry.ts 註冊，見 docs/ITINERARY_AUTHORING.md。
 *
 * ⚠️ 這個範本沒有註冊在 registry.ts，不會被任何旅程載入。
 */

const TRIP_DATES: Record<string, DayKey> = {
  '2027-03-14': 'day1',
  '2027-03-15': 'day2',
};

type DayKey = 'day1' | 'day2';

const DAYS = [
  { key: 'day1', subLabel: '3/14 抵達' },
  { key: 'day2', subLabel: '3/15 返程' },
];

const Template: React.FC = () => {
  // 今天若在旅程期間就自動跳到當天
  const [activeDay, setActiveDay] = useState<DayKey>(() => getInitialDay(TRIP_DATES, 'day1'));

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12 animate-in fade-in duration-500">
      <div className="text-center space-y-2 py-4">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white">
          2027 ○○ 之旅
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm">副標題</p>
      </div>

      <DaySelector
        days={DAYS}
        activeDay={activeDay}
        onChange={(d) => setActiveDay(d as DayKey)}
      />

      <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm p-3 sm:p-8">
        {activeDay === 'day1' && <Day1 />}
        {activeDay === 'day2' && <Day2 />}
      </div>
    </div>
  );
};

const Day1 = () => (
  <div>
    <ItineraryCard icon="✈️">
      <h3 className="font-black text-slate-800 dark:text-white text-sm sm:text-base">抵達機場</h3>
      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
        10:30 落地，搭機場快線進市區
      </p>
    </ItineraryCard>

    <ItineraryCard icon="🏨">
      <h3 className="font-black text-slate-800 dark:text-white text-sm sm:text-base">飯店 Check-in</h3>
      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
        ○○ Hotel ·{' '}
        <a
          href="https://maps.google.com/?q=..."
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline font-bold"
        >
          地圖
        </a>
      </p>
    </ItineraryCard>

    <ItineraryCard icon="🍜">
      <h3 className="font-black text-slate-800 dark:text-white text-sm sm:text-base">晚餐</h3>
      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
        一蘭ラーメン(拉麵)
      </p>
    </ItineraryCard>
  </div>
);

const Day2 = () => (
  <div>
    <ItineraryCard icon="🛍️">
      <h3 className="font-black text-slate-800 dark:text-white text-sm sm:text-base">最後採買</h3>
      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
        車站商店街
      </p>
    </ItineraryCard>

    <ItineraryCard icon="✈️">
      <h3 className="font-black text-slate-800 dark:text-white text-sm sm:text-base">返程</h3>
      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
        18:20 起飛
      </p>
    </ItineraryCard>
  </div>
);

export default Template;
