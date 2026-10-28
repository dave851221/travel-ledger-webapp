import React, { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Star, ArrowRight, Pencil, Trash2 } from 'lucide-react';
import type { Expense, Trip } from '../types';
import { photoUrl } from '../utils/storage';
import { formatMoney } from '../utils/money';
import { CategoryTile } from '../features/dashboard/ExpenseRow';
import MemberAvatar from '../features/dashboard/MemberAvatar';
import { ui } from './ui';
import { useSheetDrag } from './useSheetDrag';
import Decimal from 'decimal.js';

interface Props {
  expense: Expense;
  trip: Trip;
  currentUser?: string | null;
  onClose: () => void;
  /** Omit on read-only trips; the action row is hidden when both are missing */
  onEdit?: (exp: Expense) => void;
  onDelete?: (exp: Expense) => void;
}

/** 支出明細。手機上點一筆支出就開這個面板，編輯與刪除放在底部，往下拉可以收起。 */
const ExpenseDetailModal: React.FC<Props> = ({ expense, trip, currentUser = null, onClose, onEdit, onDelete }) => {
  const [photoIdx, setPhotoIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // 明細只能看不能改，從內容區捲到頂端再往下拉也可以收起
  const { sheetRef, handleRef, scrollRef } = useSheetDrag(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightboxOpen) setLightboxOpen(false); else onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = 'unset';
    };
  }, [lightboxOpen, onClose]);

  const prec = trip.precision_config ?? {};
  const money = (v: number) => formatMoney(v, expense.currency, prec);
  const photos = (expense.photo_urls ?? []).map(url => photoUrl(url));

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

  const hasActions = !!(onEdit || onDelete);

  return (
    <>
      {lightboxOpen && photos.length > 0 && (
        <div className="fixed inset-0 z-[80] bg-black/95 flex items-center justify-center p-4 anim-fade" onClick={() => setLightboxOpen(false)}>
          <button aria-label="關閉照片" className="absolute top-[max(16px,env(safe-area-inset-top))] right-4 text-white bg-white/10 p-2 rounded-full z-10">
            <X size={22} />
          </button>
          {photos.length > 1 && (
            <>
              <button
                aria-label="上一張"
                className="absolute left-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white p-3 z-10"
                onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i > 0 ? i - 1 : photos.length - 1)); }}
              >
                <ChevronLeft size={40} />
              </button>
              <button
                aria-label="下一張"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white p-3 z-10"
                onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i < photos.length - 1 ? i + 1 : 0)); }}
              >
                <ChevronRight size={40} />
              </button>
            </>
          )}
          <img key={photoIdx} src={photos[photoIdx]} className="max-w-full max-h-[88vh] object-contain rounded-xl" alt={`收據 ${photoIdx + 1}`} onClick={e => e.stopPropagation()} />
          {photos.length > 1 && (
            <div className="absolute bottom-[max(20px,env(safe-area-inset-bottom))] flex gap-1.5">
              {photos.map((_, i) => <span key={i} className={`w-1.5 h-1.5 rounded-full ${i === photoIdx ? 'bg-white' : 'bg-white/40'}`} />)}
            </div>
          )}
        </div>
      )}

      <div className="fixed inset-0 z-[70] bg-scrim flex items-end sm:items-center justify-center sm:p-4 anim-fade" onClick={onClose}>
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label={expense.description}
          className="bg-surface text-ink w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[92dvh] flex flex-col anim-sheet"
          onClick={e => e.stopPropagation()}
        >
          <div ref={handleRef} className="shrink-0">
          <div className="sm:hidden pt-2.5 flex justify-center" aria-hidden><span className="w-9 h-1 rounded-full bg-line" /></div>
          <div className="flex items-start gap-3 px-5 pt-3 sm:pt-5 pb-4">
            <CategoryTile category={expense.category} categories={trip.categories} size={40} />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold leading-snug text-balance">{expense.description}</h2>
              <p className="text-xs text-muted mt-0.5">{expense.is_settlement ? '結清紀錄' : expense.category} · {formattedDate}</p>
            </div>
            <button onClick={onClose} aria-label="關閉" className="p-1.5 -mr-1.5 rounded-lg text-muted hover:text-ink hover:bg-sunk shrink-0">
              <X size={20} />
            </button>
          </div>
          </div>

          <div ref={scrollRef} className="overflow-y-auto overscroll-contain flex-1 px-5 pb-5 space-y-5">
            <div className="rounded-xl bg-sunk border border-line px-4 py-3 flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted">{expense.is_settlement ? '結清金額' : '總金額'}</span>
              <span className={`num text-2xl font-extrabold ${expense.is_settlement ? 'text-pos' : 'text-ink'}`}>{money(expense.amount)}</span>
            </div>

            {expense.is_settlement ? (
              <div className="flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0 flex flex-wrap gap-2">
                  {payerEntries.map(([name]) => (
                    <span key={name} className="inline-flex items-center gap-1.5 font-medium"><MemberAvatar name={name} size={28} isMe={name === currentUser} />{name}</span>
                  ))}
                </div>
                <ArrowRight size={18} className="text-pos shrink-0" />
                <div className="flex-1 min-w-0 flex flex-wrap gap-2 justify-end">
                  {splitEntries.map(([name]) => (
                    <span key={name} className="inline-flex items-center gap-1.5 font-medium"><MemberAvatar name={name} size={28} isMe={name === currentUser} />{name}</span>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {payerEntries.length > 0 && (
                  <section>
                    <h3 className="text-xs text-muted mb-1.5">付款人</h3>
                    <ul className="divide-y divide-line border-y border-line">
                      {payerEntries.map(([name, amt]) => (
                        <li key={name} className="flex items-center gap-2.5 py-2">
                          <MemberAvatar name={name} size={26} isMe={name === currentUser} />
                          <span className="flex-1 text-sm">{name}</span>
                          <span className="num text-sm font-bold">{money(amt)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {splitEntries.length > 0 && (
                  <section>
                    <h3 className="text-xs text-muted mb-1.5">分攤</h3>
                    <ul className="divide-y divide-line border-y border-line">
                      {splitEntries.map(([name, amt]) => {
                        const pct = totalDecimal.gt(0)
                          ? new Decimal(amt).div(totalDecimal).times(100).toDecimalPlaces(1).toNumber()
                          : 0;
                        const isAdjust = name === expense.adjustment_member;
                        return (
                          <li key={name} className="py-2">
                            <div className="flex items-center gap-2.5">
                              <MemberAvatar name={name} size={26} isMe={name === currentUser} />
                              <span className="flex-1 text-sm flex items-center gap-1.5 min-w-0">
                                <span className="truncate">{name}</span>
                                {isAdjust && <Star size={11} className="text-accent fill-accent shrink-0" aria-label="尾差由此人吸收" />}
                              </span>
                              <span className="num text-[11px] text-muted w-11 text-right">{pct}%</span>
                              <span className="num text-sm font-bold min-w-[76px] text-right">{money(amt)}</span>
                            </div>
                            <div className="h-1 bg-line rounded-full overflow-hidden ml-9 mt-1.5">
                              <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </>
            )}

            {photos.length > 0 && (
              <section>
                <h3 className="text-xs text-muted mb-1.5">收據照片</h3>
                <div className={`grid gap-2 ${photos.length === 1 ? 'grid-cols-1' : photos.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                  {photos.map((url, i) => (
                    <button
                      key={i}
                      aria-label={`放大收據 ${i + 1}`}
                      className="relative aspect-square rounded-xl overflow-hidden bg-sunk border border-line"
                      onClick={() => { setPhotoIdx(i); setLightboxOpen(true); }}
                    >
                      <img src={url} className="w-full h-full object-cover" alt="" />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {formattedCreatedAt && <p className="text-center text-[11px] text-muted">建立於 {formattedCreatedAt}</p>}
          </div>

          {hasActions && (
            <div className="shrink-0 grid grid-cols-2 gap-2.5 px-5 pt-3 border-t border-line pb-[max(16px,env(safe-area-inset-bottom))]">
              {onEdit ? (
                <button onClick={() => onEdit(expense)} className={`${ui.btnPrimary} py-3`}><Pencil size={16} />編輯</button>
              ) : <span />}
              {onDelete && (
                <button onClick={() => onDelete(expense)} className={`${ui.btnDanger} py-3`}><Trash2 size={16} />刪除</button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default ExpenseDetailModal;
