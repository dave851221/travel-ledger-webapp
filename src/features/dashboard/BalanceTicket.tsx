import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { Trip } from '../../types';
import type { TripStats } from '../../hooks/useTripStats';
import { formatMoney, formatNumber } from '../../utils/money';

interface Props {
  trip: Trip;
  stats: TripStats;
  currentUser: string | null;
  onSettle?: () => void;
  onPickUser?: () => void;
  /** Background behind the card, so the two notches look punched through */
  notchBg?: string;
}

/**
 * 「我的淨額」票根。淨額取自 balances（含結清紀錄），
 * 已付／份額取自 grandBase（不含結清），和統計頁的定義一致。
 */
const BalanceTicket: React.FC<Props> = ({ trip, stats, currentUser, onSettle, onPickUser, notchBg = 'var(--app-bg)' }) => {
  const base = trip.base_currency;
  const prec = trip.precision_config;
  const net = currentUser ? stats.balances.GRAND_TOTAL?.[currentUser] ?? 0 : 0;
  const netText = formatMoney(net, base, prec, { signed: true });
  const settled = !/[1-9]/.test(formatNumber(net, base, prec));
  const subtitle = !currentUser
    ? '選擇身分後，這裡會顯示你的帳'
    : settled
      ? '你的帳已經結清'
      : net > 0 ? '其他人還要給你' : '你還要付給其他人';

  return (
    <section className="bg-navy text-navy-fg rounded-2xl" aria-label="我的帳">
      <div className="px-[18px] pt-4 pb-3.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-navy-sub">{currentUser ? '我的淨額' : '全團支出'}</p>
          <p className="num text-[30px] leading-tight font-extrabold tracking-tight text-accent truncate">
            {currentUser ? netText : formatMoney(stats.grandBase.total, base, prec)}
          </p>
          <p className="text-xs text-navy-sub">{subtitle}</p>
        </div>
        {currentUser && !settled && onSettle && (
          <button
            onClick={onSettle}
            className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-accent text-on-accent text-xs font-bold pl-3 pr-2 py-1.5 hover:brightness-105 transition"
          >
            去結清<ChevronRight size={14} strokeWidth={2.4} />
          </button>
        )}
        {!currentUser && onPickUser && (
          <button
            onClick={onPickUser}
            className="shrink-0 rounded-full bg-accent text-on-accent text-xs font-bold px-3 py-1.5 hover:brightness-105 transition"
          >
            選擇身分
          </button>
        )}
      </div>
      <div className="perforation" style={{ ['--notch-bg' as string]: notchBg }} />
      <dl className="grid grid-cols-3 gap-2 px-[18px] pt-3 pb-3.5">
        {currentUser ? (
          <>
            <div className="min-w-0"><dt className="text-[11px] text-navy-sub">我已付</dt><dd className="num text-[15px] font-bold truncate">{formatNumber(stats.grandBase.paidByMe, base, prec)}</dd></div>
            <div className="min-w-0"><dt className="text-[11px] text-navy-sub">我的份額</dt><dd className="num text-[15px] font-bold truncate">{formatNumber(stats.grandBase.owedByMe, base, prec)}</dd></div>
            <div className="min-w-0"><dt className="text-[11px] text-navy-sub">全團支出</dt><dd className="num text-[15px] font-bold truncate">{formatNumber(stats.grandBase.total, base, prec)}</dd></div>
          </>
        ) : (
          <>
            <div className="min-w-0"><dt className="text-[11px] text-navy-sub">成員</dt><dd className="num text-[15px] font-bold">{trip.members.length} 人</dd></div>
            <div className="min-w-0 col-span-2"><dt className="text-[11px] text-navy-sub">幣別</dt><dd className="num text-[15px] font-bold truncate">{Object.keys(trip.rates).join(' · ')}</dd></div>
          </>
        )}
      </dl>
    </section>
  );
};

export default BalanceTicket;
