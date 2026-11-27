import React from 'react';
import { Archive, CalendarDays, ChevronRight, Users } from 'lucide-react';
import type { Trip } from '../../types';
import { formatTripDates, formatTripDatesShort, tripDayCount, tripStampParts } from '../../utils/tripDates';

const currencyList = (trip: Trip) => Object.keys(trip.rates || {}).join(' · ');

const formatCreated = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

/** 最近一趟進行中的旅程，做成登機證樣式放在最上面 */
export const FeaturedTrip: React.FC<{ trip: Trip; onClick: () => void }> = ({ trip, onClick }) => (
  <button
    onClick={onClick}
    className="group w-full h-full flex flex-col text-left bg-navy text-navy-fg rounded-2xl overflow-hidden transition-transform active:scale-[.99] focus-visible:outline-2 focus-visible:outline-accent"
  >
    <div className="px-5 pt-5 pb-4 flex items-start gap-4 flex-1">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-navy-sub">{trip.category?.trim() || '最近的旅程'}</p>
        <h2 className="text-xl sm:text-2xl font-bold leading-snug mt-1 text-balance">{trip.name}</h2>
      </div>
      <span className="shrink-0 w-10 h-10 rounded-xl bg-accent text-on-accent flex items-center justify-center transition-transform group-hover:translate-x-0.5">
        <ChevronRight size={20} strokeWidth={2.4} />
      </span>
    </div>
    <div className="perforation self-stretch" style={{ ['--notch-bg' as string]: 'var(--app-bg)' }} />
    {formatTripDates(trip) ? (
      // 有旅程日期：日期占一半寬（一段時間的字比較長），成員、幣別各四分之一
      <div className="w-full grid grid-cols-4 gap-2 px-5 pt-3.5 pb-4 text-xs text-navy-sub">
        <div className="col-span-2 min-w-0">
          日期{(tripDayCount(trip) ?? 1) > 1 && <span className="num">・{tripDayCount(trip)} 天</span>}
          <b className="block num text-sm font-bold text-navy-fg mt-0.5 truncate">{formatTripDates(trip)}</b>
        </div>
        <div>成員<b className="block num text-sm font-bold text-navy-fg mt-0.5">{trip.members.length} 人</b></div>
        <div className="min-w-0">幣別<b className="block num text-sm font-bold text-navy-fg mt-0.5 truncate">{currencyList(trip)}</b></div>
      </div>
    ) : (
      <div className="w-full grid grid-cols-3 gap-2 px-5 pt-3.5 pb-4 text-xs text-navy-sub">
        <div>成員<b className="block num text-sm font-bold text-navy-fg mt-0.5">{trip.members.length} 人</b></div>
        <div className="min-w-0">幣別<b className="block num text-sm font-bold text-navy-fg mt-0.5 truncate">{currencyList(trip)}</b></div>
        <div>建立於<b className="block num text-sm font-bold text-navy-fg mt-0.5">{formatCreated(trip.created_at)}</b></div>
      </div>
    )}
  </button>
);

/** 旅程的年月（有填旅程日期用開始日，沒有用建立時間），畫成左邊的小日期章；封存的旅程整列淡一點 */
export const TripStamp: React.FC<{ trip: Trip }> = ({ trip }) => {
  const { year, month } = tripStampParts(trip);
  return (
    <span
      title={formatTripDates(trip) ?? `建立於 ${formatCreated(trip.created_at)}`}
      className={`shrink-0 w-11 h-11 rounded-xl flex flex-col items-center justify-center leading-none num ${
        trip.is_archived ? 'bg-sunk text-muted' : 'bg-accent/15 text-ink'
      }`}
    >
      <span className="text-[10px] font-medium opacity-70">{year}</span>
      <span className="text-[15px] font-bold mt-1">{month}月</span>
    </span>
  );
};

export const TripMeta: React.FC<{ trip: Trip }> = ({ trip }) => (
  <p className="text-xs text-muted mt-0.5 flex items-center gap-2 min-w-0">
    {formatTripDatesShort(trip) && (
      <span className="shrink-0 inline-flex items-center gap-1 num"><CalendarDays size={12} />{formatTripDatesShort(trip)}</span>
    )}
    <span className="shrink-0 inline-flex items-center gap-1"><Users size={12} />{trip.members.length} 人</span>
    <span className="num truncate">{currencyList(trip)}</span>
  </p>
);

export const ArchivedBadge: React.FC = () => (
  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-ink-2 bg-sunk border border-line rounded-md px-2 py-0.5">
    <Archive size={10} />已封存
  </span>
);

export const TripRow: React.FC<{ trip: Trip; onClick: () => void }> = ({ trip, onClick }) => (
  <button
    onClick={onClick}
    className="group w-full text-left flex items-center gap-3 px-3.5 py-3 hover:bg-sunk transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
  >
    <TripStamp trip={trip} />
    <div className="min-w-0 flex-1">
      <p className={`text-[15px] font-medium truncate ${trip.is_archived ? 'text-ink-2' : 'text-ink'}`}>{trip.name}</p>
      <TripMeta trip={trip} />
    </div>
    {trip.is_archived ? <ArchivedBadge /> : (
      <ChevronRight size={18} className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
    )}
  </button>
);
