import React from 'react';
import { X } from 'lucide-react';
import { ui } from './ui';
import { tripDayCount } from '../utils/tripDates';

/**
 * 旅程日期（建立旅程與設定頁共用）：開始、結束兩格，都選填。
 * 只去一天就只填開始；結束不能早於開始（正規化與檢查在 utils/tripDates.ts 的 normalizeTripDates）。
 */
const TripDatesField: React.FC<{
  idPrefix: string;
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}> = ({ idPrefix, start, end, onChange }) => {
  const days = tripDayCount({ start_date: start || null, end_date: end || null });
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={`${idPrefix}-start`} className={ui.label}>
          旅程日期 <span className="text-muted font-normal">· 選填，只去一天就只填開始</span>
        </label>
        {(start || end) && (
          <button
            type="button"
            onClick={() => onChange('', '')}
            className="shrink-0 inline-flex items-center gap-0.5 text-xs text-muted hover:text-ink mb-1.5"
          >
            <X size={12} />清除
          </button>
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <input
          id={`${idPrefix}-start`}
          type="date"
          aria-label="開始日期"
          className={`${ui.input} num min-w-0`}
          value={start}
          onChange={e => {
            const s = e.target.value;
            // 開始改到結束之後：結束跟著清掉，不然存不進去
            onChange(s, end && s && end < s ? '' : end);
          }}
        />
        <span className="text-muted text-sm">–</span>
        <input
          id={`${idPrefix}-end`}
          type="date"
          aria-label="結束日期"
          className={`${ui.input} num min-w-0`}
          value={end}
          min={start || undefined}
          onChange={e => onChange(start, e.target.value)}
        />
      </div>
      <p className={`${ui.hint} mt-1.5`}>
        {days ? (days === 1 ? '一天的旅程。' : `共 ${days} 天。`) : '沒填的話，首頁用建立日期排序與顯示。'}
      </p>
    </div>
  );
};

export default TripDatesField;
