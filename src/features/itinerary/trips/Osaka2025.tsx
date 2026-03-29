import React, { useEffect, useRef, useState } from 'react';

// Declaration for Leaflet which is loaded via CDN in index.html
declare global {
  interface Window {
    L: any;
  }
}

const Osaka2025: React.FC = () => {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<any>(null);
  const carMarker = useRef<any>(null);
  const currentPolyline = useRef<any>(null);
  const [activeDay, setActiveTab] = useState('day1');

  // Approximate coordinates for the map routes
  const routes: Record<string, [number, number][]> = {
    'day1': [[34.4320, 135.2304], [34.9858, 135.7588]], // KIX to Kyoto
    'day2': [[34.9858, 135.7588], [35.0130, 135.6717], [34.9858, 135.7588]], // Kyoto to Arashiyama
    'day3': [[34.9858, 135.7588], [34.9949, 135.7850], [35.0050, 135.7650], [34.9858, 135.7588]], // Kyoto East & Nishiki
    'day4': [[34.9858, 135.7588], [35.5684, 135.1919], [35.6750, 135.2850], [34.6687, 135.5013]], // Kyoto to Amanohashidate, Ine, then Osaka
    'day5': [[34.6687, 135.5013], [34.6654, 135.4323], [34.6687, 135.5013]], // Osaka to USJ
    'day6': [[34.6687, 135.5013], [34.6653, 135.5058], [34.6525, 135.5063], [34.6458, 135.5139], [34.6687, 135.5013]], // Osaka City (Kuromon, Tsutenkaku, Abeno)
    'day7': [[34.6687, 135.5013], [34.6873, 135.5262], [34.7024, 135.4959], [34.6687, 135.5013]], // Osaka City (Castle, Umeda)
    'day8': [[34.6687, 135.5013], [34.6641, 135.5013], [34.4320, 135.2304]] // Namba to KIX
  };

  useEffect(() => {
    if (!window.L || !mapRef.current || leafletMap.current) return;

    const L = window.L;
    leafletMap.current = L.map(mapRef.current).setView([34.6937, 135.5023], 10);
    
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
    const duration = 1500;
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
      color: '#e11d48', weight: 4, opacity: 0.7, dashArray: '10, 10'
    }).addTo(leafletMap.current);

    leafletMap.current.flyToBounds(currentPolyline.current.getBounds(), { 
      padding: [40, 40],
      duration: 1.5,
      maxZoom: 12 
    });

    const isTrain = ['day1', 'day2', 'day8'].includes(day);
    const isBus = ['day4'].includes(day);
    const icon = L.divIcon({
      className: 'car-icon',
      html: `<div style="font-size: 24px; text-align: center;">${isTrain ? '🚇' : isBus ? '🚌' : '🚗'}</div>`,
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
      <div ref={mapRef} className="w-full h-48 sm:h-96 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-inner z-0" />

      {/* Tabs */}
      <div className="flex overflow-x-auto pb-2 no-scrollbar gap-2">
        {Object.keys(routes).map((day, idx) => (
          <button
            key={day}
            onClick={() => handleTabChange(day)}
            className={`shrink-0 px-4 py-2 rounded-full text-[10px] sm:text-xs font-bold transition-all border ${
              activeDay === day 
                ? 'bg-rose-600 text-white border-rose-600 shadow-md' 
                : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-100 dark:border-slate-800 hover:border-rose-300'
            }`}
          >
            Day {idx + 1}<br />
            <span className="opacity-70 font-normal text-[9px] sm:text-[10px]">
              {day === 'day1' && '3/8 抵達'}
              {day === 'day2' && '3/9 嵐山'}
              {day === 'day3' && '3/10 京都'}
              {day === 'day4' && '3/11 天橋立'}
              {day === 'day5' && '3/12 環球'}
              {day === 'day6' && '3/13 大阪'}
              {day === 'day7' && '3/14 大阪'}
              {day === 'day8' && '3/15 返程'}
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
    <div className="absolute left-0 top-0 w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white dark:bg-slate-800 border-2 border-rose-600 flex items-center justify-center z-10 shadow-sm text-xs sm:text-sm">
      {icon}
    </div>
    <div className="bg-slate-50/50 dark:bg-slate-800/30 rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-slate-100 dark:border-slate-800 hover:shadow-md transition-shadow">
      {children}
    </div>
  </div>
);

const Day1Content = () => (
  <div className="space-y-4">
    <div className="bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/08 (六) - 抵達京都
    </div>
    <ItineraryCard icon="🚗">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">07:00 TPE 送機🛫 (<a href="https://24tms.vlimo.com.tw/OrderData/ug_Order_Info_0.aspx?ID=D7AEE3BA651C38C487395302E983466DD45E54AB75817D8A6DE09E3413441FDA463BC6B3193738464F0B3C3CB4206C7CD5AA40E6429D9860" target="_blank" className="text-rose-600 hover:underline">預約單</a>)</h6>
      <p className="text-slate-500 text-xs sm:text-xs list-disc pl-4">樂桃航空 (無附餐)</p>
    </ItineraryCard>
    <ItineraryCard icon="✈️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">13:10 抵達關西機場 (KIX)</h6>
    </ItineraryCard>
    <ItineraryCard icon="🚆">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">搭乘 Haruka 前往京都</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>14:14 發車 (約 30 mins 一班)</li>
        <li>15:34 抵達京都車站</li>
        <li className="text-amber-600 font-bold">提醒：買好西瓜卡搭 JR</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🛍️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚上：京都車站逛街</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">入住：<a href="https://maps.app.goo.gl/GEE1szfN4ezpLVHLA" target="_blank" className="text-rose-600 hover:underline">京都八條都酒店</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li><a href="https://tw.trip.com/hotels/ctorderdetail?orderid=1616320064250765&tripsignature=AAEAAQAHb3JkZXJpZIDygk9uaSP5AS4lwdE5hE7GZtq_dxLfyuDNpA_9BHRY-tripsign&curr=TWD&locale=zh-TW" target="_blank" className="text-rose-600 hover:underline">Trip 訂單</a></li>
        <li>雙人房 $3548 (含早餐)</li>
      </ul>
    </ItineraryCard>
  </div>
);

const Day2Content = () => (
  <div className="space-y-4">
    <div className="bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/09 (日) - 京都嵐山半日遊
    </div>
    <ItineraryCard icon="🚆">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">前往嵐山</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>09:11 JR 京都站發車</li>
        <li>09:50 <a href="https://maps.app.goo.gl/ZvmMGwQFdHuw2ypb6" target="_blank" className="text-rose-600 hover:underline">嵐山火車站</a>內集合</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🚂">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">嵐山小火車 & 京馬車 & 保津川遊船 (<a href="https://www.kkday.com/zh-tw/order/show/25KK202942671" target="_blank" className="text-rose-600 hover:underline">KKday 訂單</a>)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>10:02~10:25 嵯峨站-亀岡站</li>
        <li>10:35 搭乘京馬車</li>
        <li>11:00 搭乘保津川遊船</li>
        <li>12:30~13:30 渡月橋解散</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">午餐：鰻魚飯、豆腐</h6>
    </ItineraryCard>
    <ItineraryCard icon="🎋">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">下午：嵐山景點</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>渡月橋、嵐山竹林、嵐山附近逛街</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🚆">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚上：搭 JR 回京都車站休息</h6>
    </ItineraryCard>
  </div>
);

const Day3Content = () => (
  <div className="space-y-4">
    <div className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/10 (一) - 京都東邊和服體驗
    </div>
    <ItineraryCard icon="🚌">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">09:00 前往夢京都 (或 08:40 搭 206 公車)</h6>
    </ItineraryCard>
    <ItineraryCard icon="👘">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1"><a href="https://maps.app.goo.gl/JwRC19tT6tZiPzPx9" target="_blank" className="text-rose-600 hover:underline">夢京都租和服</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>09:30 開始體驗 (17:30 前歸還)</li>
        <li>上午：清水寺參拜</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">14:00 歸還和服、吃午餐</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏮">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">下午：錦市場逛街</h6>
      <p className="text-slate-500 text-xs sm:text-xs pl-4">可搭巴士、走路或叫 Uber</p>
    </ItineraryCard>
    <ItineraryCard icon="🧳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚上：回飯店收行李</h6>
      <p className="text-rose-500 font-bold text-xs sm:text-xs pl-4">⚠️ 晚上要收行李！！！</p>
    </ItineraryCard>
  </div>
);

const Day4Content = () => (
  <div className="space-y-4">
    <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/11 (二) - 天橋立一日遊 & 移往大阪
    </div>
    <ItineraryCard icon="🔑">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">09:00 京都車站上遊覽車</h6>
      <p className="text-slate-500 text-xs sm:text-xs pl-4">飯店 11:00 前需 Check out</p>
    </ItineraryCard>
    <ItineraryCard icon="🚠">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">天橋立一日遊 (<a href="https://www.kkday.com/zh-tw/order/show/25KK204322515" target="_blank" className="text-rose-600 hover:underline">KKday 訂單</a>)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>11:00 天橋立飛龍展望台 (午餐自理)</li>
        <li>14:00 搭伊根灣觀光遊覽船 (25 mins)</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="🍱">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">18:30 大阪蟹道樂東店解散</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏨">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">入住：<a href="https://maps.app.goo.gl/kBLrawFN8bx9Skpu6" target="_blank" className="text-rose-600 hover:underline">大阪難波道頓堀佛沙飯店</a></h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li><a href="https://www.agoda.com/zh-tw/account/editbooking.html?bookingId=0xHOHYcFxgfy%20z0zP5staw%3D%3D&af_sub3=09122f93-b443-49c3-ad46-0e276fb3e0c8&af_sub1=EXP-ID-AM-7193-B&c=CONFIRMATION_EMAIL_ONELINK&pid=redirect&deep_link_value=agoda%3A%2F%2Fhome%2F&af_sub4=Hotel&af_force_deeplink=true" target="_blank" className="text-rose-600 hover:underline">Agoda 訂單</a></li>
        <li>雙人房 $3538 (不含早餐)</li>
      </ul>
    </ItineraryCard>
  </div>
);

const Day5Content = () => (
  <div className="space-y-4">
    <div className="bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/12 (三) - 環球影城 (USJ)
    </div>
    <ItineraryCard icon="🚕">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">06:00 叫車前往環球影城</h6>
    </ItineraryCard>
    <ItineraryCard icon="🎢">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">08:30 入場環球影城 (<a href="https://www.kkday.com/zh-tw/order/show/25KK224332307" target="_blank" className="text-rose-600 hover:underline">KKday 訂單</a>)</h6>
      <p className="text-slate-500 text-xs sm:text-xs pl-4">門票電子檔: <a href="https://drive.google.com/drive/folders/1_KIW0SAr_1XS1ER8PqCJ9hrjUu-ObPUY?usp=drive_link" target="_blank" className="text-rose-600 hover:underline">Google Drive</a></p>
    </ItineraryCard>
    <ItineraryCard icon="🍗">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚上：鳥貴族 (燒肉)</h6>
    </ItineraryCard>
  </div>
);

const Day6Content = () => (
  <div className="space-y-4">
    <div className="bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/13 (四) - 大阪市區一日遊 (周遊卡)
    </div>
    <ItineraryCard icon="💳">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">啟用兩日大阪周遊卡 (<a href="https://linkt.to/XsXqF24W" target="_blank" className="text-rose-600 hover:underline">Surutto QRtto</a>)</h6>
    </ItineraryCard>
    <ItineraryCard icon="🦀">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">08:00~10:00 黑門市場</h6>
    </ItineraryCard>
    <ItineraryCard icon="🗼">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">10:00~13:00 通天閣逛街</h6>
    </ItineraryCard>
    <ItineraryCard icon="📲">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">12:45 華航選位置 (用 APP)</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏙️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">13:00~14:00 阿倍野商圈</h6>
    </ItineraryCard>
    <ItineraryCard icon="🚢">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚上：道頓堀、心齋橋</h6>
      <p className="text-slate-500 text-xs sm:text-xs pl-4">11:00~21:00 道頓堀水上觀光船</p>
    </ItineraryCard>
  </div>
);

const Day7Content = () => (
  <div className="space-y-4">
    <div className="bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/14 (五) - 大阪市區自由行
    </div>
    <ItineraryCard icon="🏯">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">09:00~11:00 天滿宮 (或天守閣)</h6>
    </ItineraryCard>
    <ItineraryCard icon="🛍️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">11:00~14:00 梅田商圈百貨</h6>
    </ItineraryCard>
    <ItineraryCard icon="🚶">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">下午：天神橋筋商店街</h6>
    </ItineraryCard>
  </div>
);

const Day8Content = () => (
  <div className="space-y-4">
    <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-0 text-center p-2 sm:p-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold mb-4">
      2025/03/15 (六) - 準備回程
    </div>
    <ItineraryCard icon="🔑">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">09:00 Check out</h6>
    </ItineraryCard>
    <ItineraryCard icon="🚆">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">搭乘南海特急 Rapit (<a href="https://linkt.to/kJ3yCdq1" target="_blank" className="text-rose-600 hover:underline">Surutto QRtto</a>)</h6>
      <ul className="text-slate-500 text-xs sm:text-xs list-disc pl-4">
        <li>09:28 難波站發車</li>
        <li>10:08 抵達關西機場</li>
      </ul>
    </ItineraryCard>
    <ItineraryCard icon="✈️">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">15:00 TPE 接機🛬 (<a href="https://24tms.vlimo.com.tw/OrderData/ug_Order_Info_0.aspx?ID=85D45F568A0B724623927156AA2A8DC614D746122E670E68358B0C8BD817CE304994D5815FC8BF457FA506E062CAC4509BCA929A0936A8B3" target="_blank" className="text-rose-600 hover:underline">預約單</a>)</h6>
    </ItineraryCard>
    <ItineraryCard icon="🏠">
      <h6 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base mb-1">晚上：溫暖的家</h6>
    </ItineraryCard>
  </div>
);

export default Osaka2025;
