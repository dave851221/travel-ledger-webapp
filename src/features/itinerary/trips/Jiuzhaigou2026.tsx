import React, { useEffect, useRef, useState } from 'react';
import { ItineraryCard } from '../components';

const Jiuzhaigou2026: React.FC = () => {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<LeafletMap | null>(null);
  const carMarker = useRef<LeafletMarker | null>(null);
  const currentPolyline = useRef<LeafletPolyline | null>(null);
  const [activeDay, setActiveDay] = useState('day1');

  // Approximate coordinates per day's route.
  const routes: Record<string, [number, number][]> = {
    'day1': [[25.0777, 121.2328], [30.3122, 104.4419], [30.5728, 104.0668]], // TPE → TFU → Chengdu
    'day2': [[30.5728, 104.0668], [32.6900, 103.6500], [32.6359, 103.6044], [33.2602, 103.9168]], // Chengdu → Songpan station → ancient city → Jiuzhaigou
    'day3': [[33.2602, 103.9168], [33.1564, 103.9170], [33.2602, 103.9168]], // Jiuzhaigou scenic loop
    'day4': [[33.2602, 103.9168], [32.7546, 103.8261], [31.6815, 103.8517]], // Jiuzhaigou → Huanglong → Maoxian
    'day5': [[31.6815, 103.8517], [30.9886, 103.6233], [29.5994, 103.4844]], // Maoxian → 鐘書閣 → Emeishan
    'day6': [[29.5994, 103.4844], [29.5447, 103.7720], [29.5994, 103.4844]], // Emeishan → Leshan → Emeishan
    'day7': [[29.5994, 103.4844], [30.3556, 103.9750], [30.6716, 104.0590], [30.6532, 104.0795], [30.5728, 104.0668]], // Emeishan → Huanglongxi → 寬窄巷子 → IFS → Chengdu hotel
    'day8': [[30.5728, 104.0668], [30.7385, 104.1494], [30.6649, 104.1166], [30.3122, 104.4419], [25.0777, 121.2328]] // Chengdu → Panda Base → 東郊記憶 → TFU → TPE
  };

  const animateCar = (route: [number, number][], index: number) => {
    if (index >= route.length - 1 || !carMarker.current) return;

    const start = route[index];
    const end = route[index + 1];
    const duration = 1200;
    let startTime: number | null = null;

    const step = (time: number) => {
      if (startTime === null) startTime = time;
      const progress = (time - startTime) / duration;
      if (progress > 1) {
        animateCar(route, index + 1);
        return;
      }
      const lat = start[0] + (end[0] - start[0]) * progress;
      const lng = start[1] + (end[1] - start[1]) * progress;
      if (carMarker.current) {
        carMarker.current.setLatLng([lat, lng]);
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  };

  const updateMap = (day: string) => {
    if (!leafletMap.current || !window.L) return;
    const L = window.L;
    const route = routes[day];
    if (!route) return;

    if (currentPolyline.current) leafletMap.current.removeLayer(currentPolyline.current);
    if (carMarker.current) leafletMap.current.removeLayer(carMarker.current);

    currentPolyline.current = L.polyline(route, {
      color: '#0d9488', weight: 4, opacity: 0.75, dashArray: '10, 10'
    }).addTo(leafletMap.current);

    leafletMap.current.flyToBounds(currentPolyline.current.getBounds(), {
      padding: [40, 40],
      duration: 1.5,
      maxZoom: 11
    });

    // 飛機 ✈️ for arrival/departure days, 火車 🚆 for day 2 (動車), 巴士 🚌 for the rest.
    let emoji = '🚌';
    if (day === 'day1' || day === 'day8') emoji = '✈️';
    else if (day === 'day2') emoji = '🚆';

    const icon = L.divIcon({
      className: 'car-icon',
      html: `<div style="font-size: 24px; text-align: center;">${emoji}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    carMarker.current = L.marker(route[0], { icon }).addTo(leafletMap.current);
    animateCar(route, 0);
  };

  useEffect(() => {
    if (!window.L || !mapRef.current || leafletMap.current) return;

    const L = window.L;
    leafletMap.current = L.map(mapRef.current).setView([31.5, 104.0], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(leafletMap.current);

    updateMap('day1');

    return () => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabChange = (day: string) => {
    setActiveDay(day);
    updateMap(day);
  };

  const dayLabels: Record<string, string> = {
    day1: '6/12 抵達',
    day2: '6/13 動車',
    day3: '6/14 九寨',
    day4: '6/15 黃龍',
    day5: '6/16 古羌',
    day6: '6/17 樂山',
    day7: '6/18 成都',
    day8: '6/19 返程'
  };

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-500 pb-10">
      {/* Map Section */}
      <div ref={mapRef} className="w-full h-40 sm:h-96 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-inner z-0" />

      {/* Tabs */}
      <div className="flex overflow-x-auto pb-2 no-scrollbar gap-2">
        {Object.keys(routes).map((day, idx) => (
          <button
            key={day}
            onClick={() => handleTabChange(day)}
            className={`shrink-0 px-4 py-2 rounded-full text-[10px] sm:text-xs font-bold transition-all border ${
              activeDay === day
                ? 'bg-teal-600 text-white border-teal-600 shadow-md'
                : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-100 dark:border-slate-800 hover:border-teal-300'
            }`}
          >
            Day {idx + 1}<br />
            <span className="opacity-70 font-normal text-[9px] sm:text-[10px]">
              {dayLabels[day]}
            </span>
          </button>
        ))}
      </div>

      {/* Content Container */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm p-3 sm:p-8">
        {activeDay === 'day1' && <Day1Content />}
        {activeDay === 'day2' && <Day2Content />}
        {activeDay === 'day3' && <Day3Content />}
        {activeDay === 'day4' && <Day4Content />}
        {activeDay === 'day5' && <Day5Content />}
        {activeDay === 'day6' && <Day6Content />}
        {activeDay === 'day7' && <Day7Content />}
        {activeDay === 'day8' && <Day8Content />}
      </div>
    </div>
  );
};

// --- Sub-components ---

const Day1Content = () => (
  <div className="space-y-4">
    <div className="bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/12 (五) - 桃園 ✈️ 成都
    </div>
    <ItineraryCard accent="teal" icon="🚐">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">10:30 機場接機（共 4 人）</h6>
      <p className="text-slate-500 text-xs sm:text-xs">前往桃園國際機場集合</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="✈️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">14:20 桃園 (TPE) → 18:05 成都 (TFU)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>航空公司：長榮航空 BR765</li>
        <li>飛行時間：約 3 小時 45 分鐘</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍽️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚餐 - 成都風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">住宿：成都保利公園皇冠假日酒店</h6>
      <p className="text-slate-500 text-xs sm:text-xs">Crowne Plaza Chengdu Panda Garden · TEL 86-28-6179-8888</p>
    </ItineraryCard>
  </div>
);

const Day2Content = () => (
  <div className="space-y-4">
    <div className="bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/13 (六) - 川青鐵路 → 松潘古城 → 九寨溝
    </div>
    <ItineraryCard accent="teal" icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早餐 - 酒店提供</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚆">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">川青鐵路體驗（安排動車二等座）前往松潘站</h6>
      <p className="text-slate-500 text-xs sm:text-xs">2023 年通車的新線路，貫穿岷江峽谷</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏯">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">遊覽【松潘古城】（不上城樓）</h6>
      <p className="text-slate-500 text-xs sm:text-xs">岷江畔的歷史邊城，茶馬古道重要驛站</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍽️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐 - 合菜風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚌">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">搭車前往九寨溝（約 92 km）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚餐 - 九寨風味（人民幣 60 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">住宿：九寨綠發希爾頓花園酒店</h6>
      <p className="text-slate-500 text-xs sm:text-xs">Hilton Garden Inn · TEL 86-837-7719777</p>
    </ItineraryCard>
  </div>
);

const Day3Content = () => (
  <div className="space-y-4">
    <div className="bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/14 (日) - 九寨溝風景區一日遊
    </div>
    <ItineraryCard accent="teal" icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早餐 - 酒店提供</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🌊">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【世界自然遺產 - 九寨溝風景區】（含環保公車）</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li>融合原始森林、雪峰、鈣華湖泊的童話世界</li>
        <li>六絕：翠湖、疊瀑、彩林、雪峰、藏情、藍冰</li>
        <li className="text-slate-400">註：景區內景點皆為套票，實際開放車遊及步行區域依景區規定</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐 - 景區內自助餐（人民幣 60 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍲">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚餐 - 藏式土火鍋風味（人民幣 60 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">住宿：九寨綠發希爾頓花園酒店</h6>
      <p className="text-slate-500 text-xs sm:text-xs">Hilton Garden Inn · TEL 86-837-7719777</p>
    </ItineraryCard>
  </div>
);

const Day4Content = () => (
  <div className="space-y-4">
    <div className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/15 (一) - 九寨溝 → 黃龍 → 茂縣
    </div>
    <ItineraryCard accent="teal" icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早餐 - 酒店提供</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚌">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">九寨溝出發前往松潘縣（約 94 km）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="⛰️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【黃龍風景區】（含上行纜車 + 電瓶車）</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li>世界自然遺產，有「人間瑤池」之稱</li>
        <li>海拔 3,576 m 的「五彩池」</li>
        <li>長達 1.3 km 的「金沙鋪地」鈣華景觀</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍽️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐 - 合菜風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚌">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">搭車前往茂縣（約 174 km）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍲">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚餐 - 羌族風味（人民幣 60 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">住宿：茂縣國際飯店</h6>
      <p className="text-slate-500 text-xs sm:text-xs">Maoxian International Hotel · TEL 86-837-7427777</p>
    </ItineraryCard>
  </div>
);

const Day5Content = () => (
  <div className="space-y-4">
    <div className="bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/16 (二) - 古羌城 → 鐘書閣 → 峨嵋山
    </div>
    <ItineraryCard accent="teal" icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早餐 - 酒店提供</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏛️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【中國古羌城】</h6>
      <p className="text-slate-500 text-xs sm:text-xs">以羌族文化為核心的主題園區，展現古老民族的建築與生活</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🐼">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">仰天窩自拍熊貓 + 鐘書閣（約 215 km 車程）</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li>仰天窩 - 仰望熊貓打卡景點</li>
        <li>鐘書閣 - 號稱「中國最美書店」</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍽️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐 - 合菜風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚌">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往峨嵋山（約 200 km）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🔥">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚餐 - 柴火雞風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">住宿：峨眉山天境度假酒店</h6>
      <p className="text-slate-500 text-xs sm:text-xs">TEL 86-833-5365600</p>
    </ItineraryCard>
  </div>
);

const Day6Content = () => (
  <div className="space-y-4">
    <div className="bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/17 (三) - 樂山大佛、蘇稽古鎮、報國寺、伏虎寺
    </div>
    <ItineraryCard accent="teal" icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早餐 - 酒店提供</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚌">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往樂山（約 190 km）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🗿">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【樂山大佛】（安排船遊）</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li>世界文化與自然雙重遺產</li>
        <li>世界現存最大的石刻坐佛，彌勒佛像通高 71 m，面江而坐</li>
        <li className="text-amber-600">備註：若因水位問題停止開船，改為樂山大佛上山遊</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏘️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【蘇稽古鎮】</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍽️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐 - 翹腳牛肉風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🛕">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【報國寺、伏虎寺】（含電瓶車）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚餐 - 酒店風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">住宿：峨眉山天境度假酒店</h6>
      <p className="text-slate-500 text-xs sm:text-xs">TEL 86-833-5365600</p>
    </ItineraryCard>
  </div>
);

const Day7Content = () => (
  <div className="space-y-4">
    <div className="bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/18 (四) - 黃龍溪古鎮、寬窄巷子、IFS 翻牆熊貓
    </div>
    <ItineraryCard accent="teal" icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早餐 - 酒店提供</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚌">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">離開峨嵋山返回成都（約 190 km）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏮">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【黃龍溪古鎮】</h6>
      <p className="text-slate-500 text-xs sm:text-xs">古色古香的千年古鎮，融合川西民居與水鄉風情</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍜">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐 - 古鎮風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🛍️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【寬窄巷子】</h6>
      <p className="text-slate-500 text-xs sm:text-xs">由寬巷子、窄巷子、井巷子組成，老成都現代與傳統交融的最佳視窗</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🐼">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">太古里 - 打卡【IFS 翻牆熊貓】</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍲">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚餐 - 四川鴛鴦火鍋風味（人民幣 80 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">住宿：成都保利公園皇冠假日酒店</h6>
      <p className="text-slate-500 text-xs sm:text-xs">Crowne Plaza Chengdu Panda Garden · TEL 86-28-6179-8888</p>
    </ItineraryCard>
  </div>
);

const Day8Content = () => (
  <div className="space-y-4">
    <div className="bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/06/19 (五) - 熊貓基地、東郊記憶 → 成都 ✈️ 桃園
    </div>
    <ItineraryCard accent="teal" icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早餐 - 酒店內用</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🐼">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【熊貓基地】（不含電瓶車）</h6>
      <p className="text-slate-500 text-xs sm:text-xs">全世界擁有大熊貓最多的生態公園，可隔著柵欄或玻璃窗觀看可愛大熊貓</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🏭">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">【東郊記憶文創園區】</h6>
      <p className="text-slate-500 text-xs sm:text-xs">由老工業廠房改建而成的時尚文化地標</p>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🍜">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐 - 川菜風味（人民幣 50 元）</h6>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="✈️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">19:20 成都 (TFU) → 22:40 桃園 (TPE)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>航空公司：長榮航空 BR766</li>
        <li>飛行時間：約 3 小時 20 分鐘</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard accent="teal" icon="🚐">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">23:00 機場送機（共 4 人）</h6>
      <p className="text-slate-500 text-xs sm:text-xs">滿載而歸，結束豐富的四川 8 日之旅</p>
    </ItineraryCard>
  </div>
);

export default Jiuzhaigou2026;
