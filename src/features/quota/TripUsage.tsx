import React, { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { supabase } from '../../api/supabase';

interface Meter { used: number; limit: number }
interface Usage { plan: string; entries: Meter; ai_calls: Meter; photos: Meter }

const ROWS: { key: 'entries' | 'ai_calls' | 'photos'; label: string; short: string }[] = [
  { key: 'entries', label: '記帳筆數', short: '記帳' },
  { key: 'ai_calls', label: 'AI 記帳次數', short: 'AI' },
  { key: 'photos', label: '照片', short: '照片' },
];

const ratioOf = (m: Meter) => (m.limit > 0 ? Math.min(1, m.used / m.limit) : 1);
const toneText = (r: number) => (r >= 1 ? 'text-neg font-bold' : r >= 0.8 ? 'text-warn font-bold' : 'text-muted');

/**
 * 開放版：這趟旅程用了多少（資料庫 trip_usage 算好，成員才看得到）。
 * David 2026-11-27：要隨時看得到額度，不要等碰到上限才知道 ——
 *   compact：帳目頁快速記帳下面的一行，點了打開旅程設定
 *   完整：旅程設定「基本」頁，三條進度條
 * refreshKey 變了就重新讀（帳目數量變了）。
 */
const TripUsage: React.FC<{ tripId: string; compact?: boolean; refreshKey?: number; onOpen?: () => void }> = ({
  tripId, compact = false, refreshKey = 0, onOpen,
}) => {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.rpc('trip_usage', { p_trip_id: tripId }).then(({ data }) => { if (alive && data) setUsage(data as Usage); });
    return () => { alive = false; };
  }, [tripId, refreshKey]);

  if (!usage) return null;
  const planLabel = usage.plan === 'paid' ? '已解鎖' : '免費旅程';

  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-2 px-1 text-[12px] text-muted hover:text-ink"
        aria-label="查看這趟的用量"
      >
        <Gauge size={13} className="shrink-0" />
        <span className="shrink-0">{planLabel}</span>
        <span className="flex-1 min-w-0 flex flex-wrap justify-end gap-x-2.5 num">
          {ROWS.map(({ key, short }) => {
            const m = usage[key];
            return <span key={key} className={toneText(ratioOf(m))}>{short} {m.used}/{m.limit}</span>;
          })}
        </span>
      </button>
    );
  }

  return (
    <section className="rounded-2xl border border-line p-4 space-y-3">
      <p className="text-sm font-bold">
        這趟的用量 <span className="text-xs font-normal text-muted">· {planLabel}</span>
      </p>
      {ROWS.map(({ key, label }) => {
        const m = usage[key];
        const ratio = ratioOf(m);
        const tone = ratio >= 1 ? 'bg-neg' : ratio >= 0.8 ? 'bg-warn' : 'bg-pos';
        return (
          <div key={key} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-ink-2">{label}</span>
              <span className={`num ${ratio >= 1 ? 'text-neg font-bold' : 'text-muted'}`}>{m.used} / {m.limit}</span>
            </div>
            <div className="h-1.5 rounded-full bg-sunk overflow-hidden" role="progressbar" aria-label={label} aria-valuenow={m.used} aria-valuemax={m.limit}>
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted">刪掉的帳不算筆數；結清不算。AI 次數是 LINE 和網頁一起算。</p>
    </section>
  );
};

export default TripUsage;
