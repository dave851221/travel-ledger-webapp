import React, { useMemo, useState } from 'react';
import { ArrowDownUp, MessageCircle, Search, SlidersHorizontal } from 'lucide-react';
import { ui } from '../../components/ui';
import LoginBadges from '../auth/LoginBadges';
import type { AdminTripRow } from './types';

type SortKey = 'created' | 'last_entry' | 'ai' | 'entries' | 'fullest' | 'name';
type Filter = 'all' | 'free' | 'paid' | 'near' | 'suspended' | 'line' | 'archived';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'created', label: '最新建立' },
  { key: 'last_entry', label: '最近記帳' },
  { key: 'fullest', label: '快用完' },
  { key: 'ai', label: 'AI 用最多' },
  { key: 'entries', label: '帳最多' },
  { key: 'name', label: '名稱' },
];
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'free', label: '免費' },
  { key: 'paid', label: '已解鎖' },
  { key: 'near', label: '快用完' },
  { key: 'suspended', label: 'AI 暫停' },
  { key: 'line', label: '有綁 LINE' },
  { key: 'archived', label: '已封存' },
];

const ratio = (used: number, limit: number) => (limit > 0 ? used / limit : 1);
/** 三種用量裡最滿的那一個（0～1+） */
const fullness = (t: AdminTripRow) => Math.max(
  ratio(t.entries, t.limits.max_entries), ratio(t.ai_calls, t.limits.max_ai_calls), ratio(t.photos, t.limits.max_photos));
const time = (s: string | null) => (s ? new Date(s).getTime() : 0);
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) : '—');

const Meter: React.FC<{ label: string; used: number; limit: number }> = ({ label, used, limit }) => {
  const r = Math.min(1, ratio(used, limit));
  const tone = r >= 1 ? 'bg-neg' : r >= 0.8 ? 'bg-warn' : 'bg-pos';
  return (
    <span className="min-w-0">
      <span className={`flex justify-between gap-1 text-[11px] ${r >= 1 ? 'text-neg font-bold' : r >= 0.8 ? 'text-warn font-bold' : 'text-ink-2'}`}>
        <span>{label}</span><span className="num">{used}/{limit}</span>
      </span>
      <span className="block h-1 mt-0.5 rounded-full bg-sunk overflow-hidden"><span className={`block h-full ${tone}`} style={{ width: `${r * 100}%` }} /></span>
    </span>
  );
};

/** 後台的旅程清單：搜尋（名稱、建立者、id）、篩選、排序都在這台裝置上做，手機一張卡、電腦一列 */
const TripsPanel: React.FC<{ trips: AdminTripRow[]; onEdit: (t: AdminTripRow) => void }> = ({ trips, onEdit }) => {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('created');
  const [filter, setFilter] = useState<Filter>('all');

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = trips.filter(t => {
      if (needle) {
        const owner = (t.owner ?? []).map(l => `${l.name ?? ''} ${l.account ?? ''}`).join(' ').toLowerCase();
        if (!t.name.toLowerCase().includes(needle) && !owner.includes(needle) && !t.id.startsWith(needle)) return false;
      }
      switch (filter) {
        case 'free': return t.plan !== 'paid';
        case 'paid': return t.plan === 'paid';
        case 'near': return fullness(t) >= 0.8;
        case 'suspended': return t.ai_suspended;
        case 'line': return t.line_bound;
        case 'archived': return t.is_archived;
        default: return true;
      }
    });
    const by: Record<SortKey, (a: AdminTripRow, b: AdminTripRow) => number> = {
      created: (a, b) => time(b.created_at) - time(a.created_at),
      last_entry: (a, b) => time(b.last_entry) - time(a.last_entry),
      fullest: (a, b) => fullness(b) - fullness(a),
      ai: (a, b) => b.ai_calls - a.ai_calls,
      entries: (a, b) => b.entries - a.entries,
      name: (a, b) => a.name.localeCompare(b.name, 'zh-Hant'),
    };
    return [...list].sort(by[sort]);
  }, [trips, q, sort, filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2">
        <label className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className={`${ui.input} pl-9`} placeholder="搜尋旅程、建立者或 id" value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <label className="relative sm:w-44">
          <ArrowDownUp size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <select className={`${ui.select} pl-9`} value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="排序">
            {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0" role="group" aria-label="篩選">
        <SlidersHorizontal size={15} className="shrink-0 self-center text-muted" />
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={`${ui.chip} ${filter === f.key ? ui.chipOn : ui.chipOff}`}>{f.label}</button>
        ))}
      </div>
      <p className="text-xs text-muted">{shown.length} / {trips.length} 趟</p>

      {shown.length === 0 ? <p className="text-sm text-muted py-6 text-center">沒有符合的旅程</p> : (
        <ul className={`${ui.card} divide-y divide-line overflow-hidden`}>
          <li className="hidden lg:grid grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_repeat(3,minmax(0,1fr))_5rem] gap-4 px-4 py-2 text-[11px] text-muted bg-sunk/50">
            <span>旅程</span><span>建立者</span><span>記帳</span><span>AI</span><span>照片</span><span />
          </li>
          {shown.map(t => (
            <li key={t.id}>
              <button type="button" onClick={() => onEdit(t)}
                className="w-full text-left px-4 py-3 hover:bg-sunk/60 transition-colors grid gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_repeat(3,minmax(0,1fr))_5rem] lg:gap-4 lg:items-center">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="font-bold truncate">{t.name}</span>
                    {t.line_bound && <MessageCircle size={13} className="text-pos shrink-0" aria-label="已綁定 LINE" />}
                  </span>
                  <span className="flex flex-wrap gap-1.5 mt-0.5 text-[11px]">
                    <span className={`rounded px-1.5 font-bold ${t.plan === 'paid' ? 'bg-accent/15 text-accent' : 'bg-sunk text-ink-2'}`}>{t.plan === 'paid' ? '已解鎖' : '免費'}</span>
                    {t.ai_suspended && <span className="rounded px-1.5 font-bold bg-neg/10 text-neg">AI 暫停</span>}
                    {t.is_archived && <span className="rounded px-1.5 bg-sunk text-muted">已封存</span>}
                    <span className="text-muted num">建立 {day(t.created_at)}・最後記帳 {day(t.last_entry)}・{t.members} 人</span>
                  </span>
                </span>
                <span className="min-w-0">{t.owner ? <LoginBadges logins={t.owner} /> : <span className="text-xs text-muted">—</span>}</span>
                <span className="grid grid-cols-3 gap-3 lg:contents">
                  <Meter label="記帳" used={t.entries} limit={t.limits.max_entries} />
                  <Meter label="AI" used={t.ai_calls} limit={t.limits.max_ai_calls} />
                  <Meter label="照片" used={t.photos} limit={t.limits.max_photos} />
                </span>
                <span className="hidden lg:block text-right text-xs text-accent font-medium">調整 ›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default TripsPanel;
