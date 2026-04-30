import React, { useState } from 'react';
import { Clock, MapPin, Ticket, Info, Calendar, AlertCircle, Train, BedDouble, Star } from 'lucide-react';

const TRIP_DATES: Record<string, 'day1' | 'day2'> = {
  '2026-05-03': 'day1',
  '2026-05-04': 'day2',
};

const getInitialDay = (): 'day1' | 'day2' => {
  const t = new Date();
  const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return TRIP_DATES[key] ?? 'day1';
};

const TaichungEscape2026: React.FC = () => {
  const [activeDay, setActiveDay] = useState<'day1' | 'day2'>(getInitialDay);

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12 animate-in fade-in duration-500">
      {/* Header Title */}
      <div className="text-center space-y-2 py-4">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white">
          2026 🗝️ 台中密室逃脫兩日遊 🗝️
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm">燒腦又刺激的密室挑戰行程</p>
      </div>

      {/* Day Selector */}
      <div className="flex justify-center gap-4 sticky top-4 z-20">
        <button
          onClick={() => setActiveDay('day1')}
          className={`px-6 py-3 rounded-2xl font-bold transition-all shadow-sm flex items-center gap-2 border ${
            activeDay === 'day1'
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-indigo-300'
          }`}
        >
          <Calendar size={18} />
          Day 1 - 05/03 (日)
        </button>
        <button
          onClick={() => setActiveDay('day2')}
          className={`px-6 py-3 rounded-2xl font-bold transition-all shadow-sm flex items-center gap-2 border ${
            activeDay === 'day2'
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-indigo-300'
          }`}
        >
          <Calendar size={18} />
          Day 2 - 05/04 (一)
        </button>
      </div>

      {/* Content */}
      <div className="space-y-6 pt-4">
        {activeDay === 'day1' ? (
          <>
            <TrainCard
              stops={[
                { station: '台北', time: '09:21' },
                { station: '桃園', time: '09:43' },
                { station: '台中', time: '10:25' },
              ]}
            />
            <EscapeCard
              time="14:00 ~ 16:00"
              location="Loop迴圈工作室－旗艦館"
              locationLink="https://maps.app.goo.gl/ucAiDGpN1eQ1j3Sp9"
              gameTitle="惠貞女子高校"
              gameLink="https://escape.bar/game/11284"
              notes={[
                "⭐ 無訂金，尾款僅收現金 $5200"
              ]}
              themeColor="rose"
            />
            <EscapeCard
              time="17:00 ~ 19:00"
              location="Escer異世客華美店-台中密室逃脫"
              locationLink="https://maps.app.goo.gl/xis6Bm8t4nXAe5rAA"
              gameTitle="暗影潛行"
              gameLink="https://escape.bar/game/19923"
              notes={[
                "⭐ 訂金 $1000，尾款僅收現金 $7000"
              ]}
              themeColor="slate"
            />
            <HotelCard
              name="台中香榭驪舍大飯店"
              nameEn="Champs Elysees Hotel"
              mapLink="https://maps.app.goo.gl/HR7t5Z2jLWGax2MJ9"
              room="家庭房 — 5 張大床"
              notes={["離一中街夜市很近，晚上可以散步去逛！"]}
            />
          </>
        ) : (
          <>
            <EscapeCard 
              time="10:30 ~ 12:30"
              location="哇沙謎江戶時代館"
              locationLink="https://maps.app.goo.gl/3iQiAwoHwkJobXfZ8"
              gameTitle="時光列車"
              gameLink="https://escape.bar/game/24458"
              notes={[
                "⭐ 全程必須脫鞋進場",
                "⭐ 訂金 $1000，尾款 $5400"
              ]}
              themeColor="amber"
            />
            <EscapeCard 
              time="14:00 ~ 16:40"
              location="哇沙謎江戶時代館"
              locationLink="https://maps.app.goo.gl/3iQiAwoHwkJobXfZ8"
              gameTitle="冒險王"
              gameLink="https://escape.bar/game/12483"
              notes={[
                "⭐ 面對「普羅眼鏡綠色招牌左邊」的「轉角大樓梯」走下去邊日式建築",
                "⭐ 請「提早 10 分鐘上廁所」，附近 7-11 及工作室樓梯下方有廁所",
                "⭐ 有眾多攀爬不要穿裙子",
                "⭐ 全程脫鞋子、脫襪子",
                "⭐ 遊戲過程中如果危險動作或夥伴之間沒有幫忙，有可能會全濕",
                "⭐ 訂金 $2000，尾款 $6000"
              ]}
              themeColor="emerald"
            />
          </>
        )}
      </div>
    </div>
  );
};

// --- Train Card ---

interface TrainStop { station: string; time: string; }
interface TrainCardProps { stops: TrainStop[]; }

const TrainCard: React.FC<TrainCardProps> = ({ stops }) => (
  <div className="overflow-hidden rounded-3xl border border-blue-200 dark:border-blue-900/50 bg-blue-50/30 dark:bg-blue-900/10 shadow-sm">
    <div className="p-5 sm:p-8">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue-500 mb-4">
        <Train size={15} />
        台灣高鐵 — 出發
      </div>
      <div className="flex items-center gap-0">
        {stops.map((stop, idx) => (
          <React.Fragment key={stop.station}>
            <div className="flex flex-col items-center gap-1 min-w-[72px]">
              <span className="text-base sm:text-lg font-black text-slate-900 dark:text-white">{stop.station}</span>
              <span className="text-xs font-black text-blue-600 tabular-nums">{stop.time}</span>
            </div>
            {idx < stops.length - 1 && (
              <div className="flex-1 flex items-center mx-1">
                <div className="h-0.5 flex-1 bg-blue-200 dark:bg-blue-800 rounded-full" />
                <div className="w-1.5 h-1.5 bg-blue-400 rounded-full mx-0.5" />
                <div className="h-0.5 flex-1 bg-blue-200 dark:bg-blue-800 rounded-full" />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  </div>
);

// --- Hotel Card ---

interface HotelCardProps {
  name: string;
  nameEn: string;
  mapLink: string;
  room: string;
  notes: string[];
}

const HotelCard: React.FC<HotelCardProps> = ({ name, nameEn, mapLink, room, notes }) => (
  <div className="overflow-hidden rounded-3xl border border-violet-200 dark:border-violet-900/50 bg-violet-50/30 dark:bg-violet-900/10 shadow-sm">
    <div className="p-5 sm:p-8 flex flex-col sm:flex-row gap-6">
      {/* Icon Sidebar */}
      <div className="sm:w-32 shrink-0 flex items-center sm:block">
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 text-center border border-slate-100 dark:border-slate-800 shadow-sm w-full">
          <BedDouble className="mx-auto mb-1 text-violet-400" size={18} />
          <div className="text-xs font-black text-slate-500 dark:text-slate-400 leading-tight mt-1">晚上住宿</div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 space-y-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
            <MapPin size={13} />
            住宿地點
          </div>
          <a
            href={mapLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white hover:text-violet-600 transition-colors inline-block underline decoration-violet-200 underline-offset-4"
          >
            {name}
          </a>
          <p className="text-sm text-slate-400 font-bold">{nameEn}</p>
        </div>

        <div className="flex items-center gap-2 text-sm font-black text-violet-700 dark:text-violet-400 bg-violet-100/60 dark:bg-violet-900/20 px-3 py-2 rounded-xl w-fit">
          <BedDouble size={14} />
          {room}
        </div>

        {notes.length > 0 && (
          <div className="bg-white/60 dark:bg-slate-900/60 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 space-y-1.5">
            {notes.map((note, idx) => (
              <p key={idx} className="text-sm text-slate-700 dark:text-slate-300 flex items-start gap-2 leading-relaxed">
                <Star size={11} className="text-violet-400 shrink-0 mt-1 fill-violet-300" />
                {note}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  </div>
);

// --- Escape Card ---

interface EscapeCardProps {
  time: string;
  location: string;
  locationLink: string;
  gameTitle: string;
  gameLink: string;
  notes: string[];
  themeColor: 'rose' | 'slate' | 'amber' | 'emerald' | 'indigo';
}

const EscapeCard: React.FC<EscapeCardProps> = ({ time, location, locationLink, gameTitle, gameLink, notes, themeColor }) => {
  const colorMap = {
    rose: 'border-rose-200 dark:border-rose-900/50 bg-rose-50/30 dark:bg-rose-900/10 text-rose-600',
    slate: 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 text-slate-600',
    amber: 'border-amber-200 dark:border-amber-900/50 bg-amber-50/30 dark:bg-amber-900/10 text-amber-600',
    emerald: 'border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/30 dark:bg-emerald-900/10 text-emerald-600',
    indigo: 'border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/30 dark:bg-indigo-900/10 text-indigo-600',
  };

  return (
    <div className={`overflow-hidden rounded-3xl border shadow-sm transition-all hover:shadow-md ${colorMap[themeColor]}`}>
      <div className="p-5 sm:p-8 flex flex-col sm:flex-row gap-6">
        {/* Time Sidebar */}
        <div className="sm:w-32 shrink-0 flex items-center sm:block">
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 text-center border border-slate-100 dark:border-slate-800 shadow-sm w-full">
            <Clock className="mx-auto mb-1 text-slate-400" size={16} />
            <div className="text-sm font-black text-slate-900 dark:text-white leading-tight">
              {time.split(' ~ ')[0]}<br/>
              <span className="text-[10px] text-slate-400 font-normal">to</span><br/>
              {time.split(' ~ ')[1]}
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Ticket size={14} />
              Escape Room
            </div>
            <a 
              href={gameLink} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white hover:text-indigo-600 transition-colors inline-block underline decoration-indigo-200 underline-offset-4"
            >
              {gameTitle}
            </a>
          </div>

          <div className="flex items-start gap-2 text-slate-600 dark:text-slate-400 text-sm">
            <MapPin className="shrink-0 mt-0.5 text-slate-400" size={16} />
            <a 
              href={locationLink} 
              target="_blank" 
              rel="noopener noreferrer"
              className="hover:underline hover:text-indigo-500"
            >
              {location}
            </a>
          </div>

          <div className="pt-2 space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
              <Info size={14} />
              注意事項
            </div>
            <div className="bg-white/60 dark:bg-slate-900/60 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 space-y-2">
              {notes.map((note, idx) => (
                <p key={idx} className="text-sm text-slate-700 dark:text-slate-300 flex items-start gap-2 leading-relaxed">
                  <span className="shrink-0 mt-1"><AlertCircle size={12} className="text-indigo-400" /></span>
                  {note}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaichungEscape2026;
