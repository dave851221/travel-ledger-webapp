import React from 'react';
import type { Trip } from '../../types';
import type { TripStats } from '../../hooks/useTripStats';
import { calculateSettlements } from '../../utils/settlement';
import { formatMoney } from '../../utils/money';
import MemberAvatar from './MemberAvatar';

interface BalancesProps {
  trip: Trip;
  stats: TripStats;
  currentUser: string | null;
}

/** 每位成員的淨額，用置中的長條表示應收（右、綠）與應付（左、紅）。 */
export const MemberBalances: React.FC<BalancesProps> = ({ trip, stats, currentUser }) => {
  const balances = stats.balances.GRAND_TOTAL ?? {};
  const max = Math.max(1, ...trip.members.map(m => Math.abs(balances[m] ?? 0)));
  return (
    <ul className="space-y-1">
      {trip.members.map(m => {
        const v = balances[m] ?? 0;
        const pct = (Math.abs(v) / max) * 50;
        const text = formatMoney(v, trip.base_currency, trip.precision_config, { signed: true });
        const zero = !/[1-9]/.test(text);
        return (
          <li key={m} className="grid grid-cols-[minmax(0,64px)_1fr_auto] items-center gap-2.5 py-1 text-[13px]">
            <span className={`truncate ${m === currentUser ? 'font-bold' : ''}`}>{m}</span>
            <span className="relative h-1.5 rounded-full bg-line" aria-hidden>
              <span className="absolute left-1/2 top-[-3px] bottom-[-3px] w-px bg-muted/50" />
              {!zero && (
                <span
                  className={`absolute top-0 bottom-0 rounded-full ${v > 0 ? 'bg-pos' : 'bg-neg'}`}
                  style={v > 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
                />
              )}
            </span>
            <span className={`num font-bold text-right ${zero ? 'text-muted' : v > 0 ? 'text-pos' : 'text-neg'}`}>{text}</span>
          </li>
        );
      })}
    </ul>
  );
};

interface PanelProps extends BalancesProps {
  ticket: React.ReactNode;
  onRecordSettlement?: (s: { from: string; to: string; amount: number; cur: string }) => void;
  onOpenSettlement: () => void;
}

/** 電腦寬螢幕的右側欄：票根、成員餘額、建議結清（可直接記錄）。 */
const SummaryPanel: React.FC<PanelProps> = ({ trip, stats, currentUser, ticket, onRecordSettlement, onOpenSettlement }) => {
  const settlements = calculateSettlements(stats.balances.GRAND_TOTAL ?? {});
  return (
    <aside className="hidden xl:flex flex-col gap-5 w-[320px] shrink-0 border-l border-line bg-sunk px-5 py-6 sticky top-0 h-dvh overflow-y-auto">
      {ticket}
      <section>
        <h2 className="text-[13px] text-muted mb-1.5">成員餘額 · 折合 {trip.base_currency}</h2>
        <MemberBalances trip={trip} stats={stats} currentUser={currentUser} />
      </section>
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-[13px] text-muted">建議結清</h2>
          <button onClick={onOpenSettlement} className="text-xs text-ink-2 hover:text-ink">查看全部</button>
        </div>
        {settlements.length === 0 ? (
          <p className="text-sm text-muted bg-surface border border-line rounded-xl px-3 py-3">目前大家的帳都結清了。</p>
        ) : (
          <ul className="space-y-1.5">
            {settlements.map(s => (
              <li key={`${s.from}-${s.to}`} className="flex items-center gap-2 bg-surface border border-line rounded-xl pl-2.5 pr-2 py-2 text-[13px]">
                <MemberAvatar name={s.from} size={22} isMe={s.from === currentUser} />
                <span className="min-w-0 flex-1 truncate">{s.from} → {s.to}</span>
                <span className="num font-bold">{formatMoney(s.amount, trip.base_currency, trip.precision_config)}</span>
                {onRecordSettlement && (
                  <button
                    onClick={() => onRecordSettlement({ ...s, cur: trip.base_currency })}
                    className="shrink-0 text-[11.5px] font-bold border border-ink-2 text-ink rounded-md px-2 py-0.5 hover:bg-sunk"
                  >
                    記錄
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
};

export default SummaryPanel;
