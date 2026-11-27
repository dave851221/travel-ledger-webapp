import React, { useEffect, useState } from 'react';
import { supabase } from '../../api/supabase';

interface Meter { used: number; limit: number }
interface Usage { plan: string; entries: Meter; ai_calls: Meter; photos: Meter }

const ROWS: { key: 'entries' | 'ai_calls' | 'photos'; label: string }[] = [
  { key: 'entries', label: '記帳筆數' },
  { key: 'ai_calls', label: 'AI 記帳次數' },
  { key: 'photos', label: '照片' },
];

/**
 * 開放版：這趟旅程用了多少（資料庫 trip_usage 算好，成員才看得到）。
 * 快滿時變色，讓大家在被擋之前就知道。
 */
const TripUsage: React.FC<{ tripId: string }> = ({ tripId }) => {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.rpc('trip_usage', { p_trip_id: tripId }).then(({ data }) => { if (alive && data) setUsage(data as Usage); });
    return () => { alive = false; };
  }, [tripId]);

  if (!usage) return null;
  return (
    <section className="rounded-2xl border border-line p-4 space-y-3">
      <p className="text-sm font-bold">
        這趟的用量 <span className="text-xs font-normal text-muted">· {usage.plan === 'paid' ? '已解鎖' : '免費旅程'}</span>
      </p>
      {ROWS.map(({ key, label }) => {
        const m = usage[key];
        const ratio = m.limit > 0 ? Math.min(1, m.used / m.limit) : 1;
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
