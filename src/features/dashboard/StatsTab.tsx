import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { Expense, Trip } from '../../types';
import type { TripStats } from '../../hooks/useTripStats';
import { getCategoryVisual } from '../../utils/category';
import { formatMoney } from '../../utils/money';
import { MemberBalances } from './SummaryPanel';

interface Props {
  trip: Trip;
  expenses: Expense[];
  stats: TripStats;
  currentUser: string | null;
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

const DetailLines: React.FC<{ rows: { id: string; date: string; description: string; amount: number; currency: string }[]; trip: Trip }> = ({ rows, trip }) => (
  <ul className="ml-7 mb-2 mt-0.5 space-y-0.5">
    {rows.length === 0 ? (
      <li className="text-xs text-muted px-2 py-1">沒有資料</li>
    ) : rows.map(r => (
      <li key={r.id} className="flex items-center gap-2 text-xs py-1 px-2.5 rounded-lg bg-sunk">
        <span className="num text-muted shrink-0">{r.date.slice(5).replace('-', '/')}</span>
        <span className="text-ink-2 truncate flex-1">{r.description}</span>
        <span className="num font-bold text-ink shrink-0">{formatMoney(r.amount, r.currency, trip.precision_config)}</span>
      </li>
    ))}
  </ul>
);

const StatsTab: React.FC<Props> = ({ trip, expenses, stats, currentUser }) => {
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const [openMemberCats, setOpenMemberCats] = useState<Set<string>>(new Set());
  const base = trip.base_currency;
  const prec = trip.precision_config;
  const total = stats.grandBase.total;
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  };
  const spending = expenses.filter(e => !e.is_settlement);

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold md:hidden">統計</h2>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <div className="bg-surface border border-line rounded-2xl px-4 py-3 col-span-2 lg:col-span-1">
          <p className="text-xs text-muted">全團支出 · 折合 {base}</p>
          <p className="num text-2xl font-extrabold mt-0.5">{formatMoney(total, base, prec)}</p>
        </div>
        {Object.entries(stats.byCurrency).map(([cur, data]) => (
          <div key={cur} className="bg-surface border border-line rounded-2xl px-4 py-3 min-w-0">
            <p className="text-xs text-muted">{cur} 原幣合計</p>
            <p className="num text-lg font-bold mt-0.5 truncate">{formatMoney(data.total, cur, prec)}</p>
            {currentUser && <p className="num text-[11.5px] text-muted truncate">我的份額 {formatMoney(data.owedByMe, cur, prec)}</p>}
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2 items-start">
        <section className="bg-surface border border-line rounded-2xl p-4 sm:p-5">
          <h3 className="text-[15px] font-bold">分類</h3>
          {stats.categoryData.length === 0 ? (
            <p className="text-sm text-muted py-10 text-center">還沒有支出資料</p>
          ) : (
            <>
              <div className="relative h-[220px] sm:h-[240px] my-2">
                {/* ResponsiveContainer 的 initialDimension 預設是 {-1, -1}，StrictMode 下會先用那組值
                    渲染一次，Recharts 會在 console 抱怨寬高小於 0。給一組合理初值即可。 */}
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 220 }}>
                  <PieChart>
                    <Pie data={stats.categoryData} cx="50%" cy="50%" innerRadius="62%" outerRadius="88%" paddingAngle={2} dataKey="value" stroke="none" isAnimationActive={false}>
                      {stats.categoryData.map(c => <Cell key={c.name} fill={getCategoryVisual(c.name, trip.categories).color} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={{ borderRadius: 12, border: '1px solid var(--app-line)', background: 'var(--app-surface)', color: 'var(--app-ink)', fontSize: 13 }}
                      itemStyle={{ color: 'var(--app-ink)' }}
                      formatter={(v: unknown, name: unknown) => [formatMoney(Number(v), base, prec), String(name)]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-xs text-muted">總計</span>
                  <span className="num text-lg font-extrabold">{formatMoney(total, base, prec)}</span>
                </div>
              </div>
              <ul className="divide-y divide-line">
                {stats.categoryData.map(cat => {
                  const open = openCats.has(cat.name);
                  const color = getCategoryVisual(cat.name, trip.categories).color;
                  const rows = spending.filter(e => e.category === cat.name).sort((a, b) => b.date.localeCompare(a.date));
                  return (
                    <li key={cat.name}>
                      <button onClick={() => setOpenCats(s => toggle(s, cat.name))} aria-expanded={open} className="w-full grid grid-cols-[12px_minmax(0,1fr)_auto_44px_14px] items-center gap-2.5 py-2.5 text-sm text-left">
                        <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: color }} />
                        <span className="truncate">{cat.name}</span>
                        <span className="num font-bold">{formatMoney(cat.value, base, prec)}</span>
                        <span className="num text-xs text-muted text-right">{pct(cat.value, total).toFixed(1)}%</span>
                        <ChevronRight size={14} className={`text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
                      </button>
                      {open && <DetailLines rows={rows} trip={trip} />}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <div className="space-y-5">
          <section className="bg-surface border border-line rounded-2xl p-4 sm:p-5">
            <h3 className="text-[15px] font-bold mb-2">成員餘額 <span className="text-xs font-normal text-muted">· 含結清紀錄</span></h3>
            <MemberBalances trip={trip} stats={stats} currentUser={currentUser} />
          </section>

          <section className="bg-surface border border-line rounded-2xl p-4 sm:p-5">
            <h3 className="text-[15px] font-bold">每個人花了多少 <span className="text-xs font-normal text-muted">· 折合 {base}</span></h3>
            <div className="divide-y divide-line">
              {Object.entries(stats.memberDetails).map(([name, data]) => (
                <div key={name} className="py-3">
                  <div className="flex items-baseline justify-between mb-1">
                    <span className={`text-sm ${name === currentUser ? 'font-bold' : 'font-medium'}`}>{name}</span>
                    <span className="num text-sm font-bold">{formatMoney(data.totalOwed, base, prec)}</span>
                  </div>
                  {Object.entries(data.categories)
                    .filter(([, val]) => val !== 0)
                    .sort(([, a], [, b]) => b - a)
                    .map(([cat, val]) => {
                      const key = `${name}::${cat}`;
                      const open = openMemberCats.has(key);
                      const rows = spending
                        .filter(e => e.category === cat && (Number(e.split_data[name]) || 0) > 0)
                        .sort((a, b) => b.date.localeCompare(a.date))
                        .map(e => ({ ...e, amount: Number(e.split_data[name]) || 0 }));
                      return (
                        <div key={cat}>
                          <button onClick={() => setOpenMemberCats(s => toggle(s, key))} aria-expanded={open} className="w-full grid grid-cols-[minmax(0,1fr)_auto_40px_14px] items-center gap-2 py-1 text-xs text-ink-2 text-left">
                            <span className="truncate">{cat}</span>
                            <span className="num">{formatMoney(val, base, prec)}</span>
                            <span className="num text-muted text-right">{pct(val, data.totalOwed).toFixed(0)}%</span>
                            <ChevronRight size={12} className={`text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
                          </button>
                          {open && <DetailLines rows={rows} trip={trip} />}
                        </div>
                      );
                    })}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default StatsTab;
