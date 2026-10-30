import React from 'react';
import { Camera, CloudOff, Pencil, Trash2 } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import { getCategoryVisual } from '../../utils/category';
import { formatMoney } from '../../utils/money';
import { payerLabel, splitLabel } from './labels';

export const CategoryTile: React.FC<{ category: string; categories?: string[]; size?: number }> = ({ category, categories, size = 34 }) => {
  const { color, icon: Icon } = getCategoryVisual(category, categories);
  return (
    <span
      className="inline-flex items-center justify-center rounded-[9px] shrink-0"
      style={{ width: size, height: size, color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}
      aria-hidden
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.9} />
    </span>
  );
};

interface Props {
  exp: Expense;
  trip: Trip;
  currentUser: string | null;
  onOpen: (exp: Expense) => void;
  /** Omit on read-only trips */
  onEdit?: (exp: Expense) => void;
  onDelete?: (exp: Expense) => void;
}

/**
 * 一筆支出。手機上是「圖示｜描述＋誰付｜金額＋我的份額」三欄；
 * lg 以上展開成表格欄位，編輯與刪除在滑鼠移過去時出現（觸控裝置一律顯示）。
 * 手機上點整列開明細，編輯與刪除放在明細底部。
 */
const ExpenseRow: React.FC<Props> = ({ exp, trip, currentUser, onOpen, onEdit, onDelete }) => {
  const prec = trip.precision_config;
  const mine = currentUser !== null && exp.split_data[currentUser] !== undefined && !exp.is_settlement
    ? Number(exp.split_data[currentUser]) || 0
    : null;
  const hasPhotos = (exp.photo_urls?.length ?? 0) > 0;
  const payer = payerLabel(exp);
  const split = splitLabel(exp, trip.members);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(exp)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(exp); } }}
      className="group relative grid items-center gap-x-3 px-3 py-2.5 lg:px-4 cursor-pointer transition-colors hover:bg-sunk focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent
        grid-cols-[34px_minmax(0,1fr)_auto] lg:grid-cols-[30px_minmax(0,1fr)_88px_92px_112px_100px]"
    >
      <span className="lg:hidden"><CategoryTile category={exp.category} categories={trip.categories} /></span>
      <span className="hidden lg:inline-flex"><CategoryTile category={exp.category} categories={trip.categories} size={30} /></span>

      <div className="min-w-0">
        <p className="text-sm font-medium text-ink truncate flex items-center gap-1.5">
          <span className="truncate">{exp.description}</span>
          {hasPhotos && <Camera size={13} className="shrink-0 text-muted" aria-label="有照片" />}
          {exp.pending_sync && (
            <span className="shrink-0 inline-flex items-center gap-0.5 text-[10.5px] font-medium text-warn" title="離線時記的，恢復連線後會自動上傳">
              <CloudOff size={12} />待上傳
            </span>
          )}
        </p>
        <p className="text-[11.5px] text-muted truncate lg:hidden">{payer} 付 · {split}</p>
        <p className="text-[11.5px] text-muted truncate hidden lg:block">{exp.category}</p>
      </div>

      <span className="hidden lg:block text-[13px] text-ink-2 truncate">{payer}</span>
      <span className="hidden lg:block text-[13px] text-muted truncate">{split}</span>

      <div className="text-right whitespace-nowrap lg:contents">
        <span className="num block lg:text-right text-[14.5px] lg:text-sm font-bold text-ink">{formatMoney(exp.amount, exp.currency, prec)}</span>
        <span className="num block lg:text-right text-[11px] lg:text-[13px] font-medium text-muted lg:transition-opacity lg:group-hover:opacity-0 [@media(hover:none)]:lg:opacity-0">
          {mine !== null ? <><span className="lg:hidden">我 </span>{formatMoney(mine, exp.currency, prec)}</> : <span className="hidden lg:inline">—</span>}
        </span>
      </div>

      {(onEdit || onDelete) && (
        <div className="hidden lg:flex absolute right-3 top-1/2 -translate-y-1/2 gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(exp); }}
              aria-label={`編輯 ${exp.description}`}
              className="w-8 h-8 rounded-lg bg-surface border border-line text-ink-2 hover:text-ink flex items-center justify-center"
            >
              <Pencil size={14} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(exp); }}
              aria-label={`刪除 ${exp.description}`}
              className="w-8 h-8 rounded-lg bg-surface border border-line text-ink-2 hover:text-neg flex items-center justify-center"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ExpenseRow;
