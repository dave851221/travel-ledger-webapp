import React from 'react';

/**
 * 客製區塊：一條橫向的鐵路路線，列出各站時間。
 * 放在行程項目的 `extra` 或某一天的 `extra`，顏色跟著行程風格走。
 */
const RailStops: React.FC<{ stops: { station: string; time: string }[] }> = ({ stops }) => (
  <div className="rounded-xl border border-line bg-surface px-3 py-3">
    <ol className="flex items-start">
      {stops.map((s, i) => (
        <li key={s.station} className="flex items-start flex-1 last:flex-none min-w-0">
          <span className="grid justify-items-center gap-0.5 shrink-0 min-w-[52px]">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--t-accent)] mt-1" aria-hidden />
            <span className="text-sm font-bold">{s.station}</span>
            <span className="num text-xs font-bold text-[var(--t-accent)]">{s.time}</span>
          </span>
          {i < stops.length - 1 && <span className="flex-1 mt-[9px] h-0.5 rounded-full bg-[var(--t-soft)]" aria-hidden />}
        </li>
      ))}
    </ol>
  </div>
);

export default RailStops;
