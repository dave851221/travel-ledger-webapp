import React, { useState } from 'react';
import { X, Receipt, HandCoins, ChevronLeft, ChevronRight, Star } from 'lucide-react';
import type { Expense, Trip } from '../types';
import { formatAmount } from '../utils/finance';
import { getCategoryColor } from '../utils/category';
import Decimal from 'decimal.js';

interface Props {
  expense: Expense;
  trip: Trip;
  onClose: () => void;
}

const fmt = (val: number, cur: string, prec: Record<string, number>) =>
  `${cur} ${formatAmount(val, cur, prec)}`;

const MemberAvatar: React.FC<{ name: string; size?: 'sm' | 'md' }> = ({ name, size = 'md' }) => {
  const colors = [
    'bg-blue-100 text-blue-700', 'bg-emerald-100 text-emerald-700',
    'bg-purple-100 text-purple-700', 'bg-amber-100 text-amber-700',
    'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-700',
  ];
  const idx = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
  const sizeClass = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-xs';
  return (
    <div className={`${sizeClass} rounded-full ${colors[idx]} font-black flex items-center justify-center shrink-0`}>
      {name.slice(0, 1)}
    </div>
  );
};

const ExpenseDetailModal: React.FC<Props> = ({ expense, trip, onClose }) => {
  const [photoIdx, setPhotoIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const prec = trip.precision_config ?? {};
  const photos = (expense.photo_urls ?? []).map(
    url => `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/travel-images/${url}`
  );

  const totalDecimal = new Decimal(expense.amount);
  const payerEntries = Object.entries(expense.payer_data).filter(([, v]) => v !== 0);
  const splitEntries = Object.entries(expense.split_data).filter(([, v]) => v !== 0);

  const formattedDate = (() => {
    try {
      return new Date(expense.date + 'T00:00:00').toLocaleDateString('zh-TW', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
      });
    } catch {
      return expense.date;
    }
  })();

  const formattedCreatedAt = (() => {
    if (!expense.created_at) return '';
    try {
      return new Date(expense.created_at).toLocaleString('zh-TW', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return '';
    }
  })();

  const openLightbox = (idx: number) => {
    setPhotoIdx(idx);
    setLightboxOpen(true);
  };

  return (
    <>
      {/* Lightbox */}
      {lightboxOpen && photos.length > 0 && (
        <div
          className="fixed inset-0 z-[80] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <button className="absolute top-5 right-5 text-white bg-white/10 p-2 rounded-full z-10">
            <X size={22} />
          </button>
          {photos.length > 1 && (
            <>
              <button
                className="absolute left-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-white p-3 z-10"
                onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i > 0 ? i - 1 : photos.length - 1)); }}
              >
                <ChevronLeft size={44} />
              </button>
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-white p-3 z-10"
                onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i < photos.length - 1 ? i + 1 : 0)); }}
              >
                <ChevronRight size={44} />
              </button>
            </>
          )}
          <img
            key={photoIdx}
            src={photos[photoIdx]}
            className="max-w-full max-h-[88vh] object-contain rounded-xl shadow-2xl"
            alt="receipt"
            onClick={e => e.stopPropagation()}
          />
          {photos.length > 1 && (
            <div className="absolute bottom-5 flex gap-1.5">
              {photos.map((_, i) => (
                <div
                  key={i}
                  className={`w-1.5 h-1.5 rounded-full transition-all ${i === photoIdx ? 'bg-white scale-125' : 'bg-white/40'}`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modal backdrop */}
      <div
        className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center"
        onClick={onClose}
      >
        <div
          className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-1 text-[10px] font-black rounded uppercase tracking-wider ${getCategoryColor(expense.category, trip.categories)}`}>
                {expense.category}
              </span>
              {expense.is_settlement && (
                <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1 rounded">
                  SETTLEMENT
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all shrink-0"
            >
              <X size={20} />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 px-5 pb-6 space-y-5">

            {/* Title + date */}
            <div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white leading-tight">
                {expense.description}
              </h2>
              <p className="text-xs text-slate-400 font-bold mt-1">{formattedDate}</p>
            </div>

            {/* Amount highlight */}
            <div className={`rounded-2xl px-5 py-4 flex items-center justify-between ${expense.is_settlement ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-blue-50 dark:bg-blue-900/20'}`}>
              <span className="text-xs font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest">
                {expense.is_settlement ? '結清金額' : '總金額'}
              </span>
              <span className={`text-2xl font-black ${expense.is_settlement ? 'text-emerald-600' : 'text-blue-600'}`}>
                {fmt(expense.amount, expense.currency, prec)}
              </span>
            </div>

            {/* Settlement: arrow display */}
            {expense.is_settlement ? (
              <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-5 flex items-center gap-4">
                <div className="flex items-center gap-2 flex-wrap flex-1">
                  {payerEntries.map(([name]) => (
                    <div key={name} className="flex items-center gap-1.5">
                      <MemberAvatar name={name} />
                      <span className="text-sm font-black text-slate-700 dark:text-slate-300">{name}</span>
                    </div>
                  ))}
                </div>
                <div className="shrink-0 flex flex-col items-center gap-1 text-emerald-500">
                  <HandCoins size={20} />
                  <ChevronRight size={14} />
                </div>
                <div className="flex items-center gap-2 flex-wrap flex-1 justify-end">
                  {splitEntries.map(([name]) => (
                    <div key={name} className="flex items-center gap-1.5">
                      <MemberAvatar name={name} />
                      <span className="text-sm font-black text-slate-700 dark:text-slate-300">{name}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* Payer section */}
                {payerEntries.length > 0 && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">付款人</p>
                    <div className="space-y-2">
                      {payerEntries.map(([name, amt]) => (
                        <div key={name} className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl px-4 py-3">
                          <MemberAvatar name={name} />
                          <span className="flex-1 text-sm font-black text-slate-700 dark:text-slate-300">{name}</span>
                          <span className="text-sm font-black text-emerald-600">{fmt(amt, expense.currency, prec)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Split section */}
                {splitEntries.length > 0 && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">分攤明細</p>
                    <div className="space-y-2">
                      {splitEntries.map(([name, amt]) => {
                        const pct = totalDecimal.gt(0)
                          ? new Decimal(amt).div(totalDecimal).times(100).toDecimalPlaces(1).toNumber()
                          : 0;
                        const isAdjust = name === expense.adjustment_member;
                        return (
                          <div key={name} className="bg-slate-50 dark:bg-slate-800/50 rounded-xl px-4 py-3">
                            <div className="flex items-center gap-2 mb-1.5">
                              <MemberAvatar name={name} size="sm" />
                              <span className="flex-1 text-sm font-black text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                                {name}
                                {isAdjust && (
                                  <Star size={10} className="text-amber-400 fill-amber-400 shrink-0" />
                                )}
                              </span>
                              <span className="text-[11px] font-bold text-slate-400">{pct}%</span>
                              <span className="text-sm font-black text-blue-600 min-w-[80px] text-right">{fmt(amt, expense.currency, prec)}</span>
                            </div>
                            <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Photos */}
            {photos.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">收據照片</p>
                <div className={`grid gap-2 ${photos.length === 1 ? 'grid-cols-1' : photos.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                  {photos.map((url, i) => (
                    <div
                      key={i}
                      className="relative aspect-square rounded-xl overflow-hidden cursor-zoom-in bg-slate-100 dark:bg-slate-800"
                      onClick={() => openLightbox(i)}
                    >
                      <img
                        src={url}
                        className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                        alt={`receipt-${i + 1}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* No photo placeholder */}
            {photos.length === 0 && !expense.is_settlement && (
              <div className="flex flex-col items-center justify-center py-6 text-slate-300 dark:text-slate-600 gap-2">
                <Receipt size={32} />
                <span className="text-xs font-bold">無收據照片</span>
              </div>
            )}

            {/* Created at */}
            {formattedCreatedAt && (
              <p className="text-center text-[10px] text-slate-300 dark:text-slate-600 font-bold pt-1">
                建立於 {formattedCreatedAt}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default ExpenseDetailModal;
