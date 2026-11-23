import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Clapperboard, Download, Loader2, Pause, Play, RotateCcw, Share2, Sparkles, Star } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import type { TripStats } from '../../hooks/useTripStats';
import Modal from '../../components/Modal';
import { ui } from '../../components/ui';
import { photoUrl } from '../../utils/storage';
import { formatMoney } from '../../utils/money';
import { getItinerary, isPlan } from '../itinerary/registry';
import {
  MAX_PHOTOS, autoPick, buildTimeline, daysBetween, recapDays, shotsFromPicks, tripDateRange,
  type DayMeta, type RecapDay, type RecapPhoto,
} from './plan';
import { MUSIC_STYLES, renderMusic, styleBpm, type MusicStyle } from './music';
import { PhotoStore } from './images';
import { RecapRenderer, VIDEO_W, ensureFonts, pathsNear, type RecapContent, type RecapScene, type RecapStat } from './render';
import { checkSupport, dayTexts, encodeRecap, type EncodeSupport } from './encode';

interface Props {
  trip: Trip;
  expenses: Expense[];
  stats: TripStats;
  onClose: () => void;
}

interface Saved {
  picks?: string[];
  outro?: string | null;
  music?: MusicStyle;
  showMoney?: boolean;
}

const storageKey = (tripId: string) => `recap_${tripId}`;
const readSaved = (tripId: string): Saved => {
  try {
    return JSON.parse(localStorage.getItem(storageKey(tripId)) ?? '{}') as Saved;
  } catch {
    return {};
  }
};

const PREVIEW_W = 360;

type Phase =
  | { kind: 'setup' }
  | { kind: 'rendering'; progress: number; step: string }
  | { kind: 'done'; url: string; blob: Blob }
  | { kind: 'error'; message: string };

const fileName = (trip: Trip) => `${trip.name.replace(/[\\/:*?"<>|]+/g, '').trim() || '旅程'}-回顧.mp4`;

/**
 * 封存旅程的「回顧影片」：挑照片、選音樂、預覽，然後在這台裝置上產生 9:16 的 MP4。
 * 選擇記在這台裝置的 localStorage（不寫資料庫，免費方案的 Disk IO 很緊）。
 */
const RecapVideoModal: React.FC<Props> = ({ trip, expenses, stats, onClose }) => {
  const saved = useMemo(() => readSaved(trip.id), [trip.id]);

  // --- Story data ---
  const { days, range } = useMemo(() => {
    const entry = getItinerary(trip.id);
    const meta: DayMeta[] = entry && isPlan(entry) ? entry.days.map(d => ({ date: d.date, city: d.city, title: d.title })) : [];
    const r = tripDateRange(expenses, meta.map(m => m.date));
    return { days: r ? recapDays(expenses, r, meta) : [], range: r };
  }, [trip.id, expenses]);
  const allPhotos = useMemo(() => days.flatMap(d => d.photos), [days]);
  const known = useMemo(() => new Set(allPhotos.map(p => p.path)), [allPhotos]);

  const [picks, setPicks] = useState<string[]>(() => {
    const kept = (saved.picks ?? []).filter(p => known.has(p));
    return kept.length > 0 ? kept : autoPick(days);
  });
  const [outro, setOutro] = useState<string | null>(() => (saved.outro && known.has(saved.outro) ? saved.outro : null));
  const [music, setMusic] = useState<MusicStyle>(saved.music ?? 'bright');
  const [showMoney, setShowMoney] = useState(saved.showMoney ?? true);
  const [pickerMode, setPickerMode] = useState<'photos' | 'outro' | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(trip.id), JSON.stringify({ picks, outro, music, showMoney } satisfies Saved));
    } catch {
      // Private mode: the choices last only this visit
    }
  }, [trip.id, picks, outro, music, showMoney]);

  // The closing photo is saved for the end, not shown twice
  const shots = useMemo(() => shotsFromPicks(days, picks.filter(p => p !== outro)), [days, picks, outro]);
  const outroPhoto: RecapPhoto | null = useMemo(() => {
    const chosen = allPhotos.find(p => p.path === outro);
    return chosen ?? shots[shots.length - 1]?.photo ?? null;
  }, [allPhotos, outro, shots]);

  const timeline = useMemo(() => buildTimeline(shots, styleBpm(music), outroPhoto), [shots, music, outroPhoto]);

  const content: RecapContent = useMemo(() => {
    const from = range?.from ?? '';
    const to = range?.to ?? '';
    const dateLabel = from
      ? `${from.replace(/-/g, '.')} — ${from.slice(0, 4) === to.slice(0, 4) ? to.slice(5).replace('-', '.') : to.replace(/-/g, '.')}`
      : '';
    const spent = expenses.filter(e => !e.deleted_at && !e.is_settlement);
    const list: RecapStat[] = [];
    if (range) list.push({ label: '旅行天數', value: daysBetween(range.from, range.to) + 1, suffix: '天' });
    list.push({ label: '一起記下的消費', value: spent.length, suffix: '筆' });
    if (allPhotos.length > 0) list.push({ label: '拍下的照片', value: allPhotos.length, suffix: '張' });
    if (showMoney && stats.grandBase.total > 0) {
      const symbol = formatMoney(0, trip.base_currency, trip.precision_config).replace(/[\d.,\s-]/g, '');
      list.push({ label: '總花費', value: Math.round(stats.grandBase.total), prefix: symbol || trip.base_currency });
    }
    const top = stats.categoryData[0];
    if (top) list.push({ label: '花最多的分類', value: top.name });
    return { tripName: trip.name, dateLabel, members: trip.members, stats: list };
  }, [range, expenses, allPhotos.length, showMoney, stats, trip]);

  // --- Photo store and preview ---
  const storeRef = useRef<PhotoStore | null>(null);
  if (!storeRef.current) storeRef.current = new PhotoStore();
  const store = storeRef.current;
  const [prepared, setPrepared] = useState({ done: 0, total: 0 });
  const [storeVersion, setStoreVersion] = useState(0);

  const needed = useMemo(() => {
    const set = new Set(picks);
    if (outroPhoto) set.add(outroPhoto.path);
    return [...set];
  }, [picks, outroPhoto]);

  useEffect(() => {
    const ac = new AbortController();
    store.prepare(needed, (done, total) => setPrepared({ done, total }), ac.signal)
      .then(() => { if (!ac.signal.aborted) setStoreVersion(v => v + 1); });
    return () => ac.abort();
  }, [store, needed]);

  useEffect(() => () => store.dispose(), [store]);

  const scene: RecapScene = useMemo(() => ({
    timeline,
    content,
    photo: (path: string) => store.get(path),
  }), [timeline, content, store]);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RecapRenderer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const playRef = useRef<{ raf: number; ctx: AudioContext | null; startedAt: number; offset: number } | null>(null);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    if (!rendererRef.current) rendererRef.current = new RecapRenderer(canvas, scene);
    else rendererRef.current.setScene(scene);
  }, [scene]);

  const drawAt = useCallback((t: number) => {
    const r = rendererRef.current;
    if (!r) return;
    void store.keepOnly(pathsNear(scene.timeline, t, 1.5)).then(() => {
      // Repaint once the photos land when the preview is paused
      if (!playRef.current && Math.abs(timeRef.current - t) < 1e-6) r.draw(t);
    });
    r.draw(t);
  }, [store, scene]);

  // Repaint once the fonts for this text arrive
  useEffect(() => {
    let alive = true;
    void ensureFonts(scene.content, dayTexts(scene)).then(() => { if (alive) setStoreVersion(v => v + 1); });
    return () => { alive = false; };
  }, [scene]);

  // Show a frame where the title has fully come in
  const posterTime = Math.min(timeline.segments[0].end - 0.2, timeline.beat * 7);
  useEffect(() => {
    if (playRef.current) return;
    const t = timeRef.current > 0 ? Math.min(timeRef.current, timeline.duration - 0.01) : posterTime;
    timeRef.current = t;
    drawAt(t);
  }, [drawAt, posterTime, timeline.duration, storeVersion]);

  const stopPreview = useCallback(() => {
    const p = playRef.current;
    if (!p) return;
    cancelAnimationFrame(p.raf);
    void p.ctx?.close();
    playRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stopPreview, [stopPreview]);
  // Any change to the story restarts the preview from the top next time
  useEffect(() => { stopPreview(); }, [timeline, music, stopPreview]);

  const startPreview = async () => {
    stopPreview();
    const from = timeRef.current >= timeline.duration - 0.1 || timeRef.current === posterTime ? 0 : timeRef.current;
    let ctx: AudioContext | null = null;
    try {
      const buffer = await renderMusic(music, timeline, 44100);
      if (buffer) {
        ctx = new AudioContext();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(0, from);
      }
    } catch (e) {
      console.warn('[recap] preview audio failed', e);
    }
    const startedAt = ctx ? ctx.currentTime : performance.now() / 1000;
    const state = { raf: 0, ctx, startedAt, offset: from };
    playRef.current = state;
    setPlaying(true);
    const tick = () => {
      if (playRef.current !== state) return;
      const now = state.ctx ? state.ctx.currentTime : performance.now() / 1000;
      const t = state.offset + (now - state.startedAt);
      if (t >= timeline.duration) {
        timeRef.current = timeline.duration - 0.01;
        drawAt(timeRef.current);
        stopPreview();
        return;
      }
      timeRef.current = t;
      drawAt(t);
      setPreviewTime(t);
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  };

  // --- Export ---
  const [support, setSupport] = useState<EncodeSupport | null>(null);
  useEffect(() => {
    let alive = true;
    checkSupport()
      .then(s => { if (alive) setSupport(s); })
      .catch(() => { if (alive) setSupport({ ok: false, width: 0, height: 0, reason: '無法確認這台裝置能不能產生影片。' }); });
    return () => { alive = false; };
  }, []);

  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => { if (phase.kind === 'done') URL.revokeObjectURL(phase.url); }, [phase]);

  const generate = async () => {
    if (!support?.ok) return;
    stopPreview();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setPhase({ kind: 'rendering', progress: 0, step: '準備照片' });
      await store.prepare(needed, (done, total) => setPhase({ kind: 'rendering', progress: 0.1 * (done / Math.max(1, total)), step: '準備照片' }), ac.signal);
      if (ac.signal.aborted) return;
      setPhase({ kind: 'rendering', progress: 0.1, step: '合成音樂' });
      const audio = await renderMusic(music, timeline, 48000);
      setPhase({ kind: 'rendering', progress: 0.12, step: '產生影片' });
      const blob = await encodeRecap({
        scene, store, audio, width: support.width, height: support.height, signal: ac.signal,
        onProgress: f => setPhase({ kind: 'rendering', progress: 0.12 + 0.88 * f, step: '產生影片' }),
      });
      setPhase({ kind: 'done', blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      if (ac.signal.aborted) {
        setPhase({ kind: 'setup' });
        return;
      }
      console.error('[recap] export failed', e);
      setPhase({ kind: 'error', message: '產生影片時發生問題。可以再試一次，或減少照片張數。' });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      // Back to the preview's working set
      drawAt(timeRef.current);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setPhase({ kind: 'setup' });
  };

  const canShare = phase.kind === 'done' && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([phase.blob], fileName(trip), { type: 'video/mp4' })] });

  const share = async () => {
    if (phase.kind !== 'done') return;
    try {
      await navigator.share({ files: [new File([phase.blob], fileName(trip), { type: 'video/mp4' })], title: trip.name });
    } catch {
      // Cancelled by the user
    }
  };

  // --- Picker ---
  const togglePick = (path: string) => {
    setPicks(prev => {
      if (prev.includes(path)) return prev.filter(p => p !== path);
      if (prev.length >= MAX_PHOTOS) return prev;
      return [...prev, path];
    });
  };

  const rendering = phase.kind === 'rendering';
  const busy = prepared.done < prepared.total;
  const seconds = Math.round(timeline.duration);

  if (days.length === 0) {
    return (
      <Modal isOpen onClose={onClose} title="回顧影片">
        <div className="text-center py-8 space-y-2">
          <Clapperboard size={34} className="mx-auto text-muted" />
          <p className="font-bold">這趟還沒有商品照片</p>
          <p className="text-sm text-muted">回顧影片用的是相簿裡的照片，先在支出上加幾張照片吧。</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title="回顧影片" maxWidth="sm:max-w-4xl" dirty={rendering}>
      <div className="flex flex-col md:flex-row gap-5">
        {/* Preview / result */}
        <div className="md:w-[300px] shrink-0 flex flex-col items-center gap-3">
          <div className="relative w-[62vw] max-w-[300px] md:w-[300px] aspect-[9/16] rounded-2xl overflow-hidden bg-navy shadow-lg">
            <canvas
              ref={previewRef}
              width={PREVIEW_W}
              height={Math.round((PREVIEW_W * 16) / 9)}
              className={`absolute inset-0 w-full h-full ${phase.kind === 'done' ? 'invisible' : ''}`}
              onClick={() => (playing ? stopPreview() : void startPreview())}
            />
            {phase.kind === 'done' && (
              <video src={phase.url} controls playsInline autoPlay className="absolute inset-0 w-full h-full object-cover bg-black" />
            )}
            {phase.kind !== 'done' && !playing && !rendering && (
              <button
                onClick={() => void startPreview()}
                aria-label="播放預覽"
                className="absolute bottom-4 left-1/2 -translate-x-1/2 w-14 h-14 rounded-full bg-black/45 backdrop-blur text-white flex items-center justify-center"
              >
                <Play size={28} className="ml-1" fill="currentColor" />
              </button>
            )}
            {busy && phase.kind === 'setup' && (
              <span className="absolute top-2.5 left-2.5 text-[11px] text-white bg-black/50 rounded-full px-2.5 py-1 flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />準備照片 <span className="num">{prepared.done}/{prepared.total}</span>
              </span>
            )}
            {rendering && (
              <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-3 text-white">
                <Loader2 size={28} className="animate-spin" />
                <p className="text-sm">{phase.step}…</p>
                <p className="num text-2xl font-bold">{Math.round(phase.progress * 100)}%</p>
              </div>
            )}
          </div>
          {phase.kind === 'setup' && (
            <div className="flex items-center gap-3 text-xs text-muted w-full max-w-[300px]">
              <button onClick={() => (playing ? stopPreview() : void startPreview())} className={ui.iconBtn} aria-label={playing ? '暫停' : '播放'}>
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <div className="flex-1 h-1 rounded-full bg-sunk overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${(playing ? previewTime / timeline.duration : 0) * 100}%` }} />
              </div>
              <span className="num">{seconds} 秒</span>
            </div>
          )}
        </div>

        {/* Options */}
        <div className="flex-1 min-w-0 space-y-5">
          {phase.kind === 'done' ? (
            <div className="space-y-4">
              <div>
                <p className="text-base font-bold">影片做好了</p>
                <p className="text-sm text-muted mt-1">
                  {seconds} 秒、1080×1920 直式 MP4，可以直接發到 IG Reels 或限時動態。
                  {canShare ? '按「分享」可以存到相簿或直接開 IG。' : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2.5">
                {canShare && <button onClick={() => void share()} className={`${ui.btnAccent} py-3 flex-1 min-w-[140px]`}><Share2 size={17} />分享／存到相簿</button>}
                <a href={phase.url} download={fileName(trip)} className={`${canShare ? ui.btnSecondary : ui.btnAccent} py-3 flex-1 min-w-[140px]`}>
                  <Download size={17} />下載 MP4
                </a>
              </div>
              <button onClick={() => setPhase({ kind: 'setup' })} className={`${ui.btnSecondary} w-full`}>
                <RotateCcw size={16} />回去調整
              </button>
            </div>
          ) : (
            <>
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className={ui.label + ' mb-0'}>照片</p>
                  <span className="text-xs text-muted"><span className="num">{picks.length}</span> 張・上限 <span className="num">{MAX_PHOTOS}</span></span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setPickerMode(m => (m === 'photos' ? null : 'photos'))} className={`${ui.btnSecondary} flex-1`} disabled={rendering}>
                    <Check size={16} />{pickerMode === 'photos' ? '收起' : '挑選照片'}
                  </button>
                  <button onClick={() => setPickerMode(m => (m === 'outro' ? null : 'outro'))} className={`${ui.btnSecondary} flex-1`} disabled={rendering}>
                    <Star size={16} />{pickerMode === 'outro' ? '收起' : '結尾合照'}
                  </button>
                </div>
                <p className={ui.hint}>
                  預設每天平均挑 2～4 張。結尾那張建議選大家的合照{outro ? '' : '（還沒選，先用最後一張）'}。
                </p>
                {pickerMode && (
                  <PhotoPicker
                    days={days}
                    mode={pickerMode}
                    picks={picks}
                    outro={outroPhoto?.path ?? null}
                    onToggle={togglePick}
                    onOutro={path => setOutro(path)}
                    onAuto={() => setPicks(autoPick(days))}
                    onClear={() => setPicks([])}
                  />
                )}
              </section>

              <section className="space-y-2">
                <p className={ui.label}>音樂</p>
                <div className="grid grid-cols-3 gap-2">
                  {MUSIC_STYLES.map(s => (
                    <button
                      key={s.key}
                      onClick={() => setMusic(s.key)}
                      disabled={rendering}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${music === s.key ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:bg-sunk'}`}
                    >
                      <span className="block text-sm font-bold">{s.label}</span>
                      <span className="block text-[11px] text-muted mt-0.5 leading-snug">{s.hint}</span>
                    </button>
                  ))}
                </div>
                <p className={ui.hint}>音樂是這台裝置現場合成的原創曲，沒有版權問題，上傳 IG 不會被消音。</p>
              </section>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-3 cursor-pointer">
                <span>
                  <span className="block text-sm font-bold">顯示總花費</span>
                  <span className="block text-xs text-muted mt-0.5">關掉的話統計只顯示天數、筆數與照片數</span>
                </span>
                <input type="checkbox" className="w-5 h-5 accent-[var(--app-accent)]" checked={showMoney} onChange={e => setShowMoney(e.target.checked)} disabled={rendering} />
              </label>

              {phase.kind === 'error' && <p className={ui.errorBox}>{phase.message}</p>}
              {support && !support.ok && <p className={ui.warnBox}>{support.reason}</p>}

              {rendering ? (
                <button onClick={cancel} className={`${ui.btnSecondary} w-full py-3`}>取消</button>
              ) : (
                <button
                  onClick={() => void generate()}
                  disabled={!support?.ok || shots.length === 0}
                  className={`${ui.btnAccent} w-full py-3`}
                >
                  <Sparkles size={17} />產生影片（約 <span className="num">{seconds}</span> 秒）
                </button>
              )}
              <p className={ui.hint + ' text-center'}>
                影片在這台裝置上產生，不會上傳。{support?.ok && support.width < VIDEO_W ? '這台裝置會輸出 720p。' : ''}
                產生期間請停在這個畫面。
              </p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

interface PickerProps {
  days: RecapDay[];
  mode: 'photos' | 'outro';
  picks: string[];
  outro: string | null;
  onToggle: (path: string) => void;
  onOutro: (path: string) => void;
  onAuto: () => void;
  onClear: () => void;
}

const PhotoPicker: React.FC<PickerProps> = ({ days, mode, picks, outro, onToggle, onOutro, onAuto, onClear }) => {
  const picked = new Set(picks);
  return (
    <div className="rounded-xl border border-line bg-sunk p-3 space-y-3 max-h-[46dvh] overflow-y-auto overscroll-contain">
      {mode === 'photos' ? (
        <div className="flex gap-2">
          <button onClick={onAuto} className={`${ui.chip} ${ui.chipOff}`}><Sparkles size={12} className="inline -mt-0.5 mr-1" />自動挑選</button>
          <button onClick={onClear} className={`${ui.chip} ${ui.chipOff}`}>全部取消</button>
        </div>
      ) : (
        <p className="text-xs text-ink-2">點一張當作影片最後一幕。</p>
      )}
      {days.map(day => (
        <div key={day.date}>
          <p className="text-xs font-medium text-ink-2 mb-1.5">
            <span className="num">Day {day.dayNumber}</span>・<span className="num">{day.date.slice(5).replace('-', '/')}</span>
            {day.city ? `・${day.city}` : ''}
          </p>
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-5 gap-1.5">
            {day.photos.map(p => {
              const on = mode === 'photos' ? picked.has(p.path) : outro === p.path;
              const order = mode === 'photos' && on ? picks.indexOf(p.path) : -1;
              return (
                <button
                  key={p.path}
                  onClick={() => (mode === 'photos' ? onToggle(p.path) : onOutro(p.path))}
                  aria-pressed={on}
                  title={p.caption}
                  className={`relative aspect-square rounded-lg overflow-hidden ring-2 transition ${on ? 'ring-accent' : 'ring-transparent opacity-70 hover:opacity-100'}`}
                >
                  <img src={photoUrl(p.path)} alt={p.caption} loading="lazy" className="w-full h-full object-cover" />
                  {on && (
                    <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-accent text-on-accent flex items-center justify-center">
                      {mode === 'outro' ? <Star size={11} fill="currentColor" /> : <Check size={12} strokeWidth={3} />}
                    </span>
                  )}
                  {order >= 0 && <span className="sr-only">第 {order + 1} 張</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

export default RecapVideoModal;
