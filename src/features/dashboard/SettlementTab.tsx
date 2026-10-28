import React from 'react';
import { ArrowRight, Check, HandCoins, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import type { TripStats } from '../../hooks/useTripStats';
import { ui } from '../../components/ui';
import { calculateSettlements } from '../../utils/settlement';
import { formatMoney } from '../../utils/money';
import MemberAvatar from './MemberAvatar';

export interface SettleRequest {
  from: string;
  to: string;
  amount: number;
  cur: string;
}

interface Props {
  trip: Trip;
  expenses: Expense[];
  stats: TripStats;
  currentUser: string | null;
  onRecord: (s: SettleRequest) => void;
  onManual: () => void;
  onEdit: (exp: Expense) => void;
  onDelete: (exp: Expense) => void;
}

const names = (data: Record<string, number>) => Object.entries(data).filter(([, v]) => v !== 0).map(([n]) => n).join('、');

const SettlementTab: React.FC<Props> = ({ trip, expenses, stats, currentUser, onRecord, onManual, onEdit, onDelete }) => {
  const readOnly = trip.is_archived;
  const prec = trip.precision_config;
  const grand = calculateSettlements(stats.balances.GRAND_TOTAL ?? {});
  const currencyKeys = Object.keys(stats.balances).filter(k => k !== 'GRAND_TOTAL');

  // 只用一種幣別時，總結算就等於該幣別的結算，不重複列出。
  // 總結算已經結清時，各幣別的差額在折算後互相抵銷（例如欠 5000 JPY 但被欠等值 TWD），也不用處理。
  const perCurrency = currencyKeys.length > 1 && grand.length > 0
    ? currencyKeys.map(cur => ({ cur, list: calculateSettlements(stats.balances[cur]) })).filter(x => x.list.length > 0)
    : [];

  const history = expenses
    .filter(e => e.is_settlement)
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));

  const renderList = (list: { from: string; to: string; amount: number }[], cur: string) => (
    <ul className="divide-y divide-line">
      {list.map(s => (
        <li key={`${s.from}-${s.to}`} className="flex items-center gap-3 py-3">
          <div className="flex -space-x-2 shrink-0" aria-hidden>
            <MemberAvatar name={s.from} size={30} isMe={s.from === currentUser} ring />
            <MemberAvatar name={s.to} size={30} isMe={s.to === currentUser} ring />
          </div>
          <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-4">
            <p className="text-sm font-medium flex items-center gap-1.5 min-w-0 sm:flex-1">
              <span className="truncate">{s.from}</span>
              <ArrowRight size={14} className="text-muted shrink-0" />
              <span className="truncate">{s.to}</span>
            </p>
            <p className="num text-base sm:text-lg font-extrabold">{formatMoney(s.amount, cur, prec)}</p>
          </div>
          {!readOnly && (
            <button onClick={() => onRecord({ ...s, cur })} className={`${ui.btnSecondary} px-3 py-1.5 text-xs shrink-0`}>
              <HandCoins size={14} />記錄
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">結清</h2>
        {!readOnly && (
          <button onClick={onManual} className={`${ui.btnSecondary} py-2`}>
            <Plus size={15} strokeWidth={2.4} />手動新增結清
          </button>
        )}
      </div>

      <section className="bg-surface border border-line rounded-2xl px-4 sm:px-5 pt-4 pb-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[15px] font-bold">建議轉帳</h3>
          <span className="text-xs text-muted">折合 {trip.base_currency} · 最少轉帳次數</span>
        </div>
        {grand.length === 0 ? (
          <div className="py-8 text-center">
            <span className="inline-flex w-11 h-11 rounded-2xl bg-pos/10 text-pos items-center justify-center mb-2"><Check size={22} /></span>
            <p className="text-sm font-medium">目前大家的帳都結清了</p>
          </div>
        ) : (
          <>
            {renderList(grand, trip.base_currency)}
            {!readOnly && <p className="text-xs text-muted pb-3">實際轉完帳後按「記錄」，系統會新增一筆結清紀錄，餘額跟著歸零。</p>}
          </>
        )}
      </section>

      {perCurrency.length > 0 && (
        <section className="bg-surface border border-line rounded-2xl px-4 sm:px-5 pt-4 pb-1">
          <h3 className="text-[15px] font-bold">想用原幣別結清的話</h3>
          <p className="text-xs text-muted mt-0.5">每種幣別各自算，不做換算。</p>
          {perCurrency.map(({ cur, list }) => (
            <div key={cur} className="mt-3">
              <p className="num text-xs font-bold text-ink-2">{cur}</p>
              {renderList(list, cur)}
            </div>
          ))}
        </section>
      )}

      {history.length > 0 && (
        <section className="bg-surface border border-line rounded-2xl px-4 sm:px-5 py-4">
          <h3 className="text-[15px] font-bold mb-1">結清紀錄</h3>
          <ul className="divide-y divide-line">
            {history.map(sr => (
              <li key={sr.id} className="flex items-center gap-3 py-2.5">
                <span className="w-8 h-8 rounded-lg bg-pos/10 text-pos flex items-center justify-center shrink-0"><HandCoins size={16} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{names(sr.payer_data)} → {names(sr.split_data)}</p>
                  <p className="num text-[11.5px] text-muted">{sr.date.replace(/-/g, '/')}</p>
                </div>
                <span className="num text-sm font-bold text-pos shrink-0">{formatMoney(sr.amount, sr.currency, prec)}</span>
                {!readOnly && (
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => onEdit(sr)} aria-label="編輯這筆結清" className={ui.iconBtn}><Pencil size={15} /></button>
                    <button onClick={() => onDelete(sr)} aria-label="刪除這筆結清" className={`${ui.iconBtn} hover:text-neg`}><Trash2 size={15} /></button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export default SettlementTab;
