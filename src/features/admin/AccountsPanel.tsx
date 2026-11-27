import React, { useMemo, useState } from 'react';
import { ArrowDownUp, Search, ShieldCheck } from 'lucide-react';
import { ui } from '../../components/ui';
import LoginBadges from '../auth/LoginBadges';
import type { AdminAccountRow } from './types';

type SortKey = 'created' | 'last_sign_in' | 'ai' | 'trips';
type Filter = 'all' | 'paid' | 'free' | 'admin' | 'line' | 'google';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'created', label: '最新註冊' },
  { key: 'last_sign_in', label: '最近登入' },
  { key: 'ai', label: 'AI 用最多' },
  { key: 'trips', label: '旅程最多' },
];
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'paid', label: '付費' },
  { key: 'free', label: '免費' },
  { key: 'admin', label: '管理員' },
  { key: 'line', label: 'LINE' },
  { key: 'google', label: 'Google' },
];
const time = (s: string | null) => (s ? new Date(s).getTime() : 0);
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) : '—');

/** 後台的帳號清單：搜尋（LINE 名稱、Google 名稱、遮過的 email）、篩選、排序；可以切換「付費」 */
const AccountsPanel: React.FC<{ accounts: AdminAccountRow[]; busy: boolean; onSetPaid: (a: AdminAccountRow, paid: boolean) => void }> = ({
  accounts, busy, onSetPaid,
}) => {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('created');
  const [filter, setFilter] = useState<Filter>('all');

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = accounts.filter(a => {
      if (needle && !a.logins.map(l => `${l.name ?? ''} ${l.account ?? ''}`).join(' ').toLowerCase().includes(needle)) return false;
      switch (filter) {
        case 'paid': return a.paid;
        case 'free': return !a.paid;
        case 'admin': return a.admin;
        case 'line': return a.logins.some(l => l.provider === 'line');
        case 'google': return a.logins.some(l => l.provider === 'google');
        default: return true;
      }
    });
    const by: Record<SortKey, (x: AdminAccountRow, y: AdminAccountRow) => number> = {
      created: (x, y) => time(y.created_at) - time(x.created_at),
      last_sign_in: (x, y) => time(y.last_sign_in_at) - time(x.last_sign_in_at),
      ai: (x, y) => y.ai_calls - x.ai_calls,
      trips: (x, y) => y.trips - x.trips,
    };
    return [...list].sort(by[sort]);
  }, [accounts, q, sort, filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2">
        <label className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className={`${ui.input} pl-9`} placeholder="搜尋 LINE／Google 名稱或 email" value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <label className="relative sm:w-44">
          <ArrowDownUp size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <select className={`${ui.select} pl-9`} value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="排序">
            {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0" role="group" aria-label="篩選">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={`${ui.chip} ${filter === f.key ? ui.chipOn : ui.chipOff}`}>{f.label}</button>
        ))}
      </div>
      <p className="text-xs text-muted">{shown.length} / {accounts.length} 個帳號</p>

      {shown.length === 0 ? <p className="text-sm text-muted py-6 text-center">沒有符合的帳號</p> : (
        <ul className={`${ui.card} divide-y divide-line`}>
          {shown.map(a => (
            <li key={a.id} className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-1.5">
                  <LoginBadges logins={a.logins} />
                  {a.admin && <ShieldCheck size={14} className="text-accent shrink-0" aria-label="管理員" />}
                </div>
                <p className="text-xs text-muted num">
                  註冊 {day(a.created_at)}・登入 {day(a.last_sign_in_at)}・旅程 {a.trips}・建立 {a.allowance.created}
                  {a.allowance.paid ? '' : `/${a.allowance.limit}`}・AI {a.ai_calls}
                </p>
              </div>
              <button type="button" disabled={busy} onClick={() => onSetPaid(a, !a.paid)} role="switch" aria-checked={a.paid}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${a.paid ? 'bg-accent text-on-accent' : 'bg-sunk text-ink-2 hover:text-ink'}`}>
                {a.paid ? '付費' : '免費'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default AccountsPanel;
