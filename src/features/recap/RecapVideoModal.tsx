import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Clapperboard, Download, Eye, ImagePlus, Loader2, Pause, Play, Square, Receipt, RotateCcw, Share2, Sparkles, Star } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { Expense, Trip } from '../../types';
import { useBackClose } from '../../hooks/useBackClose';
import Modal from '../../components/Modal';
import { ui } from '../../components/ui';
import { photoUrl } from '../../utils/storage';
import { formatMoney } from '../../utils/money';
import { getItinerary, isPlan } from '../itinerary/registry';
import {
  MAX_PHOTOS, autoPick, buildTimeline, daysBetween, recapDays, shotsFromPicks, tripDateRange,
  type DayMeta, type ExtraSection, type RecapDay, type RecapPhoto, type Timeline,
} from './plan';
import {
  MAX_FACTS, MAX_STATS, peopleSpending, recapFacts, recapStats, spendingRace, visitedCities,
  type RecapFact, type RecapStat,
} from './facts';
import { MUSIC_STYLES, renderMusic, renderSample, styleBpm, type MusicStyle } from './music';
import { PhotoStore, loadOwnOutro, readLocalPhoto, saveOwnOutro } from './images';
import { RecapRenderer, VIDEO_W, ensureFonts, pathsNear, photoLabelLines, type RecapContent, type RecapScene } from './render';
import { checkSupport, dayTexts, encodeRecap, type EncodeSupport } from './encode';

interface Props {
  trip: Trip;
  expenses: Expense[];
  onClose: () => void;
}

interface Saved {
  picks?: string[];
  outro?: string | null;
  music?: MusicStyle;
  showMoney?: boolean;
  sections?: ExtraSection[];
  /** Picked fun facts and numbers by key; missing = the defaults */
  facts?: string[];
  stats?: string[];
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
/** Saved in place of the path when the closing photo is the one uploaded from this device */
const LOCAL_OUTRO = 'local';

const SECTION_OPTIONS: { key: ExtraSection; label: string; hint: string }[] = [
  { key: 'stats', label: '統計數字', hint: '天數、筆數、照片數、總花費…' },
  { key: 'facts', label: '旅途小彩蛋', hint: '最貴的一筆、誰最常掏錢、最常光顧…' },
  { key: 'people', label: '每個人的花錢重點', hint: '每個人錢花最多的分類' },
  { key: 'race', label: '花費賽跑', hint: '每個人的累積花費一天天長出來' },
];

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
const RecapVideoModal: React.FC<Props> = ({ trip, expenses, onClose }) => {
  const saved = useMemo(() => readSaved(trip.id), [trip.id]);

  // --- Story data ---
  const { days, range, cities } = useMemo(() => {
    const entry = getItinerary(trip.id);
    const m: DayMeta[] = entry && isPlan(entry) ? entry.days.map(d => ({ date: d.date, city: d.city, title: d.title })) : [];
    const r = tripDateRange(expenses, m.map(x => x.date));
    return { days: r ? recapDays(expenses, r, m) : [], range: r, cities: visitedCities(m.map(x => x.city)) };
  }, [trip.id, expenses]);

  // A closing photo picked from this device (e.g. the group shot from someone's camera):
  // kept in memory only, never uploaded, gone after closing
  const [ownOutro, setOwnOutro] = useState<{ photo: RecapPhoto; url: string } | null>(null);
  useEffect(() => () => { if (ownOutro) URL.revokeObjectURL(ownOutro.url); }, [ownOutro]);
  const allPhotos = useMemo(() => days.flatMap(d => d.photos), [days]);
  // Counts and fun facts are about the trip's photos, not its receipts
  const itemDays = useMemo(
    () => days.map(d => ({ ...d, photos: d.photos.filter(p => p.kind === 'item') })).filter(d => d.photos.length > 0),
    [days],
  );
  const itemCount = useMemo(() => itemDays.reduce<number>((n, d) => n + d.photos.length, 0), [itemDays]);
  const known = useMemo(() => new Set(allPhotos.map(p => p.path)), [allPhotos]);

  const [picks, setPicks] = useState<string[]>(() => {
    const kept = (saved.picks ?? []).filter(p => known.has(p));
    return kept.length > 0 ? kept : autoPick(days);
  });
  const [outro, setOutro] = useState<string | null>(() => (saved.outro && known.has(saved.outro) ? saved.outro : null));
  const [music, setMusic] = useState<MusicStyle>(saved.music ?? 'bright');
  const [showMoney, setShowMoney] = useState(saved.showMoney ?? true);
  const [sections, setSections] = useState<ExtraSection[]>(saved.sections ?? ['stats', 'facts']);
  const [factKeys, setFactKeys] = useState<string[] | null>(saved.facts ?? null);
  const [statKeys, setStatKeys] = useState<string[] | null>(saved.stats ?? null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const toggleSection = (key: ExtraSection) =>
    setSections(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  const [pickerMode, setPickerMode] = useState<'photos' | 'outro' | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(trip.id), JSON.stringify({
        picks, outro: outro?.startsWith('local:') ? LOCAL_OUTRO : outro,
        music, showMoney, sections, facts: factKeys ?? undefined, stats: statKeys ?? undefined,
      } satisfies Saved));
    } catch {
      // Private mode: the choices last only this visit
    }
  }, [trip.id, picks, outro, music, showMoney, sections, factKeys, statKeys]);

  // The closing photo is saved for the end, not shown twice
  // Photos that could not be read are left out rather than shown as a black frame
  const shots = useMemo(() => shotsFromPicks(days, picks.filter(p => p !== outro && !failed.has(p))), [days, picks, outro, failed]);
  const outroPhoto: RecapPhoto | null = useMemo(() => {
    if (ownOutro && outro === ownOutro.photo.path && !failed.has(outro)) return ownOutro.photo;
    const chosen = allPhotos.find(p => p.path === outro && !failed.has(p.path));
    return chosen ?? shots[shots.length - 1]?.photo ?? null;
  }, [allPhotos, outro, shots, failed, ownOutro]);

  // A video doesn't need "¥8,850.00": whole amounts drop their zero decimals
  const money = useMemo(
    () => (showMoney ? (amount: number, currency: string) => formatMoney(amount, currency, trip.precision_config).replace(/\.0+$/, '') : null),
    [showMoney, trip.precision_config],
  );

  const allFacts: RecapFact[] = useMemo(() => (range ? recapFacts({
    expenses, range, days: itemDays, members: trip.members, baseCurrency: trip.base_currency, rates: trip.rates, money, cities,
    timeZone: trip.timezone,
  }) : []), [expenses, range, itemDays, trip, money, cities]);
  const facts = useMemo(
    () => allFacts.filter(f => (factKeys ? factKeys.includes(f.key) : f.defaultOn)).slice(0, MAX_FACTS),
    [allFacts, factKeys],
  );

  const allStats: RecapStat[] = useMemo(() => (range ? recapStats({
    expenses, range, members: trip.members, baseCurrency: trip.base_currency, rates: trip.rates, money, photoCount: itemCount,
    currencyPrefix: formatMoney(0, trip.base_currency, trip.precision_config).replace(/[\d.,\s-]/g, '') || trip.base_currency,
  }) : []), [expenses, range, trip, money, itemCount]);
  const statList = useMemo(
    () => allStats.filter(st => (statKeys ? statKeys.includes(st.key) : st.defaultOn)).slice(0, MAX_STATS),
    [allStats, statKeys],
  );

  const people = useMemo(() => peopleSpending(expenses, trip.members, trip.rates, trip.base_currency), [expenses, trip]);

  const race = useMemo(
    () => (range ? spendingRace(expenses, range, trip.members, trip.rates, trip.base_currency) : null),
    [expenses, range, trip],
  );
  // Only pages that have something to show
  const available = useMemo(() => SECTION_OPTIONS.filter(o => (
    o.key === 'facts' ? allFacts.length > 0 : o.key === 'race' ? !!race : o.key === 'people' ? !!people : allStats.length > 0
  )), [allFacts.length, race, people, allStats.length]);
  // A page with nothing ticked is skipped
  const activeSections = useMemo(() => sections.filter(k => available.some(o => o.key === k)
    && !(k === 'facts' && facts.length === 0) && !(k === 'stats' && statList.length === 0)), [sections, available, facts.length, statList.length]);

  const timeline = useMemo(
    () => buildTimeline(shots, styleBpm(music), outroPhoto, activeSections),
    [shots, music, outroPhoto, activeSections],
  );

  const content: RecapContent = useMemo(() => {
    const from = range?.from ?? '';
    const to = range?.to ?? '';
    const dateLabel = from
      ? `${from.replace(/-/g, '.')} — ${from.slice(0, 4) === to.slice(0, 4) ? to.slice(5).replace('-', '.') : to.replace(/-/g, '.')}`
      : '';
    return {
      tripName: trip.name, dateLabel, members: trip.members, stats: statList, facts, race, people,
      tripDays: range ? daysBetween(range.from, range.to) + 1 : undefined,
      raceMoney: money ? (n: number) => money(n, trip.base_currency) : undefined,
      amountLabel: money ? (p: RecapPhoto) => (p.amount > 0 ? money(p.amount, p.currency) : null) : undefined,
    };
  }, [range, statList, trip, facts, race, people, money]);

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
      .then(() => {
        if (ac.signal.aborted) return;
        setFailed(prev => {
          const next = store.failedPaths();
          return next.size === prev.size && [...next].every(p => prev.has(p)) ? prev : next;
        });
        setStoreVersion(v => v + 1);
      });
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

  // While the video is being made the encoder owns the decoded photos: the preview must not evict them
  const encodingRef = useRef(false);
  const drawAt = useCallback((t: number) => {
    const r = rendererRef.current;
    if (!r || encodingRef.current) return;
    void store.keepOnly(pathsNear(scene.timeline, t, 2.5)).then(() => {
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

  // --- Music audition: hear a style without making a video ---
  const [audition, setAudition] = useState<{ style: MusicStyle; loading: boolean } | null>(null);
  const auditionRef = useRef<AudioContext | null>(null);
  const sampleCache = useRef(new Map<MusicStyle, Promise<AudioBuffer | null>>());
  const stopAudition = useCallback(() => {
    const ctx = auditionRef.current;
    auditionRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);
    setAudition(null);
  }, []);
  useEffect(() => stopAudition, [stopAudition]);
  const playAudition = async (style: MusicStyle) => {
    if (audition?.style === style) {
      stopAudition();
      return;
    }
    stopAudition();
    // Created inside the tap, like the preview: phones keep a later one silent
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    void ctx.resume().catch(() => undefined);
    auditionRef.current = ctx;
    setAudition({ style, loading: true });
    let sample = sampleCache.current.get(style);
    if (!sample) {
      sample = renderSample(style).catch(() => null);
      sampleCache.current.set(style, sample);
    }
    const buffer = await sample;
    if (auditionRef.current !== ctx) return;
    if (!buffer) {
      stopAudition();
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => { if (auditionRef.current === ctx) stopAudition(); };
    src.start();
    setAudition({ style, loading: false });
  };

  const [previewLoading, setPreviewLoading] = useState(false);
  // Synthesising the track takes a few seconds on a phone: do it in the background once the
  // choices settle, so pressing play starts right away
  const musicCache = useRef<{ timeline: Timeline; music: MusicStyle; buffer: Promise<AudioBuffer | null> } | null>(null);
  const previewMusic = useCallback(() => {
    const c = musicCache.current;
    if (c && c.timeline === timeline && c.music === music) return c.buffer;
    const buffer = renderMusic(music, timeline, 22050).catch(() => null);
    musicCache.current = { timeline, music, buffer };
    return buffer;
  }, [timeline, music]);
  useEffect(() => {
    if (music === 'none') return;
    const timer = setTimeout(() => { void previewMusic(); }, 1200);
    return () => clearTimeout(timer);
  }, [music, previewMusic]);
  const startPreview = async () => {
    if (previewLoading) return;
    stopPreview();
    stopAudition();
    const from = timeRef.current >= timeline.duration - 0.1 || timeRef.current === posterTime ? 0 : timeRef.current;
    // The AudioContext must be created and resumed inside the tap itself: phones keep one made after an
    // await suspended, its clock never moves, and the preview just sat there (David 2026-11-24)
    let ctx: AudioContext | null = null;
    let resumed: Promise<void> = Promise.resolve();
    if (music !== 'none') {
      try {
        ctx = new AudioContext();
        resumed = ctx.resume();
      } catch {
        ctx = null;
      }
    }
    setPreviewLoading(true);
    try {
      // Decode the opening photos before the clock starts, so playback doesn't begin on blurry placeholders
      const opening = store.keepOnly(pathsNear(timeline, from, 3));
      const buffer = ctx ? await previewMusic() : null;
      await opening;
      // resume() can stay pending forever when the browser refuses sound; don't wait on it for long
      await Promise.race([resumed.catch(() => undefined), new Promise(r => setTimeout(r, 600))]);
      if (ctx && buffer && ctx.state === 'running') {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(0, from);
      } else if (ctx) {
        // No sound possible: still play the pictures on the wall clock
        void ctx.close();
        ctx = null;
      }
    } catch (e) {
      console.warn('[recap] preview audio failed', e);
      if (ctx) void ctx.close();
      ctx = null;
    } finally {
      setPreviewLoading(false);
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
    stopAudition();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      encodingRef.current = true;
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
      encodingRef.current = false;
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

  // The closing photo can come from this device: kept in memory, used only as the last scene
  const fileInput = useRef<HTMLInputElement>(null);
  const [outroUpload, setOutroUpload] = useState<'idle' | 'reading' | 'error'>('idle');
  const registerOwnOutro = useCallback((blob: Blob, select: boolean) => {
    const path = `local:${Date.now().toString(36)}`;
    store.addLocal(path, blob);
    setOwnOutro({ photo: { path, date: range?.to ?? '', caption: '', amount: 0, currency: '', kind: 'item' }, url: URL.createObjectURL(blob) });
    if (select) setOutro(path);
  }, [store, range]);

  // Bring back the closing photo uploaded last time (kept in this browser only)
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void loadOwnOutro(trip.id).then(blob => {
      if (blob) registerOwnOutro(blob, saved.outro === LOCAL_OUTRO);
    });
  }, [trip.id, registerOwnOutro, saved.outro]);
  const pickOwnOutro = async (file: File | undefined) => {
    if (!file) return;
    setOutroUpload('reading');
    try {
      const readable = await readLocalPhoto(file);
      registerOwnOutro(readable, true);
      void saveOwnOutro(trip.id, readable);
      setOutroUpload('idle');
    } catch (e) {
      console.warn('[recap] closing photo unreadable', e);
      setOutroUpload('error');
    }
  };

  // Jump the main preview to a photo (from the picker's detail view)
  const shotTime = (path: string) => {
    const seg = timeline.segments.find(sg => sg.kind === 'shot' && sg.photo.path === path)
      ?? (outroPhoto?.path === path ? timeline.segments.find(sg => sg.kind === 'outro') : undefined);
    return seg ? seg.start + Math.min(1.2, (seg.end - seg.start) * 0.6) : null;
  };
  const describe = (photo: RecapPhoto, day: RecapDay) => photoLabelLines(photo, day, content);
  const ensureFrame = useCallback((t: number) => store.keepOnly(pathsNear(timeline, t, 0.5)), [store, timeline]);

  const toggleKey = (current: string[] | null, defaults: string[], key: string, max: number): string[] => {
    const base = current ?? defaults;
    if (base.includes(key)) return base.filter(k => k !== key);
    return base.length >= max ? base : [...base, key];
  };

  const rendering = phase.kind === 'rendering';
  const busy = prepared.done < prepared.total;
  const skipped = picks.filter(p => failed.has(p)).length;
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
                disabled={previewLoading}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 w-14 h-14 rounded-full bg-black/45 backdrop-blur text-white flex items-center justify-center"
              >
                {previewLoading ? <Loader2 size={26} className="animate-spin" /> : <Play size={28} className="ml-1" fill="currentColor" />}
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
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={e => { void pickOwnOutro(e.target.files?.[0]); e.target.value = ''; }}
                  />
                </div>
                <p className={ui.hint}>
                  預設從整趟照片裡平均挑，照片多的日子多挑一些；每張會配上日期、品名與地點。收據也能勾進來。
                  結尾那張建議選大家的合照，也可以從手機上傳一張{outro ? '' : '（還沒選，先用最後一張）'}。
                </p>
                {skipped > 0 && <p className={ui.warnBox}>有 <span className="num">{skipped}</span> 張照片讀不到，影片會先略過它們。</p>}
                {pickerMode && (
                  <PhotoPicker
                    days={days}
                    mode={pickerMode}
                    picks={picks}
                    outro={outroPhoto?.path ?? null}
                    onToggle={togglePick}
                    onOutro={path => setOutro(path)}
                    ownOutro={ownOutro}
                    outroUpload={outroUpload}
                    onUploadOutro={() => fileInput.current?.click()}
                    describe={describe}
                    timeOf={shotTime}
                    scene={scene}
                    ensure={ensureFrame}
                    onAuto={() => setPicks(autoPick(days))}
                    onClear={() => setPicks([])}
                  />
                )}
              </section>

              <section className="space-y-2">
                <p className={ui.label}>音樂</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {MUSIC_STYLES.map(s => {
                    const hearing = audition?.style === s.key;
                    return (
                      <div key={s.key} className="relative">
                        <button
                          onClick={() => setMusic(s.key)}
                          disabled={rendering}
                          aria-pressed={music === s.key}
                          className={`w-full h-full rounded-xl border pl-3 pr-9 py-2.5 text-left transition-colors ${music === s.key ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:bg-sunk'}`}
                        >
                          <span className="block text-sm font-bold">{s.label}</span>
                          <span className="block text-[11px] text-muted mt-0.5 leading-snug">{s.hint}</span>
                        </button>
                        {s.key !== 'none' && (
                          <button
                            onClick={() => void playAudition(s.key)}
                            disabled={rendering}
                            aria-label={hearing ? `停止試聽「${s.label}」` : `試聽「${s.label}」`}
                            className={`absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-colors ${hearing ? 'bg-accent text-on-accent' : 'bg-sunk text-ink-2 hover:text-ink'}`}
                          >
                            {hearing && audition?.loading
                              ? <Loader2 size={13} className="animate-spin" />
                              : hearing ? <Square size={11} fill="currentColor" /> : <Play size={13} className="ml-0.5" fill="currentColor" />}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className={ui.hint}>按 ▶ 可以先試聽一小段。音樂是這台裝置現場合成的原創曲，沒有版權問題，上傳 IG 不會被消音。</p>
              </section>

              <section className="space-y-2">
                <p className={ui.label}>照片之後放哪些段落</p>
                <p className={ui.hint}>開越多段，照片的部分會切得越快（每張至少兩拍）；預設兩段大約 40 幾秒。</p>
                <div className="space-y-1.5">
                  {available.map(o => {
                    const on = sections.includes(o.key);
                    const items = o.key === 'facts'
                      ? allFacts.map(f => ({ key: f.key, label: f.label, preview: f.value, defaultOn: f.defaultOn }))
                      : o.key === 'stats'
                        ? allStats.map(st => ({ key: st.key, label: st.label, preview: `${st.prefix ?? ''}${typeof st.value === 'number' ? st.value.toLocaleString('en-US') : st.value}${st.suffix ?? ''}`, defaultOn: st.defaultOn }))
                        : [];
                    const chosen = o.key === 'facts' ? facts.map(f => f.key) : statList.map(st => st.key);
                    const max = o.key === 'facts' ? MAX_FACTS : MAX_STATS;
                    const setKeys = o.key === 'facts' ? setFactKeys : setStatKeys;
                    const current = o.key === 'facts' ? factKeys : statKeys;
                    return (
                      <div key={o.key} className="space-y-1.5">
                      <button
                        key={o.key}
                        onClick={() => toggleSection(o.key)}
                        disabled={rendering}
                        aria-pressed={on}
                        className={`w-full flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${on ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:bg-sunk'}`}
                      >
                        <span className={`w-5 h-5 shrink-0 rounded-md border flex items-center justify-center ${on ? 'bg-accent border-accent text-on-accent' : 'border-line'}`}>
                          {on && <Check size={13} strokeWidth={3} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-bold">{o.label}</span>
                          <span className="block text-xs text-muted mt-0.5 truncate">{o.hint}</span>
                        </span>
                      </button>
                      {on && items.length > 0 && (
                        <div className="ml-8 rounded-xl bg-sunk border border-line p-1.5">
                          <p className="text-[11px] text-muted px-2 pt-1 pb-1.5">挑要放的項目（最多 <span className="num">{max}</span> 項）</p>
                          {items.map(item => {
                            const picked = chosen.includes(item.key);
                            const full = !picked && chosen.length >= max;
                            return (
                              <button
                                key={item.key}
                                onClick={() => setKeys(toggleKey(current, items.filter(x => x.defaultOn).map(x => x.key), item.key, max))}
                                disabled={rendering || full}
                                aria-pressed={picked}
                                className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface disabled:opacity-40 transition-colors"
                              >
                                <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center ${picked ? 'bg-accent border-accent text-on-accent' : 'border-line bg-surface'}`}>
                                  {picked && <Check size={11} strokeWidth={3} />}
                                </span>
                                <span className="text-xs text-ink-2 shrink-0">{item.label}</span>
                                <span className="text-xs font-bold truncate">{item.preview}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-3 cursor-pointer">
                <span>
                  <span className="block text-sm font-bold">顯示金額</span>
                  <span className="block text-xs text-muted mt-0.5">照片旁的價格、總花費、小彩蛋與賽跑的金額；關掉就都不顯示</span>
                </span>
                <input type="checkbox" className="w-5 h-5 accent-[var(--app-accent)]" checked={showMoney} onChange={e => setShowMoney(e.target.checked)} disabled={rendering} />
              </label>

              {phase.kind === 'error' && <p className={ui.errorBox}>{phase.message}</p>}
              {support && !support.ok && <p className={ui.warnBox}>{support.reason}</p>}

              {rendering ? (
                <div className="rounded-xl border border-line bg-sunk px-3.5 py-3 space-y-2.5" role="status" aria-live="polite">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-bold"><Loader2 size={16} className="animate-spin" />{phase.step}…</span>
                    <span className="num font-bold">{Math.round(phase.progress * 100)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-line overflow-hidden">
                    <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, phase.progress * 100)}%` }} />
                  </div>
                  <button onClick={cancel} className={`${ui.btnSecondary} w-full`}>取消</button>
                </div>
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
  /** The closing photo uploaded from this device, if any */
  ownOutro: { photo: RecapPhoto; url: string } | null;
  outroUpload: 'idle' | 'reading' | 'error';
  onUploadOutro: () => void;
  /** The caption lines the photo gets in the video */
  describe: (photo: RecapPhoto, day: RecapDay) => [string, string, string];
  /** Where the photo plays in the video, or null when it isn't in it */
  timeOf: (path: string) => number | null;
  scene: RecapScene;
  ensure: (t: number) => Promise<void>;
  onAuto: () => void;
  onClear: () => void;
}

const PhotoPicker: React.FC<PickerProps> = ({
  days, mode, picks, outro, ownOutro, outroUpload, onUploadOutro, describe, timeOf, scene, ensure, onToggle, onOutro, onAuto, onClear,
}) => {
  const picked = new Set(picks);
  const [inspect, setInspect] = useState<{ photo: RecapPhoto; day: RecapDay } | null>(null);
  const receiptCount = days.reduce<number>((n, d) => n + d.photos.filter(p => p.kind === 'receipt').length, 0);
  // Receipts can go in too, but there are usually many: hidden until asked for (or one is already picked)
  const [withReceipts, setWithReceipts] = useState(() => days.some(d => d.photos.some(p => p.kind === 'receipt' && picked.has(p.path))));
  const shown = days
    .map(d => ({ ...d, photos: d.photos.filter(p => withReceipts || p.kind === 'item') }))
    .filter(d => d.photos.length > 0);
  return (
    <div className="rounded-xl border border-line bg-sunk p-3 space-y-3 max-h-[46dvh] overflow-y-auto overscroll-contain">
      {mode === 'photos' ? (
        <div className="flex gap-2">
          <button onClick={onAuto} className={`${ui.chip} ${ui.chipOff}`}><Sparkles size={12} className="inline -mt-0.5 mr-1" />自動挑選</button>
          <button onClick={onClear} className={`${ui.chip} ${ui.chipOff}`}>全部取消</button>
          {receiptCount > 0 && (
            <button
              onClick={() => setWithReceipts(v => !v)}
              aria-pressed={withReceipts}
              className={`${ui.chip} ${withReceipts ? ui.chipOn : ui.chipOff} ml-auto`}
            >
              <Receipt size={12} className="inline -mt-0.5 mr-1" />收據 <span className="num">{receiptCount}</span>
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-xs text-ink-2 flex-1">點一張當作影片最後一幕，或從手機上傳一張（不會存到旅程裡）。</p>
          {ownOutro && (
            <button
              onClick={() => onOutro(ownOutro.photo.path)}
              aria-pressed={outro === ownOutro.photo.path}
              className={`relative w-12 h-12 shrink-0 rounded-lg overflow-hidden ring-2 ${outro === ownOutro.photo.path ? 'ring-accent' : 'ring-transparent opacity-70'}`}
              title="上傳的照片"
            >
              <img src={ownOutro.url} alt="上傳的結尾照片" className="w-full h-full object-cover" />
            </button>
          )}
          <button onClick={onUploadOutro} disabled={outroUpload === 'reading'} className={`${ui.chip} ${ui.chipOff} shrink-0`}>
            {outroUpload === 'reading'
              ? <><Loader2 size={12} className="inline -mt-0.5 mr-1 animate-spin" />讀取中</>
              : <><ImagePlus size={12} className="inline -mt-0.5 mr-1" />{ownOutro ? '換一張' : '上傳'}</>}
          </button>
        </div>
      )}
      {mode === 'outro' && outroUpload === 'error' && (
        <p className={ui.errorBox}>這張照片讀不出來，請換一張（JPEG、PNG、HEIC 都可以）。</p>
      )}
      {inspect && <PhotoDetail photo={inspect.photo} day={inspect.day} lines={describe(inspect.photo, inspect.day)} time={timeOf(inspect.photo.path)} scene={scene} ensure={ensure} onClose={() => setInspect(null)} />}
      {shown.map(day => (
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
                <div key={p.path} className="relative">
                <button
                  onClick={() => (mode === 'photos' ? onToggle(p.path) : onOutro(p.path))}
                  aria-pressed={on}
                  title={p.caption}
                  className={`relative block w-full aspect-square rounded-lg overflow-hidden ring-2 transition ${on ? 'ring-accent' : 'ring-transparent opacity-70 hover:opacity-100'}`}
                >
                  <img src={photoUrl(p.path)} alt={p.caption} loading="lazy" className="w-full h-full object-cover" />
                  {on && (
                    <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-accent text-on-accent flex items-center justify-center">
                      {mode === 'outro' ? <Star size={11} fill="currentColor" /> : <Check size={12} strokeWidth={3} />}
                    </span>
                  )}
                  {p.kind === 'receipt' && (
                    <span className="absolute bottom-1 left-1 text-[10px] leading-none text-white bg-black/60 rounded px-1 py-0.5">收據</span>
                  )}
                  {order >= 0 && <span className="sr-only">第 {order + 1} 張</span>}
                </button>
                <button
                  onClick={() => setInspect({ photo: p, day })}
                  aria-label={`看「${p.caption || '這張照片'}」在影片裡的樣子`}
                  className="absolute top-1 left-1 w-6 h-6 rounded-full bg-black/55 text-white flex items-center justify-center"
                >
                  <Eye size={13} />
                </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

interface DetailProps {
  photo: RecapPhoto;
  day: RecapDay;
  lines: [string, string, string];
  time: number | null;
  scene: RecapScene;
  ensure: (t: number) => Promise<void>;
  onClose: () => void;
}

/**
 * 挑照片時看「這張在影片裡會長怎樣」：已選的照片直接畫出影片那一格，
 * 還沒選的顯示照片與影片會配的三行字，下面附上帳目原本的描述與金額。
 */
const PhotoDetail: React.FC<DetailProps> = ({ photo, lines, time, scene, ensure, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || time === null) return;
    const renderer = new RecapRenderer(canvas, scene);
    let alive = true;
    renderer.draw(time);
    // Decode the photo, then draw the real frame
    void ensure(time).then(() => { if (alive) renderer.draw(time); });
    return () => { alive = false; renderer.dispose(); };
  }, [time, scene, ensure]);
  // A layer of its own over everything (back button closes it first), so it shows wherever the list is scrolled
  useBackClose(true, onClose);
  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-scrim anim-fade flex items-end sm:items-center justify-center sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="這張照片在影片裡的樣子"
    >
      <div className="w-full sm:max-w-md bg-surface text-ink rounded-t-3xl sm:rounded-2xl shadow-2xl anim-sheet px-5 pt-4 pb-[max(20px,env(safe-area-inset-bottom))] sm:pb-5 space-y-3">
        <div className="flex items-center gap-2">
          <p className="flex-1 font-bold text-base">影片裡會顯示</p>
          <button onClick={onClose} className={ui.iconBtn} aria-label="關閉">✕</button>
        </div>
        <div className="flex gap-4">
          <div className="w-[150px] shrink-0 aspect-[9/16] rounded-xl overflow-hidden bg-navy relative shadow">
            {time !== null ? (
              <canvas ref={canvasRef} width={300} height={534} className="absolute inset-0 w-full h-full" />
            ) : (
              <img src={photoUrl(photo.path)} alt={photo.caption} className="absolute inset-0 w-full h-full object-cover" />
            )}
          </div>
          <div className="flex-1 min-w-0 space-y-2 text-xs">
            <div className="rounded-lg bg-navy text-navy-fg px-3 py-2.5 space-y-0.5">
              <p className="num text-[10px] tracking-wider text-accent">{lines[0]}</p>
              <p className="font-bold text-sm leading-snug break-words">{lines[1]}</p>
              {lines[2] && <p className="text-navy-sub">{lines[2]}</p>}
            </div>
            {photo.description && photo.description !== photo.caption && (
              <p className="text-ink-2 break-words">帳目：{photo.description}</p>
            )}
            <p className="text-muted">
              {time !== null ? <>在影片第 <span className="num">{Math.floor(time)}</span> 秒左右出現</> : '還沒選進影片，勾選後就會出現'}
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default RecapVideoModal;
