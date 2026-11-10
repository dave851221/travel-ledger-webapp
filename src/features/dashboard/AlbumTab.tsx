import React, { useMemo, useState } from 'react';
import { CalendarDays, Images, LayoutGrid, Receipt, ShoppingBag, ZoomIn, ZoomOut } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import { albumCounts, albumDays, type AlbumPhoto, type PhotoKind } from '../../utils/album';
import { photoUrl } from '../../utils/storage';
import { formatMoney } from '../../utils/money';
import { dateParts } from '../itinerary/plan';
import { useGridZoom } from './useGridZoom';
import PhotoLightbox from '../../components/PhotoLightbox';

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
 * 格子的大小可以縮放（手機雙指、電腦觸控板或 Ctrl＋滾輪、＋／－ 按鈕），見 `useGridZoom`。
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
  const flatUrls = useMemo(() => flat.map(p => photoUrl(p.path)), [flat]);
  // The lightbox indexes into the flat list, so each thumbnail needs its position in it.
  const offsets = useMemo(
    () => days.map((_, i) => days.slice(0, i).reduce<number>((n, d) => n + d.photos.length, 0)),
    [days],
  );

  const showGrid = layout === 'grid' && flat.length > 0;
  const { gridRef, columns, stepColumns, canShrink, canGrow } = useGridZoom(showGrid);

  // A refetch can shrink the list under an open lightbox (the photo was moved to the other kind or deleted)
  const current = openAt !== null && openAt < flat.length ? openAt : null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold">相簿</h2>
          <p className="text-xs text-muted mt-0.5">
            {showGrid ? (
              <>
                <span className="sm:hidden">雙指開合可以調整照片大小</span>
                <span className="hidden sm:inline">觸控板雙指或 Ctrl＋滾輪可以調整照片大小</span>
              </>
            ) : '點照片放大，再點「明細」看是哪一筆'}
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          {showGrid && (
            <div className="hidden sm:flex shrink-0 gap-1 p-1 rounded-xl bg-sunk border border-line" role="group" aria-label="照片大小">
              <button
                aria-label="縮小照片"
                title="縮小照片"
                disabled={!canShrink}
                onClick={() => stepColumns(1)}
                className="inline-flex items-center justify-center w-9 rounded-lg text-ink-2 hover:text-ink disabled:opacity-40 transition-colors"
              >
                <ZoomOut size={16} />
              </button>
              <button
                aria-label="放大照片"
                title="放大照片"
                disabled={!canGrow}
                onClick={() => stepColumns(-1)}
                className="inline-flex items-center justify-center w-9 rounded-lg text-ink-2 hover:text-ink disabled:opacity-40 transition-colors"
              >
                <ZoomIn size={16} />
              </button>
            </div>
          )}
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
      ) : showGrid ? (
        <div className="overflow-x-clip">
          <div
            ref={gridRef}
            className="grid gap-0.5 rounded-lg overflow-hidden touch-pan-y"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {flat.map((p, i) => (
              <AlbumThumb key={p.path} photo={p} compact onOpen={() => setOpenAt(i)} />
            ))}
          </div>
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
        <PhotoLightbox
          photos={flatUrls}
          index={current}
          onIndex={setOpenAt}
          onClose={() => setOpenAt(null)}
          alt={flat[current].expense.description}
          footer={<LightboxCaption trip={trip} expense={flat[current].expense} onOpenExpense={exp => { setOpenAt(null); onOpenExpense(exp); }} />}
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

/** 放大照片時下方那一行：是哪一筆支出，以及前往明細的按鈕。 */
const LightboxCaption: React.FC<{ trip: Trip; expense: Expense; onOpenExpense: (exp: Expense) => void }> = ({ trip, expense: exp, onOpenExpense }) => {
  const { md, weekday } = dateParts(exp.date);
  return (
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
  );
};

export default AlbumTab;
