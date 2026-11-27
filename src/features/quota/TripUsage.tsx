import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { supabase } from '../../api/supabase';
import UpgradeModal from './UpgradeModal';

interface Meter { used: number; limit: number }
interface Usage { plan: string; entries: Meter; ai_calls: Meter; photos: Meter }

const ROWS: { key: 'entries' | 'ai_calls' | 'photos'; label: string; short: string }[] = [
  { key: 'entries', label: '記帳筆數', short: '記帳' },
  { key: 'ai_calls', label: 'AI 記帳次數', short: 'AI' },
  { key: 'photos', label: '照片', short: '照片' },
];

const ratioOf = (m: Meter) => (m.limit > 0 ? Math.min(1, m.used / m.limit) : 1);
const barTone = (r: number) => (r >= 1 ? 'bg-neg' : r >= 0.8 ? 'bg-warn' : 'bg-pos');
const textTone = (r: number) => (r >= 1 ? 'text-neg' : r >= 0.8 ? 'text-warn' : 'text-ink-2');

/**
 * 開放版：這趟旅程用了多少（資料庫 trip_usage 算好，成員才看得到）。
 * David 2026-11-27：要隨時看得到額度、看起來要有感覺但不能多佔版面，旁邊要能升級／加購。
 *   compact：帳目頁快速記帳下面的一張小卡（三條細進度條＋升級鈕）
 *   完整：旅程設定「基本」頁
 * refreshKey 變了就重新讀（帳目數量變了）。
 */
const TripUsage: React.FC<{ tripId: string; compact?: boolean; refreshKey?: number; onOpen?: () => void }> = ({
  tripId, compact = false, refreshKey = 0, onOpen,
}) => {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.rpc('trip_usage', { p_trip_id: tripId }).then(({ data }) => { if (alive && data) setUsage(data as Usage); });
    return () => { alive = false; };
  }, [tripId, refreshKey]);

  if (!usage) return null;
  const paid = usage.plan === 'paid';
  const upgradeLabel = paid ? '加購' : '升級';
  const upgrade = <UpgradeModal isOpen={upgradeOpen} onClose={() => setUpgradeOpen(false)} paid={paid} />;

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-surface border border-line pl-2.5 pr-1.5 py-1.5">
        <button type="button" onClick={onOpen} className="flex-1 min-w-0 flex items-center gap-2.5 text-left" aria-label="查看這趟的用量">
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${paid ? 'bg-accent/15 text-accent' : 'bg-sunk text-ink-2'}`}>
            {paid ? '解鎖' : '免費'}
          </span>
          {ROWS.map(({ key, short }) => {
            const m = usage[key];
            const r = ratioOf(m);
            return (
              <span key={key} className="flex-1 min-w-0">
                {/* 手機上三格很擠（David 2026-11-27 名稱被切成半個字）：數字一行、名稱＋進度條一行，都不會被切 */}
                <span className={`block text-[11px] leading-4 whitespace-nowrap num ${textTone(r)}`}>
                  <span className="font-bold">{m.used}</span><span className="text-muted">/{m.limit}</span>
                </span>
                <span className="flex items-center gap-1.5 mt-0.5">
                  <span className="shrink-0 text-[10px] leading-3 text-muted whitespace-nowrap">{short}</span>
                  <span className="flex-1 h-1 rounded-full bg-sunk overflow-hidden">
                    <span className={`block h-full rounded-full ${barTone(r)}`} style={{ width: `${Math.max(r * 100, m.used > 0 ? 6 : 0)}%` }} />
                  </span>
                </span>
              </span>
            );
          })}
        </button>
        <button type="button" onClick={() => setUpgradeOpen(true)}
          className="shrink-0 inline-flex items-center gap-1 rounded-xl bg-accent text-on-accent text-xs font-bold px-2 py-1.5 hover:brightness-105">
          <Sparkles size={13} />{upgradeLabel}
        </button>
        {upgrade}
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-line p-4 space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-bold flex-1">這趟的用量 <span className="text-xs font-normal text-muted">· {paid ? '已解鎖' : '免費旅程'}</span></p>
        <button type="button" onClick={() => setUpgradeOpen(true)}
          className="inline-flex items-center gap-1 rounded-xl bg-accent text-on-accent text-xs font-bold px-3 py-1.5 hover:brightness-105">
          <Sparkles size={13} />{paid ? '加購額度' : '升級旅程'}
        </button>
      </div>
      {ROWS.map(({ key, label }) => {
        const m = usage[key];
        const r = ratioOf(m);
        return (
          <div key={key} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-ink-2">{label}</span>
              <span className={`num ${r >= 1 ? 'text-neg font-bold' : 'text-muted'}`}>{m.used} / {m.limit}</span>
            </div>
            <div className="h-1.5 rounded-full bg-sunk overflow-hidden" role="progressbar" aria-label={label} aria-valuenow={m.used} aria-valuemax={m.limit}>
              <div className={`h-full rounded-full ${barTone(r)}`} style={{ width: `${r * 100}%` }} />
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted">刪掉的帳和照片會空出額度；AI 次數 LINE 和網頁一起算。</p>
      {upgrade}
    </section>
  );
};

export default TripUsage;
