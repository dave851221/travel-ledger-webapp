import React from 'react';
import { Clock, RotateCcw, Trash2 } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import { ui } from '../../components/ui';
import { formatMoney } from '../../utils/money';
import { CategoryTile } from './ExpenseRow';

interface Props {
  trip: Trip;
  deleted: Expense[];
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onEmpty: () => void;
}

const TrashTab: React.FC<Props> = ({ trip, deleted, onRestore, onPermanentDelete, onEmpty }) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 className="text-xl font-bold">垃圾桶</h2>
        <p className="text-xs text-muted mt-0.5 flex items-center gap-1"><Clock size={12} />刪除後保留 24 小時，之後會自動清除</p>
      </div>
      {deleted.length > 0 && (
        <button onClick={onEmpty} className={`${ui.btnDanger} py-2`}><Trash2 size={15} />清空垃圾桶</button>
      )}
    </div>

    {deleted.length === 0 ? (
      <div className="bg-surface border border-line rounded-2xl px-6 py-12 text-center">
        <p className="text-sm font-medium">垃圾桶是空的</p>
        <p className="text-xs text-muted mt-1">刪除的支出會在這裡保留 24 小時。</p>
      </div>
    ) : (
      <ul className="bg-surface border border-line rounded-2xl divide-y divide-line overflow-hidden">
        {deleted.map(exp => (
          <li key={exp.id} className="flex items-center gap-3 px-3 sm:px-4 py-3">
            <span className="opacity-60"><CategoryTile category={exp.category} categories={trip.categories} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink-2 line-through truncate">{exp.description}</p>
              <p className="text-[11.5px] text-muted truncate">
                <span className="num">{formatMoney(exp.amount, exp.currency, trip.precision_config)}</span>
                {' · '}刪除於 {new Date(exp.deleted_at!).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            <button onClick={() => onRestore(exp.id)} className={`${ui.btnPrimary} px-3 py-1.5 text-xs shrink-0`}>
              <RotateCcw size={14} />還原
            </button>
            <button onClick={() => onPermanentDelete(exp.id)} aria-label={`永久刪除 ${exp.description}`} className={`${ui.iconBtn} hover:text-neg shrink-0`}>
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>
);

export default TrashTab;
