import React, { useState } from 'react';
import { BedDouble, Check, Info, MapPin, Plane, Ticket } from 'lucide-react';
import { DaySelector, ItineraryCard, TripMap, getInitialDay } from '../components';

/**
 * 2026 大阪環球賞楓之旅 (11/14 – 11/22)
 *
 * 內容全部來自「1114-1122大阪.xlsx」：planA 分頁的每日時段、機票住宿分頁、
 * 各預訂狀況分頁與事前準備分頁。試算表沒寫的就不寫 —— 例如神戶的海生館與動物園
 * 沒指明是哪一間，所以地圖只畫到神戶市區，不釘點。
 */

type DayKey =
  | 'overview'
  | 'day1' | 'day2' | 'day3' | 'day4' | 'day5'
  | 'day6' | 'day7' | 'day8' | 'day9';

const TRIP_DATES: Record<string, DayKey> = {
  '2026-11-14': 'day1',
  '2026-11-15': 'day2',
  '2026-11-16': 'day3',
  '2026-11-17': 'day4',
  '2026-11-18': 'day5',
  '2026-11-19': 'day6',
  '2026-11-20': 'day7',
  '2026-11-21': 'day8',
  '2026-11-22': 'day9',
};

// --- Places ---

const KIX: LatLngTuple = [34.4320, 135.2304];
const KYOTO_STATION: LatLngTuple = [34.9858, 135.7588];
const KYOTO_HOTEL: LatLngTuple = [34.99107, 135.76565];
const OSAKA_HOTEL: LatLngTuple = [34.66041, 135.50443];
const NIPPONBASHI: LatLngTuple = [34.6627, 135.5065];
const DOTONBORI: LatLngTuple = [34.6687, 135.5013];
const NAMBA: LatLngTuple = [34.6655, 135.5010];

// Approximate coordinates; points come from the sheet's map links where it has them.
const ROUTES: Record<DayKey, LatLngTuple[]> = {
  overview: [KIX, KYOTO_HOTEL, OSAKA_HOTEL, KIX],
  day1: [KIX, KYOTO_STATION, KYOTO_HOTEL],
  day2: [KYOTO_HOTEL, [34.99467, 135.78466], [34.9985, 135.7803], [34.9962, 135.7813], [35.0129, 135.6777], KYOTO_HOTEL],
  day3: [KYOTO_HOTEL, [35.0391, 135.7727], [35.0394, 135.7292], [35.0037, 135.7690], [35.0040, 135.7717], [35.00946, 135.77063], KYOTO_HOTEL],
  day4: [KYOTO_HOTEL, [34.96769, 135.77919], OSAKA_HOTEL, NIPPONBASHI, DOTONBORI, NAMBA, OSAKA_HOTEL],
  day5: [OSAKA_HOTEL, [34.9033, 135.7928], NIPPONBASHI, DOTONBORI, NAMBA, OSAKA_HOTEL],
  day6: [OSAKA_HOTEL, [34.6654, 135.4323], OSAKA_HOTEL],
  // Kobe city centre only: the sheet doesn't say which aquarium / zoo.
  day7: [OSAKA_HOTEL, [34.6946, 135.1956], OSAKA_HOTEL],
  day8: [OSAKA_HOTEL, [34.8654, 135.4910], [34.7025, 135.4959], OSAKA_HOTEL],
  day9: [OSAKA_HOTEL, KIX],
};

// --- Sheet data ---

interface Hotel {
  city: string;
  name: string;
  address?: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  href: string;
}

const KYOTO_STAY: Hotel = {
  city: '京都',
  name: '京都高瀬川別邸 北館',
  checkIn: '11/14',
  checkOut: '11/17',
  nights: 3,
  href: 'https://www.google.com/maps/place/%E4%BA%AC%E9%83%BD%E9%AB%98%E7%80%AC%E5%B7%9D%E5%88%A5%E9%82%B8+%E5%8C%97%E9%A4%A8/@34.9910667,135.7630781,17z/data=!3m1!4b1!4m9!3m8!1s0x600108b0c5dcf689:0x1ba3dbee6dfe02d3!5m2!4m1!1i2!8m2!3d34.9910667!4d135.765653!16s%2Fg%2F11c53cqkss',
};

const OSAKA_STAY: Hotel = {
  city: '大阪',
  name: 'Comfy House Namba',
  address: 'Nipponbashinishi 1-1-8 1F',
  checkIn: '11/17',
  checkOut: '11/22',
  nights: 5,
  href: 'https://www.google.com/maps/place/Comfy+House+Namba/@34.6600933,135.504524,19.62z/data=!4m9!3m8!1s0x6000e7007b71e063:0x805f97968e519713!5m2!4m1!1i2!8m2!3d34.6604085!4d135.5044279!16s%2Fg%2F11lw06bt9w',
};

const FLIGHTS = [
  { label: '去程', date: '11/14（六）', depart: '13:30', arrive: '16:55' },
  { label: '回程', date: '11/22（日）', depart: '12:55', arrive: '15:05' },
];

type BookingStatus = '已付清' | '已預約' | '未確認';

interface Booking {
  date: string;
  time?: string;
  category: string;
  item: string;
  status: BookingStatus;
}

// 「各預訂狀況」分頁裡有填內容的列（狀態仍是「請選擇」的顯示為未確認）
const BOOKINGS: Booking[] = [
  { date: '11/15', category: '交通', item: '嵐山嵯峨野觀光小火車', status: '已付清' },
  { date: '11/16', category: '大吃大喝', item: '壽喜燒（Moritaya - Kiyamachi）', status: '已預約' },
  { date: '11/17', category: '大吃大喝', item: '大阪燒', status: '未確認' },
  { date: '11/18', time: '20:00', category: '大吃大喝', item: '炭火燒肉大歡', status: '已預約' },
  { date: '11/19', category: '景點', item: '環球影城門票 快通', status: '已付清' },
];

const CHECKLIST = [
  '護照', '信用卡', '外幣', '入境資料（Visit Japan）', '保險', 'E-SIM',
  '充電線', '藥', '環保袋', '牙刷', '口罩', '行動電源',
];

/** Time-of-day rows from the planA sheet, e.g. '早上'、'晚餐', or '航班' for the flights */
type Slot = string;

const MEAL_SLOTS: Slot[] = ['早餐', '午餐', '晚餐'];

interface Stop {
  name: string;
  /** Link from the sheet, used as-is */
  href?: string;
  /** No link in the sheet: search Google Maps for this text instead */
  search?: string;
  /** Marked with * in the sheet: restaurant not decided yet */
  undecided?: boolean;
}

interface Block {
  slot: Slot;
  time?: string;
  icon: string;
  stops: Stop[];
  notes?: string[];
  booking?: { item: string; status: BookingStatus; time?: string };
}

interface DayPlan {
  date: string;
  weekday: string;
  city: string;
  title: string;
  blocks: Block[];
  stay?: Hotel;
  tips?: string[];
}

const mapSearch = (query: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

const PLANS: Record<Exclude<DayKey, 'overview'>, DayPlan> = {
  day1: {
    date: '11/14', weekday: '六', city: '京都', title: '出發，抵達京都',
    blocks: [
      { slot: '航班', time: '13:30 – 16:55', icon: '✈️', stops: [{ name: '去程航班（飛機上）' }] },
      { slot: '晚上', icon: '🚆', stops: [{ name: 'HARUKA 46 特急 → 京都' }] },
      { slot: '晚餐', icon: '🏮', stops: [{ name: '京都居酒屋' }] },
    ],
    stay: KYOTO_STAY,
  },
  day2: {
    date: '11/15', weekday: '日', city: '京都', title: '清水寺・二三年坂・嵐山',
    blocks: [
      {
        slot: '早上', icon: '⛩️',
        stops: [{ name: '清水寺', href: 'https://www.google.com/maps/place/%E6%B8%85%E6%B0%B4%E5%AF%BA/@34.9946662,135.784661,15z' }],
        notes: ['預計 7 點左右抵達'],
      },
      { slot: '下午', icon: '🏯', stops: [{ name: '二年坂', search: '二年坂 京都' }, { name: '三年坂', search: '三年坂 京都' }] },
      {
        slot: '晚上', icon: '🍁',
        stops: [{ name: '嵐山', search: '嵐山 京都' }],
        booking: { item: '嵐山嵯峨野觀光小火車', status: '已付清' },
      },
    ],
    stay: KYOTO_STAY,
  },
  day3: {
    date: '11/16', weekday: '一', city: '京都', title: '下鴨神社・金閣寺・鴨川',
    blocks: [
      { slot: '早上', icon: '⛩️', stops: [{ name: '下鴨神社', search: '下鴨神社' }, { name: '金閣寺', search: '金閣寺' }] },
      { slot: '午餐', icon: '🍜', stops: [{ name: '豬一拉麵', search: '麺匠 猪一 京都' }] },
      { slot: '下午', icon: '🌉', stops: [{ name: '河原町', search: '河原町 京都' }, { name: '鴨川', search: '鴨川 京都' }] },
      {
        slot: '晚餐', icon: '🍲',
        stops: [{ name: '壽喜燒（Moritaya - Kiyamachi）', href: 'https://www.google.com/maps/place/Moritaya+-+Kiyamachi/@35.0094641,135.7706255,17z' }],
        booking: { item: '壽喜燒', status: '已預約' },
      },
    ],
    stay: KYOTO_STAY,
  },
  day4: {
    date: '11/17', weekday: '二', city: '京都 → 大阪', title: '伏見稻荷，移動到大阪',
    blocks: [
      {
        slot: '早上', icon: '⛩️',
        stops: [{ name: '伏見稻荷神社', href: 'https://www.google.com/maps/place/%E4%BC%8F%E8%A6%8B%E7%A8%BB%E8%8D%B7%E5%A4%A7%E7%A4%BE/@34.9676945,135.7791876,15z' }],
      },
      { slot: '早上', icon: '🧳', stops: [{ name: '退房、前往大阪' }], notes: ['待確認行李寄放'] },
      { slot: '午餐', icon: '🥩', stops: [{ name: '炸牛排' }] },
      {
        slot: '下午', icon: '🛍️',
        stops: [{ name: '日本橋', search: '日本橋 大阪' }, { name: '道頓堀', search: '道頓堀' }, { name: '難波', search: '難波 大阪' }],
      },
      {
        slot: '晚餐', icon: '🥞',
        stops: [{ name: '福太郎大阪燒', href: 'https://maps.app.goo.gl/Y3Dh1tC1rkqCa1Bm9' }],
        booking: { item: '大阪燒', status: '未確認' },
      },
    ],
    stay: OSAKA_STAY,
  },
  day5: {
    date: '11/18', weekday: '三', city: '大阪', title: '任天堂博物館・難波',
    blocks: [
      { slot: '早餐', icon: '☕', stops: [{ name: '客美多' }] },
      {
        slot: '早上', icon: '🎮',
        stops: [{ name: '任天堂博物館', search: 'Nintendo Museum 宇治' }, { name: '中村藤吉' }],
      },
      {
        slot: '下午', icon: '🛍️',
        stops: [{ name: '日本橋', search: '日本橋 大阪' }, { name: '道頓堀', search: '道頓堀' }, { name: '難波', search: '難波 大阪' }],
      },
      {
        slot: '晚餐', time: '20:00', icon: '🔥',
        stops: [{ name: '炭火燒肉大歡', href: 'https://share.google/V59qkQBAZi1gGPyfs' }],
        booking: { item: '炭火燒肉大歡', status: '已預約', time: '20:00' },
      },
    ],
    stay: OSAKA_STAY,
  },
  day6: {
    date: '11/19', weekday: '四', city: '大阪', title: '環球影城一整天',
    blocks: [
      {
        slot: '全天', icon: '🎢',
        stops: [{ name: '環球影城', search: 'Universal Studios Japan' }],
        booking: { item: '門票＋快通', status: '已付清' },
      },
      { slot: '晚餐', icon: '🍢', stops: [{ name: '串炸或居酒屋', undecided: true }] },
    ],
    stay: OSAKA_STAY,
  },
  day7: {
    date: '11/20', weekday: '五', city: '神戶', title: '神戶一日遊',
    blocks: [
      { slot: '早上', icon: '🐠', stops: [{ name: '神戶海生館' }] },
      { slot: '下午', icon: '🦒', stops: [{ name: '神戶動物園' }] },
      { slot: '晚上', icon: '🌃', stops: [{ name: '神戶夜景' }] },
      { slot: '晚餐', icon: '🥩', stops: [{ name: '神戶牛排', undecided: true }] },
    ],
    stay: OSAKA_STAY,
    tips: ['視天氣情況調整動物園及海生館之順序'],
  },
  day8: {
    date: '11/21', weekday: '六', city: '大阪', title: '勝尾寺・梅田',
    blocks: [
      { slot: '早上', icon: '🍁', stops: [{ name: '勝尾寺', search: '勝尾寺 箕面' }] },
      { slot: '午餐', icon: '🍣', stops: [{ name: '壽司' }] },
      { slot: '下午～晚上', icon: '🛍️', stops: [{ name: '梅田逛街', search: '梅田 大阪' }] },
    ],
    stay: OSAKA_STAY,
  },
  day9: {
    date: '11/22', weekday: '日', city: '大阪', title: '返程',
    blocks: [
      { slot: '航班', time: '12:55 – 15:05', icon: '✈️', stops: [{ name: '回程航班（飛機上）' }] },
    ],
  },
};

const DAYS: { key: DayKey; label?: string; subLabel: string }[] = [
  { key: 'overview', label: '總覽', subLabel: '行前準備' },
  { key: 'day1', subLabel: '11/14 抵達' },
  { key: 'day2', subLabel: '11/15 清水寺' },
  { key: 'day3', subLabel: '11/16 金閣寺' },
  { key: 'day4', subLabel: '11/17 移往大阪' },
  { key: 'day5', subLabel: '11/18 任天堂' },
  { key: 'day6', subLabel: '11/19 環球' },
  { key: 'day7', subLabel: '11/20 神戶' },
  { key: 'day8', subLabel: '11/21 勝尾寺' },
  { key: 'day9', subLabel: '11/22 返程' },
];

// --- Page ---

const Osaka2026: React.FC = () => {
  // 旅程期間自動跳到當天，其他時候先看總覽
  const [activeDay, setActiveDay] = useState<DayKey>(() => getInitialDay(TRIP_DATES, 'overview'));

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12 animate-in fade-in duration-500">
      <Hero />

      <TripMap
        routes={ROUTES}
        activeDay={activeDay}
        center={[34.75, 135.55]}
        zoom={9}
        color="#ea580c"
        vehicleIcon={(day) => (day === 'overview' ? '✈️' : day === 'day1' ? '🚆' : '🍁')}
      />

      <DaySelector
        days={DAYS}
        activeDay={activeDay}
        onChange={(d) => setActiveDay(d as DayKey)}
        accent="amber"
      />

      <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm p-3 sm:p-8">
        {activeDay === 'overview' ? <Overview /> : <DayView plan={PLANS[activeDay]} />}
      </div>
    </div>
  );
};

const Hero = () => (
  <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-gradient-to-br from-amber-400 via-orange-500 to-rose-600 dark:from-amber-700 dark:via-orange-800 dark:to-rose-900 text-white p-5 sm:p-8 shadow-lg">
    <span aria-hidden className="absolute -right-4 -top-6 text-8xl sm:text-9xl opacity-20 rotate-12 select-none">🍁</span>
    <span aria-hidden className="absolute right-20 -bottom-8 text-6xl sm:text-7xl opacity-15 -rotate-12 select-none">🍁</span>
    <p className="text-[11px] sm:text-xs font-bold tracking-[0.2em] text-white/80">KYOTO · OSAKA · KOBE</p>
    <h1 className="text-2xl sm:text-3xl font-black mt-1">2026 大阪環球賞楓之旅</h1>
    <p className="text-sm sm:text-base font-bold text-white/90 mt-1">2026/11/14（六）– 11/22（日）</p>
    <div className="flex flex-wrap gap-2 mt-4">
      {['9 天 8 夜', '京都 3 晚', '大阪 5 晚', '環球影城', '神戶一日'].map((tag) => (
        <span key={tag} className="px-2.5 py-1 rounded-full bg-white/20 dark:bg-white/10 backdrop-blur text-[11px] sm:text-xs font-bold">
          {tag}
        </span>
      ))}
    </div>
  </div>
);

// --- Overview tab ---

const SectionTitle: React.FC<{ icon: React.ReactNode; children: React.ReactNode; extra?: React.ReactNode }> = ({ icon, children, extra }) => (
  <div className="flex items-center justify-between gap-2 mb-3">
    <h2 className="flex items-center gap-2 font-black text-slate-800 dark:text-white text-base sm:text-lg">
      <span className="text-amber-600 dark:text-amber-400">{icon}</span>
      {children}
    </h2>
    {extra}
  </div>
);

const Overview = () => (
  <div className="space-y-8">
    <section>
      <SectionTitle icon={<Plane size={18} />}>航班</SectionTitle>
      <div className="grid sm:grid-cols-2 gap-3">
        {FLIGHTS.map((f) => (
          <div key={f.label} className="rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-black text-amber-700 dark:text-amber-400">{f.label}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">{f.date}</span>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <div>
                <p className="text-[10px] text-slate-400 dark:text-slate-500">出發</p>
                <p className="text-xl sm:text-2xl font-black text-slate-800 dark:text-white tabular-nums">{f.depart}</p>
              </div>
              <div className="flex-1 flex items-center gap-1 text-slate-300 dark:text-slate-600">
                <span className="flex-1 border-t-2 border-dashed border-current" />
                <Plane size={14} className="text-amber-500" />
                <span className="flex-1 border-t-2 border-dashed border-current" />
              </div>
              <div className="text-right">
                <p className="text-[10px] text-slate-400 dark:text-slate-500">抵達</p>
                <p className="text-xl sm:text-2xl font-black text-slate-800 dark:text-white tabular-nums">{f.arrive}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>

    <section>
      <SectionTitle icon={<BedDouble size={18} />}>住宿</SectionTitle>
      <div className="grid sm:grid-cols-2 gap-3">
        {[KYOTO_STAY, OSAKA_STAY].map((h) => (
          <a
            key={h.name}
            href={h.href}
            target="_blank"
            rel="noreferrer"
            className="group block rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 p-4 hover:border-amber-300 dark:hover:border-amber-700 hover:shadow-md transition-all"
          >
            <div className="flex items-center justify-between">
              <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-[11px] font-black">
                {h.city} · {h.nights} 晚
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">{h.checkIn} – {h.checkOut}</span>
            </div>
            <p className="font-black text-slate-800 dark:text-white mt-2 group-hover:text-amber-700 dark:group-hover:text-amber-400">{h.name}</p>
            {h.address && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{h.address}</p>}
            <p className="flex items-center gap-1 text-xs font-bold text-amber-700 dark:text-amber-400 mt-2">
              <MapPin size={12} /> 開啟地圖
            </p>
          </a>
        ))}
      </div>
    </section>

    <section>
      <SectionTitle icon={<Ticket size={18} />}>預訂狀況</SectionTitle>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-2xl border border-slate-100 dark:border-slate-800 overflow-hidden">
        {BOOKINGS.map((b) => (
          <li key={b.item} className="flex items-center gap-3 px-3 sm:px-4 py-3 bg-white dark:bg-slate-900">
            <div className="w-12 shrink-0 text-center">
              <p className="text-sm font-black text-slate-800 dark:text-white tabular-nums">{b.date}</p>
              {b.time && <p className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">{b.time}</p>}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{b.item}</p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">{b.category}</p>
            </div>
            <StatusBadge status={b.status} />
          </li>
        ))}
      </ul>
    </section>

    <Checklist />

    <section>
      <SectionTitle icon={<Info size={18} />}>尚未排進</SectionTitle>
      <div className="rounded-2xl border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10 p-4 space-y-1.5">
        <p className="text-sm font-bold text-slate-800 dark:text-slate-100">🐟 生魚片 <span className="font-normal text-slate-500 dark:text-slate-400">（可選任何午餐）</span></p>
        <p className="text-xs text-slate-500 dark:text-slate-400">各種早餐、午餐、晚餐都還能再排；標「未定」的是還沒決定的餐廳。</p>
      </div>
    </section>
  </div>
);

const CHECKLIST_STORAGE_KEY = 'itinerary_checklist_osaka2026';

const loadChecked = (): string[] => {
  try {
    const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** 行前準備清單。勾選狀態只存在這台裝置上，每個人各自打勾。 */
const Checklist = () => {
  const [checked, setChecked] = useState<string[]>(loadChecked);

  const toggle = (item: string) => {
    setChecked((prev) => {
      const next = prev.includes(item) ? prev.filter((x) => x !== item) : [...prev, item];
      try {
        localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode / blocked storage: keep the in-memory state only.
      }
      return next;
    });
  };

  const done = CHECKLIST.filter((item) => checked.includes(item)).length;

  return (
    <section>
      <SectionTitle
        icon={<Check size={18} />}
        extra={<span className="text-xs font-bold text-slate-500 dark:text-slate-400 tabular-nums">{done} / {CHECKLIST.length}</span>}
      >
        行前準備
      </SectionTitle>
      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mb-3">
        <div
          className="h-full bg-gradient-to-r from-amber-400 to-rose-500 transition-all duration-500"
          style={{ width: `${(done / CHECKLIST.length) * 100}%` }}
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {CHECKLIST.map((item) => {
          const isDone = checked.includes(item);
          return (
            <button
              key={item}
              type="button"
              onClick={() => toggle(item)}
              className={`flex items-center gap-2 text-left rounded-xl border px-3 py-2.5 text-sm font-bold transition-all ${
                isDone
                  ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-slate-400 dark:text-slate-500 line-through'
                  : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-300 dark:hover:border-amber-700'
              }`}
            >
              <span
                className={`shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center ${
                  isDone ? 'bg-amber-500 border-amber-500 text-white' : 'border-slate-300 dark:border-slate-600'
                }`}
              >
                {isDone && <Check size={12} strokeWidth={4} />}
              </span>
              <span className="min-w-0">{item}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

// --- Day tabs ---

const STATUS_STYLE: Record<BookingStatus, string> = {
  已付清: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  已預約: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  未確認: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

const StatusBadge: React.FC<{ status: BookingStatus }> = ({ status }) => (
  <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-black ${STATUS_STYLE[status]}`}>{status}</span>
);

const SlotChip: React.FC<{ slot: Slot }> = ({ slot }) => (
  <span
    className={`px-2 py-0.5 rounded-md text-[10px] sm:text-[11px] font-black ${
      MEAL_SLOTS.includes(slot)
        ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300'
        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
    }`}
  >
    {slot}
  </span>
);

const StopLabel: React.FC<{ stop: Stop }> = ({ stop }) => {
  const href = stop.href ?? (stop.search ? mapSearch(stop.search) : undefined);
  const label = (
    <>
      {stop.name}
      {stop.undecided && (
        <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 text-[10px] font-bold">
          未定
        </span>
      )}
    </>
  );
  if (!href) return <span>{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:text-amber-700 dark:hover:text-amber-400 underline decoration-amber-300 dark:decoration-amber-700 decoration-2 underline-offset-4"
    >
      {label}
      <MapPin size={12} className="text-amber-500 shrink-0" />
    </a>
  );
};

const DayView: React.FC<{ plan: DayPlan }> = ({ plan }) => (
  <div className="space-y-5">
    <div className="flex items-end justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
      <div>
        <p className="text-xs font-bold text-amber-700 dark:text-amber-400">
          2026/{plan.date}（{plan.weekday}）· {plan.city}
        </p>
        <h2 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white mt-0.5">{plan.title}</h2>
      </div>
    </div>

    {plan.tips?.map((tip) => (
      <div key={tip} className="flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 px-3 py-2.5 text-xs sm:text-sm font-bold">
        <Info size={16} className="shrink-0 mt-0.5" />
        {tip}
      </div>
    ))}

    <div>
      {plan.blocks.map((block, i) => (
        <ItineraryCard key={i} icon={block.icon} accent={MEAL_SLOTS.includes(block.slot) ? 'rose' : 'amber'}>
          <div className="flex items-center gap-2 flex-wrap">
            <SlotChip slot={block.slot} />
            {block.time && (
              <span className="text-xs font-bold text-slate-500 dark:text-slate-400 tabular-nums">{block.time}</span>
            )}
          </div>
          <h3 className="font-black text-slate-800 dark:text-white text-sm sm:text-base mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {block.stops.map((stop, j) => (
              <React.Fragment key={stop.name}>
                {j > 0 && <span className="text-slate-300 dark:text-slate-600 font-normal">→</span>}
                <StopLabel stop={stop} />
              </React.Fragment>
            ))}
          </h3>
          {block.notes?.map((note) => (
            <p key={note} className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">{note}</p>
          ))}
          {block.booking && (
            <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-slate-100 dark:border-slate-800">
              <Ticket size={14} className="text-slate-400 shrink-0" />
              <span className="text-xs text-slate-600 dark:text-slate-300 flex-1 min-w-0">
                {block.booking.item}
                {block.booking.time && <span className="tabular-nums"> · {block.booking.time}</span>}
              </span>
              <StatusBadge status={block.booking.status} />
            </div>
          )}
        </ItineraryCard>
      ))}
    </div>

    {plan.stay && (
      <a
        href={plan.stay.href}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-amber-50 to-rose-50 dark:from-amber-900/20 dark:to-rose-900/20 border border-amber-100 dark:border-amber-900/50 px-4 py-3 hover:shadow-md transition-shadow"
      >
        <span className="w-9 h-9 shrink-0 rounded-full bg-white dark:bg-slate-800 flex items-center justify-center text-amber-600 dark:text-amber-400 shadow-sm">
          <BedDouble size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400">今晚住宿 · {plan.stay.city}</p>
          <p className="text-sm font-black text-slate-800 dark:text-white truncate">{plan.stay.name}</p>
        </div>
        <MapPin size={16} className="text-amber-500 shrink-0" />
      </a>
    )}
  </div>
);

export default Osaka2026;
