import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  BedDouble, Bus, Camera, Car, Check, ChevronDown, ChevronRight, Footprints, Info, Map as MapIcon,
  MapPin, Navigation, Plane, ShoppingBag, Sparkles, Ticket, TrainFront, Utensils,
} from 'lucide-react';
import type { BookingStatus, DayPlan, ItemKind, ItineraryPlan, Stay } from './types';
import {
  availableViews, dateParts, dayRoute, itemStates, nightsBetween, nowIn, placeUrl, todayIndex, unlinkedPlaces,
  type ItemState, type ItineraryView as View,
} from './plan';
import { THEMES, TITLE_FONT_FAMILY, TITLE_FONT_HREF } from './themes';
import { NoteList, RichText } from './RichText';
import RouteMap from './RouteMap';

const KIND_ICON: Record<ItemKind, LucideIcon> = {
  flight: Plane, train: TrainFront, car: Car, bus: Bus, walk: Footprints, sight: Camera,
  food: Utensils, hotel: BedDouble, shopping: ShoppingBag, activity: Sparkles, info: Info,
};

const STATUS: Record<BookingStatus, { label: string; cls: string }> = {
  paid: { label: '已付清', cls: 'bg-pos/12 text-pos' },
  booked: { label: '已預約', cls: 'bg-info/12 text-info' },
  walkin: { label: '現場排隊', cls: 'bg-accent/18 text-ink' },
  todo: { label: '待預訂', cls: 'bg-warn/14 text-warn' },
  pending: { label: '未確認', cls: 'bg-sunk text-muted border border-line' },
};

const StatusBadge: React.FC<{ status: BookingStatus }> = ({ status }) => (
  <span className={`shrink-0 inline-block rounded-md px-1.5 text-[11px] font-bold leading-[18px] ${STATUS[status].cls}`}>{STATUS[status].label}</span>
);

const VIEW_LABEL: Record<View, string> = { overview: '一覽', daily: '每日', prep: '行前' };

/** Loads a Google Fonts stylesheet once, only for themes that use a display face. */
const useStylesheet = (href?: string) => {
  useEffect(() => {
    if (!href || document.querySelector(`link[data-it-font="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.itFont = href;
    document.head.appendChild(link);
  }, [href]);
};

const titleStyle: React.CSSProperties = { fontFamily: 'var(--t-title-font)' };

// ---------- cover ----------

const Cover: React.FC<{ plan: ItineraryPlan; compact?: boolean }> = ({ plan, compact }) => {
  const Motif = THEMES[plan.theme].motif;
  const first = plan.days[0];
  const last = plan.days[plan.days.length - 1];
  const range = first && last
    ? `${first.date.slice(0, 4)}/${dateParts(first.date).md}（${dateParts(first.date).weekday}）– ${dateParts(last.date).md}（${dateParts(last.date).weekday}）· ${plan.days.length} 天`
    : '';
  return (
    <header className={`relative overflow-hidden rounded-2xl text-white ${compact ? 'px-4 py-3' : 'px-5 pt-5 pb-4'}`} style={{ background: 'var(--t-cover)' }}>
      <Motif aria-hidden className="absolute -right-3 -top-4 text-white/20" size={compact ? 84 : 120} strokeWidth={1.2} />
      {plan.tagline && <p className="relative text-[11px] font-bold tracking-[0.08em] text-white/75 num">{plan.tagline}</p>}
      <h2 className={`relative font-bold leading-snug text-balance ${compact ? 'text-lg' : 'text-[22px] sm:text-2xl mt-0.5'}`} style={titleStyle}>{plan.title}</h2>
      {!compact && range && <p className="relative text-[13px] text-white/85 mt-1 num">{range}</p>}
      {!compact && plan.tags && plan.tags.length > 0 && (
        <ul className="relative flex flex-wrap gap-1.5 mt-3">
          {plan.tags.map(t => <li key={t} className="text-[11px] bg-white/18 rounded-full px-2.5 py-0.5">{t}</li>)}
        </ul>
      )}
    </header>
  );
};

// ---------- overview ----------

const OverviewList: React.FC<{
  plan: ItineraryPlan;
  stays: Map<string, Stay>;
  today: number;
  active: number;
  highlightActive: boolean;
  onPick: (index: number) => void;
}> = ({ plan, stays, today, active, highlightActive, onPick }) => (
  <ol className="bg-surface border border-line rounded-2xl overflow-hidden divide-y divide-line">
    {plan.days.map((day, i) => {
      const { md, weekday } = dateParts(day.date);
      const stay = day.stay ? stays.get(day.stay) : undefined;
      const on = highlightActive && i === active;
      return (
        <li key={day.date}>
          <button
            onClick={() => onPick(i)}
            aria-current={on ? 'true' : undefined}
            className={`w-full grid grid-cols-[44px_minmax(0,1fr)_14px] items-center gap-3 px-3 py-2.5 text-left transition-colors ${
              on ? 'bg-[var(--t-soft)]' : i === today ? 'bg-[var(--t-soft)]/60 hover:bg-[var(--t-soft)]' : 'hover:bg-sunk'
            }`}
          >
            <span className="grid justify-items-center leading-tight">
              <b className={`num text-sm font-extrabold ${i === today || on ? 'text-[var(--t-accent)]' : ''}`}>{md}</b>
              <span className="text-[10.5px] text-muted">週{weekday}</span>
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="text-sm font-medium truncate">{day.title}</span>
                {i === today && <span className="shrink-0 text-[10px] font-bold rounded px-1.5 leading-[17px] bg-[var(--t-accent)] text-[var(--t-on)]">今天</span>}
              </span>
              <span className="block text-[11.5px] text-muted truncate">
                D{i + 1}{day.city ? ` · ${day.city}` : ''}{stay ? ` · 住 ${stay.name}` : ''}
              </span>
            </span>
            <ChevronRight size={15} className="text-muted" />
          </button>
        </li>
      );
    })}
  </ol>
);

// ---------- day detail ----------

const DayChips: React.FC<{ plan: ItineraryPlan; active: number; today: number; onPick: (i: number) => void }> = ({ plan, active, today, onPick }) => {
  const ref = useRef<HTMLDivElement>(null);
  // 天數多的時候，讓選中的那天捲進可見範圍
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);
  return (
    <div ref={ref} className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 lg:mx-0 lg:px-0 py-0.5" role="tablist" aria-label="選擇日期">
      {plan.days.map((day, i) => {
        const on = i === active;
        return (
          <button
            key={day.date}
            role="tab"
            aria-selected={on}
            aria-current={on ? 'true' : undefined}
            onClick={() => onPick(i)}
            className={`shrink-0 min-w-[50px] rounded-xl border px-2 py-1 grid justify-items-center leading-tight transition-colors ${
              on ? 'bg-[var(--t-accent)] border-[var(--t-accent)] text-[var(--t-on)]' : 'bg-surface border-line text-muted hover:text-ink'
            }`}
          >
            <span className="text-[10.5px]">{i === today ? '今天' : `D${i + 1}`}</span>
            <b className={`num text-[13px] font-bold ${on ? '' : 'text-ink'}`}>{dateParts(day.date).md}</b>
          </button>
        );
      })}
    </div>
  );
};

const stateLabel: Partial<Record<NonNullable<ItemState>, string>> = { now: '現在', next: '下一站' };

const DayDetail: React.FC<{ day: DayPlan; index: number; isToday: boolean; states: ItemState[]; stay?: Stay; nightNo?: number }> = ({
  day, index, isToday, states, stay, nightNo,
}) => {
  const { md, weekday } = dateParts(day.date);
  const route = dayRoute(day);
  return (
    <article className="space-y-3" aria-label={`第 ${index + 1} 天：${day.title}`}>
      <header>
        <p className="text-xs font-bold text-[var(--t-accent)] num">
          {md}（{weekday}）{day.city ? ` · ${day.city}` : ''}{isToday ? ' · 今天' : ''}
        </p>
        <h3 className="text-xl sm:text-[22px] font-bold leading-snug mt-0.5 text-balance" style={titleStyle}>{day.title}</h3>
      </header>

      {day.tips && day.tips.length > 0 && (
        <div className="rounded-xl bg-[var(--t-soft)] px-3.5 py-2.5">
          <NoteList notes={day.tips} />
        </div>
      )}

      {route && (
        <a
          href={route.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 rounded-xl bg-surface border border-line px-3.5 py-2.5 text-[13px] text-ink-2 hover:bg-sunk transition-colors"
        >
          <Navigation size={16} className="text-[var(--t-accent)] shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {route.places.length > 1 ? <>{isToday ? '今天' : '這天'} <b className="text-ink">{route.places.length} 個地點</b>：{route.places.map(p => p.name).join('、')}</> : <>在地圖上查看 <b className="text-ink">{route.places[0].name}</b></>}
          </span>
          <span className="shrink-0 text-[var(--t-accent)] font-bold inline-flex items-center">Google 地圖<ChevronRight size={14} /></span>
        </a>
      )}

      {day.extra}

      <ol className="pt-1">
        {day.items.map((item, i) => {
          const Icon = KIND_ICON[item.kind];
          const state = states[i];
          const isLast = i === day.items.length - 1;
          return (
            <li key={i} className="grid grid-cols-[48px_26px_minmax(0,1fr)] gap-x-2">
              <div className="text-right pt-[3px] leading-tight">
                {item.time ? (
                  <>
                    <span className={`num text-[12.5px] font-bold ${state === 'done' ? 'text-muted' : 'text-ink-2'}`}>{item.time.split('–')[0]}</span>
                    {item.time.includes('–') && <span className="num block text-[10.5px] text-muted">– {item.time.split('–')[1]}</span>}
                  </>
                ) : (
                  <span className="text-[11.5px] text-muted">{item.slot}</span>
                )}
              </div>
              <div className="relative flex justify-center">
                {!isLast && <span className="absolute top-6 bottom-0 w-px bg-line" aria-hidden />}
                {i > 0 && <span className="absolute top-0 h-1 w-px bg-line" aria-hidden />}
                <span
                  className={`relative mt-0.5 w-[22px] h-[22px] rounded-full flex items-center justify-center ${
                    state === 'next' || state === 'now'
                      ? 'bg-[var(--t-accent)] text-[var(--t-on)] ring-4 ring-[var(--t-soft)]'
                      : state === 'done'
                        ? 'bg-sunk text-muted border border-line'
                        : 'bg-[var(--t-soft)] text-[var(--t-accent)]'
                  }`}
                  aria-hidden
                >
                  <Icon size={12} strokeWidth={2.2} />
                </span>
              </div>
              <div className={`min-w-0 ${isLast ? 'pb-1' : 'pb-4'}`}>
                <p className={`text-[15px] leading-snug flex flex-wrap items-center gap-x-1.5 gap-y-1 ${state === 'done' ? 'text-muted' : 'font-bold text-ink'}`}>
                  <span className="min-w-0"><RichText text={item.title} places={item.places} /></span>
                  {item.undecided && <span className="text-[10.5px] font-medium rounded px-1.5 leading-[17px] bg-sunk border border-line text-muted">未定</span>}
                  {item.tag && <span className="text-[10.5px] font-bold rounded px-1.5 leading-[17px] bg-neg/12 text-neg">{item.tag}</span>}
                  {state && stateLabel[state] && <span className="text-[10.5px] font-bold rounded px-1.5 leading-[17px] bg-[var(--t-accent)] text-[var(--t-on)]">{stateLabel[state]}</span>}
                </p>
                {unlinkedPlaces(item.title, item.places).length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
                    {unlinkedPlaces(item.title, item.places).map(p => (
                      <a key={p.name} href={placeUrl(p)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--t-accent)] hover:underline">
                        <MapPin size={12} className="shrink-0" />{p.name}
                      </a>
                    ))}
                  </p>
                )}
                {item.notes && item.notes.length > 0 && <div className="mt-1"><NoteList notes={item.notes} /></div>}
                {item.booking && (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-sunk border border-line px-2 py-1 text-xs text-ink-2 max-w-full">
                    <Ticket size={13} className="shrink-0 text-muted" />
                    <span className="truncate">{item.booking.href ? <a href={item.booking.href} target="_blank" rel="noreferrer" className="underline">{item.booking.label ?? '預訂'}</a> : item.booking.label ?? '預訂'}</span>
                    <StatusBadge status={item.booking.status} />
                  </p>
                )}
                {item.extra && <div className="mt-2">{item.extra}</div>}
              </div>
            </li>
          );
        })}
      </ol>

      {stay && (
        <section className="rounded-xl bg-[var(--t-soft)] px-3.5 py-3">
          <a
            href={stay.href ?? placeUrl({ name: stay.name, query: stay.address ? `${stay.name} ${stay.address}` : stay.name })}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 group"
          >
            <span className="w-9 h-9 rounded-xl bg-surface text-[var(--t-accent)] flex items-center justify-center shrink-0"><BedDouble size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-bold text-[var(--t-accent)]">今晚住宿{stay.city ? ` · ${stay.city}` : ''}{nightNo ? ` · 第 ${nightNo} 晚` : ''}</span>
              <span className="block text-sm font-bold truncate group-hover:underline">{stay.name}</span>
            </span>
            <MapPin size={16} className="text-[var(--t-accent)] shrink-0" />
          </a>
          {stay.notes && stay.notes.length > 0 && <div className="mt-2 pl-12"><NoteList notes={stay.notes} /></div>}
        </section>
      )}
    </article>
  );
};

// ---------- prep ----------

const loadChecked = (key: string): string[] => {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** 行前準備清單。勾選狀態只存在這台裝置上，每個人各自打勾。 */
const Checklist: React.FC<{ storageKey: string; items: string[] }> = ({ storageKey, items }) => {
  const [checked, setChecked] = useState<string[]>(() => loadChecked(storageKey));
  const toggle = (item: string) => {
    setChecked(prev => {
      const next = prev.includes(item) ? prev.filter(x => x !== item) : [...prev, item];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* private mode: keep in memory */ }
      return next;
    });
  };
  const done = items.filter(i => checked.includes(i)).length;
  return (
    <section className="bg-surface border border-line rounded-2xl p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[15px] font-bold">行前準備</h3>
        <span className="num text-xs text-muted">{done} / {items.length}</span>
      </div>
      <div className="h-1.5 rounded-full bg-line overflow-hidden mt-2 mb-3">
        <div className="h-full bg-[var(--t-accent)] transition-all duration-300" style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
      </div>
      <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {items.map(item => {
          const on = checked.includes(item);
          return (
            <li key={item}>
              <button
                onClick={() => toggle(item)}
                aria-pressed={on}
                className={`w-full flex items-center gap-2 text-left rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  on ? 'bg-[var(--t-soft)] border-transparent text-muted line-through' : 'bg-surface border-line hover:bg-sunk'
                }`}
              >
                <span className={`shrink-0 w-[18px] h-[18px] rounded-md border flex items-center justify-center ${on ? 'bg-[var(--t-accent)] border-[var(--t-accent)] text-[var(--t-on)]' : 'border-ink-2/40'}`}>
                  {on && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="min-w-0">{item}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-[11.5px] text-muted mt-2.5">勾選紀錄只存在這支手機的瀏覽器裡，每個人各自打勾。</p>
    </section>
  );
};

const PrepView: React.FC<{ plan: ItineraryPlan }> = ({ plan }) => (
  <div className="space-y-4">
    {plan.flights && plan.flights.length > 0 && (
      <section>
        <h3 className="text-[15px] font-bold mb-2">航班</h3>
        <div className="grid sm:grid-cols-2 gap-2.5">
          {plan.flights.map(f => (
            <div key={`${f.label}-${f.date}`} className="bg-surface border border-line rounded-2xl px-4 py-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-[var(--t-accent)]">{f.label}{f.number ? ` · ${f.number}` : ''}</span>
                <span className="text-muted num">{dateParts(f.date).md}（{dateParts(f.date).weekday}）</span>
              </div>
              <div className="flex items-center gap-3 mt-1.5">
                <div><p className="text-[11px] text-muted">{f.from ?? '出發'}</p><p className="num text-xl font-extrabold">{f.depart ?? '—'}</p></div>
                <div className="flex-1 flex items-center gap-1 text-line" aria-hidden>
                  <span className="flex-1 border-t border-dashed border-current" /><Plane size={14} className="text-[var(--t-accent)]" /><span className="flex-1 border-t border-dashed border-current" />
                </div>
                <div className="text-right"><p className="text-[11px] text-muted">{f.to ?? '抵達'}</p><p className="num text-xl font-extrabold">{f.arrive ?? '—'}</p></div>
              </div>
              {f.notes && <div className="mt-2"><NoteList notes={f.notes} /></div>}
            </div>
          ))}
        </div>
      </section>
    )}

    {plan.stays && plan.stays.length > 0 && (
      <section>
        <h3 className="text-[15px] font-bold mb-2">住宿</h3>
        <ul className="bg-surface border border-line rounded-2xl divide-y divide-line overflow-hidden">
          {plan.stays.map(s => (
            <li key={s.id} className="px-4 py-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-bold text-[var(--t-accent)]">{s.city ?? '住宿'} · {nightsBetween(s.checkIn, s.checkOut)} 晚</span>
                <span className="text-muted num ml-auto">{dateParts(s.checkIn).md} – {dateParts(s.checkOut).md}</span>
              </div>
              <a href={s.href ?? placeUrl({ name: s.name, query: s.address ? `${s.name} ${s.address}` : s.name })} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-[15px] font-bold hover:underline">
                {s.name}<MapPin size={13} className="text-[var(--t-accent)]" />
              </a>
              {(s.nameEn || s.address) && <p className="text-xs text-muted">{[s.nameEn, s.address].filter(Boolean).join(' · ')}</p>}
              {s.notes && <div className="mt-1.5"><NoteList notes={s.notes} /></div>}
            </li>
          ))}
        </ul>
      </section>
    )}

    {plan.bookings && plan.bookings.length > 0 && (
      <section>
        <h3 className="text-[15px] font-bold mb-2">預訂狀況</h3>
        <ul className="bg-surface border border-line rounded-2xl divide-y divide-line overflow-hidden">
          {plan.bookings.map((b, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5">
              <div className="w-12 shrink-0 text-center leading-tight">
                <p className="num text-sm font-bold">{dateParts(b.date).md}</p>
                {b.time && <p className="num text-[10.5px] text-muted">{b.time}</p>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate"><RichText text={b.item} /></p>
                {b.category && <p className="text-[11px] text-muted">{b.category}</p>}
              </div>
              <StatusBadge status={b.status} />
            </li>
          ))}
        </ul>
      </section>
    )}

    {plan.checklist && plan.checklist.items.length > 0 && <Checklist storageKey={plan.checklist.storageKey} items={plan.checklist.items} />}

    {plan.notes && plan.notes.length > 0 && (
      <section className="rounded-2xl border border-dashed border-[var(--t-accent)]/50 bg-[var(--t-soft)]/50 p-4">
        <h3 className="text-[15px] font-bold mb-1.5">其他備註</h3>
        <NoteList notes={plan.notes} />
      </section>
    )}
  </div>
);

// ---------- page ----------

/**
 * 行程頁。版面固定，內容與風格來自 plan：
 * 手機上是「一覽／每日／行前」三個分頁（依資料自動增減），電腦上一覽固定在左邊。
 */
const ItineraryView: React.FC<{ plan: ItineraryPlan }> = ({ plan }) => {
  const theme = THEMES[plan.theme];
  useStylesheet(TITLE_FONT_HREF[theme.titleFont]);

  const views = useMemo(() => availableViews(plan), [plan]);
  const [now, setNow] = useState(() => nowIn(plan.timeZone));
  // 旅途中把頁面開著，「下一站」要跟著時間往下走
  useEffect(() => {
    const t = setInterval(() => setNow(nowIn(plan.timeZone)), 60_000);
    return () => clearInterval(t);
  }, [plan.timeZone]);

  const today = todayIndex(plan, now.date);
  const [active, setActive] = useState(() => (today >= 0 ? today : 0));
  const [view, setView] = useState<View>(() => (today >= 0 || !views.includes('overview') ? 'daily' : 'overview'));
  const [mapOpen, setMapOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [accentHex, setAccentHex] = useState('#3a5ba0');

  // Leaflet 畫線需要實際色碼，CSS 變數在 SVG 屬性裡不會被解析
  useLayoutEffect(() => {
    if (!mapOpen || !rootRef.current) return;
    const v = getComputedStyle(rootRef.current).getPropertyValue('--t-accent').trim();
    if (v) setAccentHex(v);
  }, [mapOpen]);

  const stays = useMemo(() => new Map((plan.stays ?? []).map(s => [s.id, s])), [plan.stays]);
  const routes = useMemo(() => plan.days.map(d => d.route ?? []), [plan.days]);
  const hasMap = routes.some(r => r.length > 0);
  const day = plan.days[active];
  const states = active === today ? itemStates(day.items, now.minutes) : day.items.map(() => null);
  const stay = day?.stay ? stays.get(day.stay) : undefined;
  const nightNo = stay ? nightsBetween(stay.checkIn, day.date) + 1 : undefined;

  const pickDay = (i: number) => {
    setActive(i);
    setView('daily');
  };

  if (!day) return <p className="text-center text-sm text-muted py-16">這份行程還沒有任何一天。</p>;

  const showTabs = views.length > 1;
  // 電腦上一覽固定在左側，分頁只剩「行程」與「行前」
  const wideViews = views.filter(v => v !== 'overview');

  const mapBlock = hasMap && (
    <section>
      <button
        onClick={() => setMapOpen(v => !v)}
        aria-expanded={mapOpen}
        className="w-full flex items-center gap-2 rounded-xl bg-surface border border-line px-3.5 py-2.5 text-[13px] text-ink-2 hover:bg-sunk transition-colors"
      >
        <MapIcon size={16} className="text-[var(--t-accent)]" />
        <b className="text-ink">全趟路線地圖</b>
        <ChevronDown size={16} className={`ml-auto text-muted transition-transform ${mapOpen ? 'rotate-180' : ''}`} />
      </button>
      {mapOpen && <div className="mt-2"><RouteMap routes={routes} activeIndex={view === 'daily' ? active : -1} color={accentHex} /></div>}
    </section>
  );

  const overview = (
    <div className="space-y-3">
      {plan.overviewExtra}
      {mapBlock}
      <OverviewList plan={plan} stays={stays} today={today} active={active} highlightActive={view === 'daily'} onPick={pickDay} />
    </div>
  );

  const daily = (
    <div className="space-y-4">
      {plan.days.length > 1 && <DayChips plan={plan} active={active} today={today} onPick={setActive} />}
      <DayDetail day={day} index={active} isToday={active === today} states={states} stay={stay} nightNo={nightNo} />
    </div>
  );

  const tabButton = (v: View, label: string, extraCls = '') => (
    <button
      key={v}
      role="tab"
      aria-selected={view === v || (v === 'daily' && view === 'overview' && extraCls === 'wide')}
      onClick={() => setView(v)}
      className={`flex-1 py-2 rounded-lg text-[13px] transition-colors ${
        view === v || (v === 'daily' && view === 'overview' && extraCls === 'wide') ? 'bg-surface text-ink font-bold shadow-sm' : 'text-ink-2 hover:text-ink'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={`it-theme-${plan.theme} space-y-4`}
      style={{ ['--t-title-font' as string]: TITLE_FONT_FAMILY[theme.titleFont] }}
    >
      <Cover plan={plan} compact={view === 'daily' && plan.days.length > 1} />

      {showTabs && (
        <>
          <div className="lg:hidden flex gap-1 p-1 rounded-xl bg-sunk border border-line" role="tablist" aria-label="行程分頁">
            {views.map(v => tabButton(v, VIEW_LABEL[v]))}
          </div>
          {wideViews.length > 1 && (
            <div className="hidden lg:flex gap-1 p-1 rounded-xl bg-sunk border border-line max-w-xs" role="tablist" aria-label="行程分頁">
              {wideViews.map(v => tabButton(v, v === 'daily' ? '行程' : VIEW_LABEL[v], 'wide'))}
            </div>
          )}
        </>
      )}

      {view === 'prep' ? (
        <PrepView plan={plan} />
      ) : views.includes('overview') ? (
        <div className="lg:grid lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:gap-6 lg:items-start">
          <div className={`${view === 'overview' ? '' : 'hidden'} lg:block lg:sticky lg:top-6`}>{overview}</div>
          <div className={`${view === 'daily' ? '' : 'hidden'} lg:block`}>{daily}</div>
        </div>
      ) : (
        <div className="space-y-3 max-w-3xl">
          {plan.overviewExtra}
          {mapBlock}
          {daily}
        </div>
      )}
    </div>
  );
};

export default ItineraryView;
