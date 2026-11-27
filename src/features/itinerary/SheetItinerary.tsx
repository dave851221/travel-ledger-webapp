import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ExternalLink, FileSpreadsheet, Link2, Loader2, RefreshCw, Unlink } from 'lucide-react';
import { supabase } from '../../api/supabase';
import { ui } from '../../components/ui';
import type { Trip } from '../../types';
import ItineraryView from './ItineraryView';
import type { ItineraryPlan } from './types';
import {
  fetchSheetPlan, readCachedSheet, SHEET_ERROR_TEXT, SHEET_TEMPLATE_COPY_URL, sheetEditUrl, sheetIdFromUrl, type SheetError,
} from './sheet';

/**
 * 開放版的行程分頁：行程寫在 Google 試算表（David 2026-11-27）。
 * 還沒連結 → 三個步驟＋貼連結；連結了 → 先畫這台裝置上次讀到的，同時去讀最新的。
 */
const SheetItinerary: React.FC<{ trip: Trip; readOnly: boolean; onChanged: () => void }> = ({ trip, readOnly, onChanged }) => {
  const sheetId = trip.itinerary_sheet ?? null;
  if (!sheetId) return <SheetSetup tripId={trip.id} readOnly={readOnly} onLinked={onChanged} />;
  return <LinkedSheet key={sheetId} trip={trip} sheetId={sheetId} readOnly={readOnly} onChanged={onChanged} />;
};

const Step: React.FC<{ n: number; title: string; children?: React.ReactNode }> = ({ n, title, children }) => (
  <li className="flex gap-3">
    <span className="shrink-0 w-6 h-6 rounded-full bg-accent/20 text-ink text-xs font-bold num flex items-center justify-center mt-0.5">{n}</span>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-bold text-ink">{title}</p>
      {children && <div className="text-sm text-ink-2 mt-1">{children}</div>}
    </div>
  </li>
);

const SheetSetup: React.FC<{ tripId: string; readOnly: boolean; onLinked: () => void }> = ({ tripId, readOnly, onLinked }) => {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SheetError | 'save_failed' | null>(null);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = sheetIdFromUrl(link);
    if (!id) { setError('invalid_link'); return; }
    setBusy(true);
    setError(null);
    const r = await fetchSheetPlan(tripId, link);
    if (!r.ok) { setBusy(false); setError(r.error); return; }
    const { error: upErr } = await supabase.from('trips').update({ itinerary_sheet: r.sheetId }).eq('id', tripId);
    setBusy(false);
    if (upErr) { setError('save_failed'); return; }
    onLinked();
  };

  return (
    <div className="max-w-xl mx-auto py-6 sm:py-10">
      <div className={`${ui.card} p-5 sm:p-6 space-y-5`}>
        <div className="flex items-start gap-3">
          <span className="shrink-0 w-11 h-11 rounded-2xl bg-pos/15 text-pos flex items-center justify-center"><FileSpreadsheet size={22} /></span>
          <div>
            <h2 className="text-lg font-bold">用 Google 試算表排行程</h2>
            <p className="text-sm text-ink-2 mt-1">大家一起在試算表上排，這裡會整理成每天的時間軸，旅行喵喵也看得到。</p>
          </div>
        </div>

        {readOnly ? (
          <p className="text-sm text-muted">這趟旅程已封存，不能再連結試算表。</p>
        ) : (
          <>
            <ol className="space-y-4">
              <Step n={1} title="複製一份行程表模板">
                {SHEET_TEMPLATE_COPY_URL ? (
                  <a href={SHEET_TEMPLATE_COPY_URL} target="_blank" rel="noopener noreferrer" className={`${ui.btnSecondary} mt-1.5 h-9 py-0`}>
                    <ExternalLink size={14} />複製行程表模板
                  </a>
                ) : (
                  <>新增一份 Google 試算表，第一列寫上：日期、時間、類型、行程、地點、備註、連結、預訂。</>
                )}
              </Step>
              <Step n={2} title="開放檢視">
                在試算表右上角按「共用」，把「一般存取權」改成「知道連結的任何人」（檢視者就好）。
              </Step>
              <Step n={3} title="把試算表的網址貼在這裡" />
            </ol>
            <form onSubmit={connect} className="space-y-2.5">
              <input
                value={link}
                onChange={e => { setLink(e.target.value); setError(null); }}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                inputMode="url"
                className={ui.input}
                aria-label="試算表網址"
              />
              {error && (
                <div className={ui.errorBox}>
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span>{error === 'save_failed' ? '讀到行程了，但存不進這趟旅程，請稍後再試。' : SHEET_ERROR_TEXT[error]}</span>
                </div>
              )}
              <button type="submit" disabled={busy || !link.trim()} className={`${ui.btnPrimary} w-full`}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                {busy ? '讀取中…' : '連結試算表'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

const LinkedSheet: React.FC<{ trip: Trip; sheetId: string; readOnly: boolean; onChanged: () => void }> = ({ trip, sheetId, readOnly, onChanged }) => {
  const [cached] = useState(() => readCachedSheet(trip.id, sheetId));
  const [plan, setPlan] = useState<ItineraryPlan | null>(cached?.plan ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SheetError | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await fetchSheetPlan(trip.id);
    setLoading(false);
    if (r.ok) { setPlan(r.plan); setError(null); } else setError(r.error);
  }, [trip.id]);

  // 打開分頁時讀一次最新的（試算表沒有推播，改了要重新整理才看得到）
  useEffect(() => {
    let alive = true;
    fetchSheetPlan(trip.id).then(r => {
      if (!alive) return;
      setLoading(false);
      if (r.ok) { setPlan(r.plan); setError(null); } else setError(r.error);
    });
    return () => { alive = false; };
  }, [trip.id]);

  const unlink = async () => {
    setUnlinking(true);
    const { error: upErr } = await supabase.from('trips').update({ itinerary_sheet: null }).eq('id', trip.id);
    setUnlinking(false);
    if (!upErr) onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={sheetEditUrl(sheetId)} target="_blank" rel="noopener noreferrer" className={`${ui.btnSecondary} h-9 py-0`}>
          <FileSpreadsheet size={15} />到試算表編輯
        </a>
        <button onClick={refresh} disabled={loading} className={`${ui.btnSecondary} h-9 py-0`} aria-label="重新讀取試算表">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{loading ? '讀取中' : '更新'}
        </button>
        {!readOnly && (
          <button onClick={unlink} disabled={unlinking} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-ink px-2 h-9" title="這趟不再使用這份試算表（試算表本身不會被刪除）">
            <Unlink size={13} />取消連結
          </button>
        )}
      </div>
      {error && (
        <div className={ui.errorBox}>
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span>{SHEET_ERROR_TEXT[error]}{plan ? '（下面是上次讀到的內容）' : ''}</span>
        </div>
      )}
      {plan ? <ItineraryView plan={plan} /> : loading ? (
        <div className="flex justify-center py-20"><Loader2 className="animate-spin text-muted" /></div>
      ) : null}
    </div>
  );
};

export default SheetItinerary;
