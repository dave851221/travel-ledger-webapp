import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';

interface Props {
  /** Full URLs, in viewing order */
  photos: string[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  alt?: string;
  /** Shown under the photo (the album puts the expense and a 明細 button here) */
  footer?: React.ReactNode;
}

type View = { s: number; x: number; y: number };
type Mode = 'none' | 'pending' | 'pan' | 'swipe' | 'dismiss' | 'pinch';

const IDENTITY: View = { s: 1, x: 0, y: 0 };
const GAP = 16;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
// Gesture-driven, so it ignores prefers-reduced-motion like phone galleries do
const duration = 260;

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * 全螢幕看照片，手勢比照手機相簿：
 * - 左右滑換張（跟手滑動、放開後滑到定位），方向鍵、左右按鈕也有同樣的動畫
 * - 雙指縮放、點兩下放大／縮小；放大後單指拖曳移動
 * - 點一下不會縮放：點畫面左／右三成換上一張／下一張，點中間照片外的黑底或往下滑關閉
 * - 電腦：點照片放大／縮小、滾輪縮放、拖曳移動，右上角按鈕也能縮放
 * 相簿與支出明細共用這一個。
 */
const PhotoLightbox: React.FC<Props> = ({ photos, index, onIndex, onClose, alt = '', footer }) => {
  const n = photos.length;
  const many = n > 1;

  // Virtual (unbounded) position: slides are keyed by it, so after a swipe the
  // neighbour that slid in stays the same <img> element and never flashes.
  const [v, setV] = useState(index);
  if (mod(v, n) !== index) setV(index);

  const [view, setView] = useState<View>(IDENTITY);
  const [viewAnim, setViewAnim] = useState(false);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragAnim, setDragAnim] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef<View>(IDENTITY);
  const indexRef = useRef(index);
  useEffect(() => { indexRef.current = index; }, [index]);
  const busy = useRef(false);
  const timers = useRef<number[]>([]);
  const tapTimer = useRef<number | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const g = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    mode: 'none' as Mode,
    startX: 0, startY: 0, startView: IDENTITY,
    pinchDist: 1, pinchMid: { x: 0, y: 0 },
    onImage: false, pointerType: '',
    lastX: 0, lastY: 0, lastT: 0, vx: 0, vy: 0,
  });

  const zoomed = view.s > 1.01;

  useBackClose(true, onClose);

  useEffect(() => () => {
    timers.current.forEach(t => clearTimeout(t));
    if (tapTimer.current) clearTimeout(tapTimer.current);
  }, []);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const stageBox = () => {
    const r = stageRef.current?.getBoundingClientRect();
    return r
      ? { w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
      : { w: window.innerWidth, h: window.innerHeight, cx: window.innerWidth / 2, cy: window.innerHeight / 2 };
  };

  /** Keep a zoomed photo from being dragged off-screen */
  const clamp = (vw: View): View => {
    if (vw.s <= 1) return { s: vw.s, x: 0, y: 0 };
    const { w, h } = stageBox();
    const iw = imgRef.current?.offsetWidth ?? w;
    const ih = imgRef.current?.offsetHeight ?? h;
    const mx = Math.max(0, (iw * vw.s - w) / 2);
    const my = Math.max(0, (ih * vw.s - h) / 2);
    return { s: vw.s, x: Math.min(mx, Math.max(-mx, vw.x)), y: Math.min(my, Math.max(-my, vw.y)) };
  };

  const applyView = (next: View, animate: boolean) => {
    viewRef.current = next;
    setViewAnim(animate);
    setView(next);
  };

  /** Zoom so the point under (clientX, clientY) stays put */
  const zoomTo = (s: number, clientX: number, clientY: number, from: View, animate: boolean) => {
    const { cx, cy } = stageBox();
    const px = clientX - cx, py = clientY - cy;
    const ix = (px - from.x) / from.s, iy = (py - from.y) / from.s;
    applyView(s <= 1.01 ? IDENTITY : clamp({ s, x: px - ix * s, y: py - iy * s }), animate);
  };

  const toggleZoomAt = (clientX: number, clientY: number) => {
    if (viewRef.current.s > 1.01) applyView(IDENTITY, true);
    else zoomTo(DOUBLE_TAP_SCALE, clientX, clientY, IDENTITY, true);
  };

  const snapBack = () => {
    setDragAnim(true);
    setDrag({ x: 0, y: 0 });
    later(() => setDragAnim(false), duration);
  };

  /** Slide to the next (1) or previous (-1) photo */
  const go = useCallback((dir: number) => {
    if (busy.current || n < 2) return;
    busy.current = true;
    const w = stageRef.current?.clientWidth ?? window.innerWidth;
    setDragAnim(true);
    setDrag({ x: -dir * (w + GAP), y: 0 });
    timers.current.push(window.setTimeout(() => {
      setDragAnim(false);
      setDrag({ x: 0, y: 0 });
      viewRef.current = IDENTITY;
      setViewAnim(false);
      setView(IDENTITY);
      setV(x => x + dir);
      onIndex(mod(indexRef.current + dir, n));
      busy.current = false;
    }, duration));
  }, [n, onIndex]);

  const dismiss = () => {
    busy.current = true;
    setDragAnim(true);
    setDrag({ x: 0, y: stageBox().h });
    later(onClose, Math.min(duration, 180));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && many) go(-1);
      else if (e.key === 'ArrowRight' && many) go(1);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [go, many, onClose]);

  const pinchInfo = () => {
    const [a, b] = [...g.current.pointers.values()];
    const { cx, cy } = stageBox();
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2 - cx, y: (a.y + b.y) / 2 - cy },
    };
  };

  const startSingle = (x: number, y: number) => {
    const s = g.current;
    s.startX = s.lastX = x;
    s.startY = s.lastY = y;
    s.lastT = performance.now();
    s.vx = s.vy = 0;
    s.startView = viewRef.current;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button')) return;
    if (busy.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const s = g.current;
    try { stageRef.current?.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.pointers.size === 1) {
      s.mode = 'pending';
      s.onImage = e.target === imgRef.current;
      s.pointerType = e.pointerType;
      startSingle(e.clientX, e.clientY);
    } else if (s.pointers.size === 2) {
      if (s.mode === 'swipe' || s.mode === 'dismiss') snapBack();
      s.mode = 'pinch';
      const { dist, mid } = pinchInfo();
      s.pinchDist = dist;
      s.pinchMid = mid;
      s.startView = viewRef.current;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s.pointers.has(e.pointerId)) return;
    s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (s.mode === 'pinch') {
      if (s.pointers.size < 2) return;
      const { dist, mid } = pinchInfo();
      const sv = s.startView;
      const scale = Math.min(MAX_SCALE, Math.max(0.6, sv.s * dist / s.pinchDist));
      const ix = (s.pinchMid.x - sv.x) / sv.s, iy = (s.pinchMid.y - sv.y) / sv.s;
      applyView(clamp({ s: scale, x: mid.x - ix * scale, y: mid.y - iy * scale }), false);
      return;
    }

    const now = performance.now();
    const dt = now - s.lastT;
    if (dt > 0) {
      s.vx = (e.clientX - s.lastX) / dt;
      s.vy = (e.clientY - s.lastY) / dt;
    }
    s.lastX = e.clientX; s.lastY = e.clientY; s.lastT = now;
    const dx = e.clientX - s.startX, dy = e.clientY - s.startY;

    if (s.mode === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      if (viewRef.current.s > 1.01) s.mode = 'pan';
      else if (Math.abs(dx) > Math.abs(dy)) s.mode = 'swipe';
      else if (dy > 0) s.mode = 'dismiss';
      else s.mode = 'none';
    }
    if (s.mode === 'pan') {
      const sv = s.startView;
      applyView(clamp({ s: sv.s, x: sv.x + dx, y: sv.y + dy }), false);
    } else if (s.mode === 'swipe') {
      setDrag({ x: many ? dx : dx * 0.25, y: 0 });
    } else if (s.mode === 'dismiss') {
      setDrag({ x: 0, y: Math.max(0, dy) });
    }
  };

  const handleTap = (x: number, y: number) => {
    const s = g.current;
    const onImage = s.onImage;
    if (s.pointerType === 'mouse') {
      // Desktop keeps click-to-zoom on the photo
      if (onImage) toggleZoomAt(x, y);
      else if (viewRef.current.s <= 1.01) onClose();
      return;
    }
    // Touch: a single tap never zooms; double tap does
    const now = Date.now();
    const lt = lastTap.current;
    if (lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(x - lt.x, y - lt.y) < 40) {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = null;
      lastTap.current = null;
      toggleZoomAt(x, y);
      return;
    }
    lastTap.current = { t: now, x, y };
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null;
      lastTap.current = null;
      if (viewRef.current.s > 1.01) return;
      // Tapping the left / right third flips photos; elsewhere off the photo closes
      const { w, cx } = stageBox();
      const rel = (x - (cx - w / 2)) / w;
      if (many && rel < 0.3) go(-1);
      else if (many && rel > 0.7) go(1);
      else if (!onImage) onClose();
    }, DOUBLE_TAP_MS);
  };

  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    const s = g.current;
    if (!s.pointers.has(e.pointerId)) return;
    s.pointers.delete(e.pointerId);

    if (s.mode === 'pinch') {
      if (s.pointers.size === 1) {
        // One finger lifted: keep panning with the other
        const [p] = [...s.pointers.values()];
        s.mode = 'pan';
        startSingle(p.x, p.y);
      } else if (s.pointers.size === 0) {
        s.mode = 'none';
        const cur = viewRef.current;
        applyView(cur.s < 1.05 ? IDENTITY : clamp(cur), true);
      }
      return;
    }
    if (s.pointers.size > 0) return;

    const mode = s.mode;
    s.mode = 'none';
    const dx = e.clientX - s.startX, dy = e.clientY - s.startY;

    if (cancelled) {
      if (mode === 'swipe' || mode === 'dismiss') snapBack();
      return;
    }
    if (mode === 'swipe') {
      const w = stageBox().w;
      const fling = Math.abs(s.vx) > 0.45 && Math.abs(dx) > 30 && Math.sign(s.vx) === Math.sign(dx);
      if (many && (Math.abs(dx) > w * 0.2 || fling)) go(dx < 0 ? 1 : -1);
      else snapBack();
    } else if (mode === 'dismiss') {
      if (dy > 120 || (s.vy > 0.6 && dy > 40)) dismiss();
      else snapBack();
    } else if (mode === 'pending') {
      handleTap(e.clientX, e.clientY);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (busy.current) return;
    const cur = viewRef.current;
    const scale = Math.min(MAX_SCALE, Math.max(1, cur.s * Math.exp(-e.deltaY * 0.0015)));
    zoomTo(scale, e.clientX, e.clientY, cur, false);
  };

  const navBtn = 'absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex items-center justify-center w-11 h-11 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white';
  const fade = drag.y > 0 ? Math.max(0.3, 1 - drag.y / 400) : 1;
  const offsets = many ? [-1, 0, 1] : [0];
  const transition = (on: boolean) => (on ? `transform ${duration}ms ${EASE}` : 'none');

  // Portaled to <body> so no ancestor's stacking context can put page content above it
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col anim-fade"
      style={{ backgroundColor: `rgba(0,0,0,${fade})` }}
      role="dialog"
      aria-modal="true"
      aria-label="照片"
    >
      <div className="flex items-center gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-2 text-white" style={{ opacity: fade }}>
        <span className="num text-sm text-white/70 px-1">{index + 1} / {n}</span>
        <div className="flex-1" />
        <button
          onClick={() => { const { cx, cy } = stageBox(); toggleZoomAt(cx, cy); }}
          aria-label={zoomed ? '縮小' : '放大'}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          {zoomed ? <ZoomOut size={19} /> : <ZoomIn size={19} />}
        </button>
        <button onClick={onClose} aria-label="關閉" className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <X size={20} />
        </button>
      </div>

      <div
        ref={stageRef}
        className="relative flex-1 min-h-0 overflow-hidden select-none"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={e => endPointer(e, false)}
        onPointerCancel={e => endPointer(e, true)}
        onWheel={onWheel}
      >
        <div
          className="absolute inset-0"
          style={{ transform: `translate3d(${drag.x}px, ${drag.y}px, 0)`, transition: transition(dragAnim) }}
        >
          {offsets.map(k => (
            <div
              key={v + k}
              className="absolute inset-0 flex items-center justify-center px-3"
              style={{ transform: `translateX(calc(${k * 100}% + ${k * GAP}px))` }}
              aria-hidden={k !== 0 || undefined}
            >
              <img
                ref={k === 0 ? imgRef : undefined}
                src={photos[mod(v + k, n)]}
                alt={k === 0 ? alt : ''}
                draggable={false}
                className={`max-w-full max-h-full object-contain rounded-lg select-none ${k === 0 ? (zoomed ? 'cursor-grab' : 'cursor-zoom-in') : ''}`}
                style={k === 0
                  ? { transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.s})`, transition: transition(viewAnim), willChange: 'transform' }
                  : undefined}
              />
            </div>
          ))}
        </div>
        {many && !zoomed && (
          <>
            <button aria-label="上一張" onClick={() => go(-1)} className={`${navBtn} left-3`}><ChevronLeft size={26} /></button>
            <button aria-label="下一張" onClick={() => go(1)} className={`${navBtn} right-3`}><ChevronRight size={26} /></button>
          </>
        )}
      </div>

      {footer
        ? <div className="px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] text-white" style={{ opacity: fade }}>{footer}</div>
        : <div className="pb-[max(16px,env(safe-area-inset-bottom))]" />}
    </div>,
    document.body,
  );
};

export default PhotoLightbox;
