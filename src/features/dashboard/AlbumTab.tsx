import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Images, LayoutGrid, Receipt, ShoppingBag, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import { albumCounts, albumDays, type AlbumPhoto, type PhotoKind } from '../../utils/album';
import { photoUrl } from '../../utils/storage';
import { formatMoney } from '../../utils/money';
import { dateParts } from '../itinerary/plan';

interface Props {
  trip: Trip;
  expenses: Expense[];
  onOpenExpense: (exp: Expense) => void;
}

const KINDS: { key: PhotoKind; label: string; icon: typeof Receipt }[] = [
  { key: 'item', label: '商品照片', icon: ShoppingBag },
  { key: 'receipt', label: '收據照片', icon: Receipt },
];

const EMPTY: Record<PhotoKind, { title: string; hint: string }> = {
  item: {
    title: '還沒有商品照片',
    hint: '編輯一筆支出加上照片，或在 LINE 傳一張美食、商品的照片給機器人，就會出現在這裡。',
  },
  receipt: {
    title: '還沒有收據照片',
    hint: '在 LINE 傳收據給機器人、確認存入後就會收在這裡。',
  },
};

type AlbumLayout = 'days' | 'grid';

const LAYOUTS: { key: AlbumLayout; label: string; icon: typeof Receipt }[] = [
  { key: 'days', label: '依日期分組', icon: CalendarDays },
  { key: 'grid', label: '緊密格子', icon: LayoutGrid },
];

const LAYOUT_KEY = 'album_layout';

// 這台裝置記得上次選的排法。localStorage 在無痕或被封鎖時會丟例外，讀不到就用預設
const readLayout = (): AlbumLayout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'days';
  } catch {
    return 'days';
  }
};

/**
 * 相簿：把這趟旅程支出上的照片依日期排好。預設看商品照片，收據另外一區。
 * 哪張是收據由 `expenses.receipt_photo_urls` 決定，在編輯支出的照片縮圖上可以切換。
 * 「緊密格子」拿掉日期分段與文字，一天只有一兩張時才不會空一大塊；日期在放大後看得到。
 */
const AlbumTab: React.FC<Props> = ({ trip, expenses, onOpenExpense }) => {
  const [kind, setKind] = useState<PhotoKind>('item');
  const [layout, setLayout] = useState<AlbumLayout>(readLayout);
  const [openAt, setOpenAt] = useState<number | null>(null);

  const chooseLayout = (next: AlbumLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Only this visit keeps the choice
    }
  };

  const days = useMemo(() => albumDays(expenses, kind), [expenses, kind]);
  const counts = useMemo(() => albumCounts(expenses), [expenses]);
  const flat = useMemo(() => days.flatMap(d => d.photos), [days]);
  // The lightbox indexes into the flat list, so each thumbnail needs its position in it.
  const offsets = useMemo(
    () => days.map((_, i) => days.slice(0, i).reduce<number>((n, d) => n + d.photos.length, 0)),
    [days],
  );

  // A refetch can shrink the list under an open lightbox (the photo was moved to the other kind or deleted)
  const current = openAt !== null && openAt < flat.length ? openAt : null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold">相簿</h2>
          <p className="text-xs text-muted mt-0.5">點照片放大，再點「明細」看是哪一筆</p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <div className="flex-1 sm:flex-none min-w-0 flex gap-1 p-1 rounded-xl bg-sunk border border-line" role="tablist" aria-label="照片種類">
            {KINDS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                role="tab"
                aria-selected={kind === key}
                onClick={() => { setKind(key); setOpenAt(null); }}
                className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-1 px-2 sm:px-3.5 py-2 rounded-lg text-[13px] whitespace-nowrap transition-colors ${
                  kind === key ? 'bg-surface text-ink font-bold shadow-sm' : 'text-ink-2 hover:text-ink'
                }`}
              >
                <Icon size={15} className="shrink-0" />{label}
                <span className="num text-[11px] text-muted font-medium">{counts[key]}</span>
              </button>
            ))}
          </div>
          <div className="shrink-0 flex gap-1 p-1 rounded-xl bg-sunk border border-line" role="group" aria-label="排列方式">
            {LAYOUTS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                aria-label={label}
                aria-pressed={layout === key}
                title={label}
                onClick={() => chooseLayout(key)}
                className={`inline-flex items-center justify-center w-9 rounded-lg transition-colors ${
                  layout === key ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
                }`}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {days.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl px-6 py-12 text-center">
          <Images size={28} className="mx-auto text-muted" />
          <p className="text-sm font-medium mt-3">{EMPTY[kind].title}</p>
          <p className="text-xs text-muted mt-1 max-w-xs mx-auto">{EMPTY[kind].hint}</p>
        </div>
      ) : layout === 'grid' ? (
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-0.5 rounded-lg overflow-hidden">
          {flat.map((p, i) => (
            <AlbumThumb key={p.path} photo={p} compact onOpen={() => setOpenAt(i)} />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {days.map((day, di) => {
            const { md, weekday } = dateParts(day.date);
            return (
              <section key={day.date}>
                <h3 className="text-[13px] font-bold text-ink-2 mb-2">
                  <span className="num">{md}</span>（{weekday}）
                  <span className="num text-muted font-medium ml-1.5">{day.photos.length} 張</span>
                </h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-1.5">
                  {day.photos.map((p, pi) => (
                    <AlbumThumb key={p.path} photo={p} onOpen={() => setOpenAt(offsets[di] + pi)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {current !== null && (
        <Lightbox
          trip={trip}
          photos={flat}
          index={current}
          onIndex={setOpenAt}
          onClose={() => setOpenAt(null)}
          onOpenExpense={exp => { setOpenAt(null); onOpenExpense(exp); }}
        />
      )}
    </div>
  );
};

/** 一張縮圖。緊密格子（compact）小到放不下文字，只留照片。 */
const AlbumThumb: React.FC<{ photo: AlbumPhoto; compact?: boolean; onOpen: () => void }> = ({ photo, compact, onOpen }) => (
  <button
    onClick={onOpen}
    className={`group relative aspect-square overflow-hidden bg-sunk ${compact ? '' : 'rounded-lg border border-line'}`}
    aria-label={`放大 ${photo.expense.description} 的照片`}
  >
    <img
      src={photoUrl(photo.path)}
      alt=""
      loading="lazy"
      decoding="async"
      className="w-full h-full object-cover transition-transform group-hover:scale-[1.03]"
    />
    {!compact && (
      <span className="absolute inset-x-0 bottom-0 px-1.5 pt-4 pb-1 text-left text-[11px] text-white truncate bg-gradient-to-t from-black/70 to-transparent">
        {photo.expense.description}
      </span>
    )}
  </button>
);

interface LightboxProps {
  trip: Trip;
  photos: AlbumPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onOpenExpense: (exp: Expense) => void;
}

/** 全螢幕看照片：左右滑或方向鍵換張、點照片放大、往下滑關閉。 */
const Lightbox: React.FC<LightboxProps> = ({ trip, photos, index, onIndex, onClose, onOpenExpense }) => {
  const [zoomed, setZoomed] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const photo = photos[index];
  const many = photos.length > 1;

  const go = useCallback((step: number) => {
    setZoomed(false);
    onIndex((index + step + photos.length) % photos.length);
  }, [index, photos.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && many) go(-1);
      else if (e.key === 'ArrowRight' && many) go(1);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [go, many, onClose]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (zoomed || e.touches.length !== 1) { touch.current = null; return; }
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && many) go(dx < 0 ? 1 : -1);
    else if (dy > 90 && dy > Math.abs(dx)) onClose();
  };

  const exp = photo.expense;
  const { md, weekday } = dateParts(exp.date);
  const navBtn = 'absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex items-center justify-center w-11 h-11 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white';

  // Portaled to <body> so no ancestor's stacking context can put page content above it
  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black flex flex-col anim-fade" role="dialog" aria-modal="true" aria-label="照片">
      <div className="flex items-center gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-2 text-white">
        <span className="num text-sm text-white/70 px-1">{index + 1} / {photos.length}</span>
        <div className="flex-1" />
        <button
          onClick={() => setZoomed(z => !z)}
          aria-label={zoomed ? '縮小' : '放大'}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          {zoomed ? <ZoomOut size={19} /> : <ZoomIn size={19} />}
        </button>
        <button onClick={onClose} aria-label="關閉" className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <X size={20} />
        </button>
      </div>

      <div
        className={`relative flex-1 min-h-0 ${zoomed ? 'overflow-auto' : 'overflow-hidden flex items-center justify-center px-3'}`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={e => { if (e.target === e.currentTarget && !zoomed) onClose(); }}
      >
        {many && !zoomed && (
          <>
            <button aria-label="上一張" onClick={() => go(-1)} className={`${navBtn} left-3`}><ChevronLeft size={26} /></button>
            <button aria-label="下一張" onClick={() => go(1)} className={`${navBtn} right-3`}><ChevronRight size={26} /></button>
          </>
        )}
        <img
          key={photo.path}
          src={photoUrl(photo.path)}
          alt={exp.description}
          onClick={() => setZoomed(z => !z)}
          className={zoomed
            ? 'max-w-none w-[200%] sm:w-auto cursor-zoom-out'
            : 'max-w-full max-h-full object-contain rounded-lg cursor-zoom-in select-none'}
        />
      </div>

      <div className="px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] text-white">
        <div className="mx-auto max-w-xl flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-bold line-clamp-2">{exp.description}</p>
            <p className="text-xs text-white/65 mt-0.5 truncate">
              <span className="num">{md}</span>（{weekday}）· {exp.category} ·{' '}
              <span className="num">{formatMoney(exp.amount, exp.currency, trip.precision_config)}</span>
            </p>
          </div>
          <button
            onClick={() => onOpenExpense(exp)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-white text-black font-bold px-3.5 py-2 text-sm active:scale-[.98]"
          >
            明細
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AlbumTab;
