import React, { useEffect, useRef, useState } from 'react';

// Declaration for Leaflet which is loaded via CDN in index.html
declare global {
  interface Window {
    L: any;
  }
}

const Nagoya2026: React.FC = () => {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<any>(null);
  const carMarker = useRef<any>(null);
  const currentPolyline = useRef<any>(null);
  const [activeDay, setActiveTab] = useState('day1');

  const routes: Record<string, [number, number][]> = {
    'day1': [[34.8584, 136.8053], [35.1429, 136.9014], [35.1738, 136.9080]],
    'day2': [[35.1738, 136.9080], [35.3346, 136.8724], [35.3883, 136.9392], [35.8037, 137.2472], [35.8053, 137.2407]],
    'day3': [[35.8053, 137.2407], [36.1432, 137.2589], [36.1408, 137.2519]],
    'day4': [[36.1408, 137.2519], [36.1436, 137.2603], [36.2566, 136.9066], [36.5714, 136.6554], [36.5780, 136.6482]],
    'day5': [[36.5780, 136.6482], [36.5621, 136.6627], [36.3533, 136.3113], [35.8398, 136.1947], [35.4984, 136.2163], [35.0844, 136.7027], [35.1709, 136.8815]],
    'day6': [[35.1709, 136.8815], [35.1705, 136.9032], [35.1264, 136.9089], [35.1709, 136.8815]],
    'day7': [[35.1709, 136.8815], [35.1599, 136.9007], [35.1709, 136.8815]],
    'day8': [[35.1709, 136.8815], [34.8584, 136.8053]]
  };

  useEffect(() => {
    if (!window.L || !mapRef.current || leafletMap.current) return;

    const L = window.L;
    leafletMap.current = L.map(mapRef.current).setView([35.1738, 136.8994], 9);
    
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
  }, []);

  const animateCar = (route: [number, number][], index: number) => {
    if (index >= route.length - 1 || !carMarker.current) return;
    
    const start = route[index];
    const end = route[index + 1];
    const duration = 1000;
    const startTime = performance.now();

    const step = (time: number) => {
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
      color: '#0d6efd', weight: 4, opacity: 0.7, dashArray: '10, 10'
    }).addTo(leafletMap.current);

    leafletMap.current.fitBounds(currentPolyline.current.getBounds(), { padding: [50, 50] });

    const isTrain = ['day1', 'day6', 'day7', 'day8'].includes(day);
    const icon = L.divIcon({
      className: 'car-icon',
      html: `<div style="font-size: 24px; text-align: center;">${isTrain ? '🚇' : '🚗'}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    carMarker.current = L.marker(route[0], { icon }).addTo(leafletMap.current);
    animateCar(route, 0);
  };

  const handleTabChange = (day: string) => {
    setActiveTab(day);
    updateMap(day);
  };

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-500 pb-10">
      {/* Map Section */}
      <div ref={mapRef} className="w-full h-56 sm:h-96 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-inner z-0" />

      {/* Tabs */}
      <div className="flex overflow-x-auto pb-2 no-scrollbar gap-2">
        {Object.keys(routes).map((day, idx) => (
          <button
            key={day}
            onClick={() => handleTabChange(day)}
            className={`shrink-0 px-4 py-2 rounded-full text-[10px] sm:text-xs font-bold transition-all border ${
              activeDay === day 
                ? 'bg-blue-600 text-white border-blue-600 shadow-md' 
                : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-100 dark:border-slate-800 hover:border-blue-300'
            }`}
          >
            Day {idx + 1}<br />
            <span className="opacity-70 font-normal text-[9px] sm:text-[10px]">
              {day === 'day1' && '4/4 抵達'}
              {day === 'day2' && '4/5 犬山'}
              {day === 'day3' && '4/6 高山'}
              {day === 'day4' && '4/7 金澤'}
              {day === 'day5' && '4/8 移動'}
              {day === 'day6' && '4/9 市區'}
              {day === 'day7' && '4/10 購物'}
              {day === 'day8' && '4/11 返程'}
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

const ItineraryCard: React.FC<{ icon: string; children: React.ReactNode }> = ({ icon, children }) => (
  <div className="relative pl-8 sm:pl-10 pb-8 last:pb-0">
    <div className="absolute left-3.5 sm:left-4 top-0 bottom-0 w-0.5 bg-slate-100 dark:bg-slate-800" />
    <div className="absolute left-0 top-0 w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white dark:bg-slate-800 border-2 border-blue-600 flex items-center justify-center z-10 shadow-sm text-xs sm:text-sm">
      {icon}
    </div>
    <div className="bg-slate-50/50 dark:bg-slate-800/30 rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-slate-100 dark:border-slate-800 hover:shadow-md transition-shadow">
      {children}
    </div>
  </div>
);

const Day1Content = () => (
  <div className="space-y-4">
    <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/04 (六) - 抵達名古屋
    </div>
    <ItineraryCard icon="🚐">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">[TW] 14:00 送機專車到家(<a href="https://www.klook.com/zh-TW/airport-transfers/order-details/?orderGuid=5411353041&bookingNo=NFP611467" target="_blank" className="text-blue-600 hover:underline">Klook</a>)</h6>
    </ItineraryCard>
    <ItineraryCard icon="✈️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">21:05 到達<a href="https://maps.app.goo.gl/635wW51zWggo5w6V7" target="_blank" className="text-blue-600 hover:underline">名古屋中部國際機場</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>航班 CI150</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🚆">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">搭乘名鐵</h6>
      <p className="text-slate-500 text-xs sm:text-xs mb-1">主要分成三種列車</p>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li><strong>特殊列車 μ-SKY (ミュースカイ)，全車指定席</strong>
          <ul className="list-circle pl-4 mt-1 space-y-1">
            <li>μ-SKY請至1號專用月台(進閘門後右前方)</li>
            <li>除了購買單程票(片道きっぷ)以外，還需要購買指定席券(特別車両券)</li>
            <li><a href="https://nicklee.tw/1803/centrair-to-nagoya-usky/" target="_blank" className="text-blue-600 hover:underline">購票攻略</a></li>
          </ul>
        </li>
        <li><strong>特急為紅白車，一半指定席一半自由座</strong>
          <ul className="list-circle pl-4 mt-1 space-y-1">
            <li>第2或第3月台，直接西瓜卡或信用卡逼卡進站即可</li>
            <li>CP值較高</li>
          </ul>
        </li>
        <li><strong>一般車為全紅車(準急 or 急行)，比較慢</strong></li>
      </ul>
      <p className="text-slate-500 text-xs sm:text-xs mb-1 mt-4">中部國際機場(TA24)至金山站(NH34)</p>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li>名鐵班次查詢</li>
        <li>準急: 21:22 ~ 22:06</li>
        <li>μ-SKY: 21:37 ~ 22:01</li>
        <li className="text-red-500 font-bold">特急: 21:47 ~ 22:19 (推薦1)</li>
        <li>準急: 21:52 ~ 22:36</li>
        <li className="text-red-500 font-bold">μ-SKY” 22:07 ~ 22:31 (推薦2)</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🚇">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">搭乘市營地下鐵: 紫色M名城線</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>(~12mins) 金山站至久屋大通</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">15:00 ~ 23:00 入住<a href="https://maps.app.goo.gl/gJ6xeGAohoJNUeZW6" target="_blank" className="text-blue-600 hover:underline">名古屋京阪飯店</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>注意最晚入住時間23:00 (已通知飯店可能23:00~00:00才到)</li>
      </ul>
    </ItineraryCard>
  </div>
);

const Day2Content = () => (
  <div className="space-y-4">
    <div className="bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/05 (日) - 犬山祭與下呂溫泉
    </div>
    <ItineraryCard icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">07:00~08:30 早餐 - 享用飯店自助餐</h6>
    </ItineraryCard>
    <ItineraryCard icon="🚗">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">09:00 租車取車，<a href="https://maps.app.goo.gl/nz6e2Wtm3tsQWKLe9" target="_blank" className="text-blue-600 hover:underline">トヨタレンタカー 名古屋錦店</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>租車店 Mapcode: 4 318 223*04</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🏮">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往犬山 - <a href="https://maps.app.goo.gl/15vw277soSoqKwTUA" target="_blank" className="text-blue-600 hover:underline">針綱神社</a>前參加<a href="https://aichinow.pref.aichi.jp/tw/spots/detail/67/" target="_blank" className="text-blue-600 hover:underline">犬山祭</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>有交通管制，停車非常不方便</li>
        <li>可以在江南車站停車，再搭車前往(10min)
          <ul className="list-circle pl-4 mt-1">
            <li>江南駅 Mapcode: 4 885 720*20</li>
          </ul>
        </li>
        <li className="text-red-500 font-bold">注意最晚16:30一定要離開犬山，往下呂路上有車潮，否則會吃不到19:30的晚餐</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🏘️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往<a href="https://maps.app.goo.gl/j5yppFyy9DFANHpX7" target="_blank" className="text-blue-600 hover:underline">下呂溫泉合掌村</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>合掌村前駐車場 Mapcode: 772 480 612*11</li>
        <li>營業時間08:30~17:00 (16:30最後入場)，也可以隔天再玩</li>
        <li>175公尺溜滑梯: <a href="https://maps.app.goo.gl/jjT4CN7hjQXffTxS8" target="_blank" className="text-blue-600 hover:underline">森の滑り台</a></li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">14:00 ~ 19:00 入住 <a href="https://maps.app.goo.gl/vasCkWmNQNxDN1bC7" target="_blank" className="text-blue-600 hover:underline">下呂溫泉水明館</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>水明館 Mapcode: 361 509 278*00</li>
        <li>可免費停車，入浴稅$150，住宿稅$200</li>
        <li>豐富的<a href="https://www.suimeikan.co.jp/facilities/" target="_blank" className="text-blue-600 hover:underline">館內設施</a>，有三個公共浴池
          <ul className="list-circle pl-4 mt-1 space-y-1">
            <li>臨川閣3階 - <a href="https://www.suimeikan.co.jp/hotspring/shimodame.php" target="_blank" className="text-blue-600 hover:underline">下留の湯</a></li>
            <li>飛泉閣9階 - <a href="https://www.suimeikan.co.jp/hotspring/daitenboburo.php" target="_blank" className="text-blue-600 hover:underline">展望大浴場</a></li>
            <li>山水閣1階 - <a href="https://www.suimeikan.co.jp/hotspring/noten.php" target="_blank" className="text-blue-600 hover:underline">野天風呂</a></li>
          </ul>
        </li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">19:30 晚餐 - 飯店的懷石料理</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>飛泉閣1階 - <a href="https://www.suimeikan.co.jp/cuisine/tokiwa/" target="_blank" className="text-blue-600 hover:underline">常磐</a>(Tokiwa)</li>
      </ul>
    </ItineraryCard>
  </div>
);

const Day3Content = () => (
  <div className="space-y-4">
    <div className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/06 (一) - 高山飛驒牛之旅
    </div>
    <ItineraryCard icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">07:00～10:00 早餐 - 享用飯店和洋自助餐 (有規定分流時間)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>飛泉閣1階 - <a href="https://www.suimeikan.co.jp/cuisine/tokiwa/" target="_blank" className="text-blue-600 hover:underline">常磐</a>(Tokiwa)</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🔑">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">11:00 退房</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏘️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往高山 (車程約1hr)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li><a href="https://maps.app.goo.gl/YXFu4SdTcyD4hJFC6" target="_blank" className="text-blue-600 hover:underline">かみいち駐車場</a> Mapcode: 191 196 710*00</li>
        <li className="text-red-500 font-bold">人很多建議不要拖著行李箱逛</li>
        <li><strong>高山老街美食 & 逛街 (可以逛2~3hr)</strong>
          <ul className="list-circle pl-4 mt-1 space-y-1">
            <li>飛驒牛壽司 (<a href="https://maps.app.goo.gl/Pxs3mnfucH5NoBHz6" target="_blank" className="text-blue-600 hover:underline">こって牛</a> 或是 <a href="https://maps.app.goo.gl/SFeJ2CYpKiKi9BXz6" target="_blank" className="text-blue-600 hover:underline">坂口屋</a>)</li>
            <li>飛驒牛串燒、五平餅 (米上面塗甜醬油去烤)</li>
            <li>夢幻雪國布丁(<a href="https://maps.app.goo.gl/3yFxhskWw8PftWbc6" target="_blank" className="text-blue-600 hover:underline">高山布丁亭</a>，限量)</li>
            <li>清酒扭蛋機 ([舩坂酒造店](https://maps.app.goo.gl/NgNuV7z1F63JgaXY8))</li>
          </ul>
        </li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🍲">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">12:00 午餐: 朴葉味噌(Hobamiso，飛驒著名鄉土料理)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li><a href="https://maps.app.goo.gl/Ua1oXfTHiLke6GoZ7" target="_blank" className="text-blue-600 hover:underline">寿々や(Suzuya)</a></li>
        <li><a href="https://maps.app.goo.gl/6dYZWpnhbjUnjNvC6" target="_blank" className="text-blue-600 hover:underline">京や(Kyoya)</a></li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">15:00 ~ 23:00 入住<a href="https://maps.app.goo.gl/kAbdgtiB1k2weCL68" target="_blank" className="text-blue-600 hover:underline">KOKO飯店飛驒高山</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>Mapcode: 191 195 893*25</li>
        <li>停車每晚$1000(僅接受電話預約)，不過附近都有停車場</li>
        <li>入浴稅$150，住宿稅$100 or $200</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🥩">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">18:00 晚餐: 飛驒牛燒肉</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li><a href="https://maps.app.goo.gl/a2HQMFCLiDqB3Crv7" target="_blank" className="text-blue-600 hover:underline">味藏天國</a> <span className="bg-red-500 text-white px-1.5 py-0.5 rounded text-[9px]">爸爸想吃這個</span>
          <ul className="list-circle pl-4 mt-1">
            <li>很熱門，建議16:00左右先來抽號碼牌</li>
          </ul>
        </li>
        <li><strong>或是其他選擇:</strong>
          <ul className="list-circle pl-4 mt-1 space-y-1">
            <li>飛驒牛壽喜燒
              <ul className="pl-4 mt-1 list-square">
                <li><a href="https://maps.app.goo.gl/Vwvhm5i2kHbt1rfA8" target="_blank" className="text-blue-600 hover:underline">鳩谷(Hatoya)</a>: <a href="https://youtu.be/tPTFTmVdQJQ?t=611" target="_blank" className="text-slate-400 hover:underline">Youtube影片</a></li>
                <li><a href="https://maps.app.goo.gl/KNiP8HSkrBuFmnRg6" target="_blank" className="text-blue-600 hover:underline">中橋 わかちや</a></li>
              </ul>
            </li>
            <li>飛驒牛定食: <a href="https://maps.app.goo.gl/aurQQBco4ebRsvy6A" target="_blank" className="text-blue-600 hover:underline">味之與平</a></li>
          </ul>
        </li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🍜">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">21:00前可以吃宵夜</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li>高山拉麵(當宵夜吃，但通常20, 21點就差不多都關了)
          <ul className="list-circle pl-4 mt-1 space-y-1">
            <li><a href="https://maps.app.goo.gl/TjfJocaRx78TukSY9" target="_blank" className="text-blue-600 hover:underline">麵屋真菜</a></li>
            <li><a href="https://maps.app.goo.gl/bkyyxjBq4RpiwnvG9" target="_blank" className="text-blue-600 hover:underline">中華そばM</a></li>
          </ul>
        </li>
      </ul>
    </ItineraryCard>
  </div>
);

const Day4Content = () => (
  <div className="space-y-4">
    <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/07 (二) - 朝市、合掌村與金澤
    </div>
    <ItineraryCard icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">07:00 ~ 10:00 早餐 - 享用飯店自助餐</h6>
    </ItineraryCard>
    <ItineraryCard icon="🔑">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">11:00 退房</h6>
    </ItineraryCard>
    <ItineraryCard icon="🍎">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">早上可以逛<a href="https://maps.app.goo.gl/q1fiKeZcbMT7Jr9N6" target="_blank" className="text-blue-600 hover:underline">宮川朝市</a> (07:00~12:00)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>新鮮水果、飛驒娃娃(猿寶寶)</li>
        <li><a href="https://maps.app.goo.gl/rSy1BZdaNoGPFsYX6" target="_blank" className="text-blue-600 hover:underline">Koma Coffee 餅乾咖啡</a></li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🛖">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往<a href="https://maps.app.goo.gl/pUhmfF9xFMbxVaKr9" target="_blank" className="text-blue-600 hover:underline">白川鄉合掌村</a>(車程約50分鐘)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>自駕要停在<a href="https://maps.app.goo.gl/k1oYCfwSs3pk7RN49" target="_blank" className="text-blue-600 hover:underline">村営せせらぎ公園駐車場</a>
          <ul className="list-circle pl-4 mt-1">
            <li>Mapcode: 549 018 409*44</li>
            <li className="text-red-500 font-bold">注意下午17:00前需離場，停車費已漲價到$2000日幣</li>
          </ul>
        </li>
        <li>在和田家旁可搭乘<a href="https://maps.app.goo.gl/PoxUMDY3upq2nCqx9" target="_blank" className="text-blue-600 hover:underline">展望台接駁車</a></li>
        <li><strong>推薦店家</strong>
          <ul className="list-circle pl-4 mt-1">
            <li className="text-red-500 font-bold">16:00後店家就陸續打烊了</li>
            <li><a href="https://maps.app.goo.gl/9ZWK5jDtWg3gHK4a6" target="_blank" className="text-blue-600 hover:underline">布丁的家</a></li>
          </ul>
        </li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🚗">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往金澤</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li><a href="https://maps.app.goo.gl/vYXBD8Z1YVQrqKceA" target="_blank" className="text-blue-600 hover:underline">近江町市場</a> 找東西吃</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">15:00 ~ 03:00 入住<a href="https://maps.app.goo.gl/2QXYRxLwnEmYePPy8" target="_blank" className="text-blue-600 hover:underline">御宿野乃 金澤天然溫泉飯店</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>Mapcode: 41 558 059*88</li>
        <li>停車每晚$1500</li>
        <li>有免費蕎麥麵和冰棒可以吃</li>
      </ul>
    </ItineraryCard>
  </div>
);

const Day5Content = () => (
  <div className="space-y-4">
    <div className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/08 (三) - 兼六園、休息站巡禮與名花之里
    </div>
    <ItineraryCard icon="🐟">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">06:30 ~ 10:00 早餐 - 享用飯店自助餐 (海鮮丼飯、天婦羅吃到飽)</h6>
    </ItineraryCard>
    <ItineraryCard icon="🔑">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">11:00 退房</h6>
    </ItineraryCard>
    <ItineraryCard icon="🌸">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">11:00~12:30 金澤</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li><a href="https://maps.app.goo.gl/v7oXXWwbLEc9MtsA6" target="_blank" className="text-blue-600 hover:underline">兼六園</a>
          <ul className="list-circle pl-4 mt-1">
            <li><a href="https://maps.app.goo.gl/AUY8kAApkuAiJuzg6" target="_blank" className="text-blue-600 hover:underline">兼六停車場</a> Mapcode: 41 530 064*12</li>
          </ul>
        </li>
        <li>可以找海鮮店當午餐</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🛣️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">交通 (中途在休息站稍作停留): <a href="https://maps.app.goo.gl/H4di1BMzhhqF1ogC8" target="_blank" className="text-blue-600 hover:underline">兼六園至名花之里GoogleMap</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-3 pl-4">
        <li>(~50mins) <a href="https://maps.app.goo.gl/QafTvMmLQbt3XRGB7" target="_blank" className="text-blue-600 hover:underline">尼御前SA(上り)</a> Mapcode: 120 339 692*06</li>
        <li>(~50mins) <a href="https://maps.app.goo.gl/RL2ERgGRahL6FcWE9" target="_blank" className="text-blue-600 hover:underline">南条服務休息站(上行)</a> Mapcode: 200 294 255*40
          <ul className="list-circle pl-4 mt-1">
            <li>福井名產「羽二重餅」</li>
          </ul>
        </li>
        <li>(~40mins) <a href="https://maps.app.goo.gl/Dc7N8YNJNkhfLg7LA" target="_blank" className="text-blue-600 hover:underline">賤ヶ岳SA (上り)</a> Mapcode: 192 386 015*38
          <ul className="list-circle pl-4 mt-1">
            <li>滋賀名產「沙拉麵包」</li>
          </ul>
        </li>
        <li>(~75mins) 前往名花之里或是先check in飯店
          <ul className="list-circle pl-4 mt-1">
            <li>從飯店過去名花之里開車30mins，建議直接去名花之里</li>
          </ul>
        </li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="✨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往<a href="https://maps.app.goo.gl/okKei19fipuBX7tP7" target="_blank" className="text-blue-600 hover:underline">名花之里</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-1 pl-4">
        <li>Mapcode: 38 894 443*56</li>
        <li>約17:00開始點燈，21:00關門</li>
        <li>有免費超大停車場</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">15:00後皆可入住<a href="https://maps.app.goo.gl/z1fYhM3hFzkaPTk57" target="_blank" className="text-blue-600 hover:underline">Comfort Hotel Nagoya Shinkansenguchi</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>Mapcode: 4 315 259*05</li>
        <li>若提早20:00前回去飯店，也可以提早還車</li>
      </ul>
    </ItineraryCard>
  </div>
);

const Day6Content = () => (
  <div className="space-y-4">
    <div className="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/09 (四) - 名古屋市區與鰻魚飯
    </div>
    <ItineraryCard icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">06:30 ~ 09:30 早餐 - 可享用飯店自助餐</h6>
    </ItineraryCard>
    <ItineraryCard icon="🔑">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">09:00 還車，<a href="https://maps.app.goo.gl/nz6e2Wtm3tsQWKLe9" target="_blank" className="text-blue-600 hover:underline">トヨタレンタカー 名古屋錦店</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>租車店 Mapcode: 4 318 223*04</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往樂田神宮，熱田蓬萊軒吃鰻魚飯</h6>
    </ItineraryCard>
    <ItineraryCard icon="✈️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">12:20 華航開放報到選位</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">續住<a href="https://maps.app.goo.gl/z1fYhM3hFzkaPTk57" target="_blank" className="text-blue-600 hover:underline">Comfort Hotel Nagoya Shinkansenguchi</a></h6>
    </ItineraryCard>
  </div>
);

const Day7Content = () => (
  <div className="space-y-4">
    <div className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/10 (五) - 名古屋市區自由行
    </div>
    <ItineraryCard icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">06:30 ~ 09:30 早餐 - 可享用飯店自助餐</h6>
    </ItineraryCard>
    <ItineraryCard icon="🛍️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">行程TBD</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">續住<a href="https://maps.app.goo.gl/z1fYhM3hFzkaPTk57" target="_blank" className="text-blue-600 hover:underline">Comfort Hotel Nagoya Shinkansenguchi</a></h6>
    </ItineraryCard>
  </div>
);

const Day8Content = () => (
  <div className="space-y-4">
    <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2026/04/11 (六) - 返程
    </div>
    <ItineraryCard icon="🍳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">06:30 ~ 09:30 早餐 - 可享用飯店自助餐</h6>
    </ItineraryCard>
    <ItineraryCard icon="🚆">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">搭乘名鐵特殊列車 μ-SKY (ミュースカイ)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs space-y-2 pl-4">
        <li>09:19~09:47 or 09:49~10:17，中間時段也有一般地鐵但比較慢</li>
        <li><a href="https://trainbus.meitetsu.co.jp/meitetsu-transfer-zh-tw/pc/transfer/TransferSearchSelect?orvName=%E5%90%8D%E9%90%B5%E5%90%8D%E5%8F%A4%E5%B1%8B%28NH36%29&orvNode=&dnvName=%E4%B8%AD%E9%83%A8%E5%9C%8B%E9%9A%9B%E6%A9%9F%E5%A0%B4%28TA24%29&dnvNode=&month=2026%2F4&day=11&hour=9&minute=0&basis=1&sort=0&wspeed=standard&method=0&unuse=&month_select=on&day_select=on&hour_select=on&minute_select=on" target="_blank" className="text-blue-600 hover:underline">名鐵班次查詢</a></li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="✈️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">10:00 到達<a href="https://maps.app.goo.gl/635wW51zWggo5w6V7" target="_blank" className="text-blue-600 hover:underline">名古屋中部國際機場</a></h6>
    </ItineraryCard>
    <ItineraryCard icon="🛫">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">12:20 飛機起飛，滿載而歸</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>航班 CI155</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🚐">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">[TW] 14:30 接機專車到機場(<a href="https://www.klook.com/zh-TW/airport-transfers/order-details/?orderGuid=5411398979&bookingNo=FPG611969" target="_blank" className="text-blue-600 hover:underline">Klook</a>)</h6>
    </ItineraryCard>
  </div>
);

export default Nagoya2026;
