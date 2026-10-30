import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ALBUM_MIN_COLUMNS,
  albumCellOffset,
  albumGridHeight,
  albumLayoutColumns,
  albumMaxColumns,
  clampAlbumColumns,
  defaultAlbumColumns,
  pinchColumnsFraction,
  rubberBandColumns,
} from '../../utils/album';

const COLUMNS_KEY = 'album_columns';
/** How long the grid takes to settle on a whole column count. */
const SETTLE_MS = 240;
/** How long photos take to slide to their new place when the column count changes. */
const REFLOW_MS = 200;
/** A photo moving further than this many photo widths fades in place instead of flying across the grid. */
const MAX_SLIDE_PHOTOS = 1.6;
/** Wheel events this big are mouse notches; a trackpad pinch sends many small ones. */
const WHEEL_NOTCH = 50;
/** Trackpad pinches have no "fingers lifted" event, so a pause ends them. */
const TRACKPAD_IDLE_MS = 140;
const TRACKPAD_SPEED = 0.01;
/** Firefox reports wheel deltas in lines. */
const WHEEL_LINE_PX = 33;
/** Lifting two fingers can land as a click on a thumbnail on some browsers. */
const CLICK_GUARD_MS = 350;

const readColumns = (): number => {
  const width = window.innerWidth;
  try {
    const stored = Number(localStorage.getItem(COLUMNS_KEY));
    if (stored) return clampAlbumColumns(stored, width);
  } catch {
    // Blocked storage: fall through to the default
  }
  return defaultAlbumColumns(width);
};

const columnsTemplate = (columns: number) => `repeat(${columns}, minmax(0, 1fr))`;
const fingerDistance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const midpoint = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
const onScreen = (r: DOMRect) => r.bottom > 0 && r.top < window.innerHeight;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

interface Zoom {
  /** The photo that stays level with the fingers, and how far down it (0–1) they are */
  index: number;
  ratioY: number;
  /** The fingers on screen: x is where the grid zooms from, y is where the photo is held */
  x: number;
  y: number;
  /** The columns the grid is laid out with, always whole */
  columns: number;
  /** The columns the fingers are asking for, usually between two whole numbers */
  fraction: number;
}

/**
 * 緊密格子的縮放，手感比照手機相簿：照片大小連續跟著手指，放開才吸附到整數欄。
 *
 * 做法是把版面（整數欄）與視覺（`transform: scale`）分開：格子用 n 欄排，再放大 n / f 倍，
 * f 是手指要的小數欄數。這樣照片大小就等於 寬度 / f，換欄時大小完全連續，
 * 只有排列改變，所以只有那一刻要讓照片滑到新位置（FLIP）。
 * n 一律無條件進位（`albumLayoutColumns`），放大倍率才不會小於 1 —— 否則格子比畫面窄、兩側露出空白。
 * 手指下的照片只鎖上下：左右也鎖的話，換欄時整個格子會被拖著橫移，一邊空出一長條。
 * ＋／－ 按鈕與滑鼠滾輪走同一條路：把 f 從現在補間到目標。
 *
 * 手勢進行中直接改 DOM，不經過 React，一秒 60 次重畫上百張縮圖會掉格；
 * 結束時才 `setColumns`，React 寫回的是一樣的值。
 *
 * ⚠️ 用原生的 touch／wheel 監聽：React 的這兩個事件是 passive，preventDefault 擋不住瀏覽器的整頁縮放。
 * ⚠️ 用 touch event 而不是 pointer event：格子是 `touch-pan-y`，瀏覽器接手捲動時 pointer 會被 cancel。
 */
export const useGridZoom = (enabled: boolean) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(readColumns);
  const columnsRef = useRef(columns);
  const stepRef = useRef<(step: number) => void>(() => {});

  useEffect(() => {
    const grid = gridRef.current;
    const wrap = grid?.parentElement;
    if (!enabled || !grid || !wrap) return;
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let zoom: Zoom | null = null;
    let pinch: { fraction: number; distance: number; mid: { x: number; y: number }; focus: { x: number; y: number } } | null = null;
    let pinchEndedAt = 0;
    let frame = 0;
    let trackpadTimer = 0;
    /** Where a running settle is heading, so a second button press adds to it */
    let target: number | null = null;

    const begin = (x: number, y: number) => {
      const width = wrap.clientWidth;
      const box = wrap.getBoundingClientRect();
      const n = columnsRef.current;
      const pitch = (width + gap) / n;
      const column = Math.min(n - 1, Math.max(0, Math.floor((x - box.left) / pitch)));
      const row = Math.max(0, Math.floor((y - box.top) / pitch));
      const index = Math.min(grid.children.length - 1, row * n + column);
      const cell = albumCellOffset(index, n, width, gap);
      zoom = {
        index,
        ratioY: (y - box.top - cell.y) / cell.size,
        x, y, columns: n, fraction: n,
      };
      grid.style.transformOrigin = '0 0';
      grid.style.willChange = 'transform';
    };

    // Zooms sideways around the fingers, which keeps the grid across the whole width,
    // and holds the anchor photo level with them
    const paint = (z: Zoom) => {
      const box = wrap.getBoundingClientRect();
      const width = wrap.clientWidth;
      const scale = z.columns / z.fraction;
      const cell = albumCellOffset(z.index, z.columns, width, gap);
      const tx = (1 - scale) * Math.min(width, Math.max(0, z.x - box.left));
      const ty = z.y - box.top - scale * (cell.y + z.ratioY * cell.size);
      grid.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    };

    // Same photo size before and after, only the arrangement changes: slide each one over
    const relayout = (z: Zoom, next: number) => {
      const cells = Array.from(grid.children) as HTMLElement[];
      const before = cells.map(c => c.getBoundingClientRect());
      z.columns = next;
      grid.style.gridTemplateColumns = columnsTemplate(next);
      paint(z);
      if (calm) return;
      grid.getAnimations({ subtree: true }).forEach(a => a.cancel());
      const scale = next / z.fraction;
      const maxSlide = (wrap.clientWidth / z.fraction) * MAX_SLIDE_PHOTOS;
      cells.forEach((cell, i) => {
        const to = cell.getBoundingClientRect();
        if (!onScreen(before[i]) && !onScreen(to)) return;
        const dx = before[i].left - to.left;
        const dy = before[i].top - to.top;
        if (Math.hypot(dx, dy) > maxSlide) {
          if (onScreen(to)) cell.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: REFLOW_MS, easing: 'ease-out' });
          return;
        }
        cell.animate(
          [{ transform: `translate(${dx / scale}px, ${dy / scale}px)` }, { transform: 'none' }],
          { duration: REFLOW_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' },
        );
      });
    };

    const update = (z: Zoom, fraction: number) => {
      z.fraction = rubberBandColumns(fraction, window.innerWidth);
      const next = albumLayoutColumns(z.fraction, window.innerWidth);
      if (next === z.columns) paint(z);
      else relayout(z, next);
    };

    const finish = (z: Zoom) => {
      const box = wrap.getBoundingClientRect();
      const cell = albumCellOffset(z.index, z.columns, wrap.clientWidth, gap);
      const scroll = box.top + cell.y + z.ratioY * cell.size - z.y;
      grid.style.transform = '';
      grid.style.transformOrigin = '';
      grid.style.willChange = '';
      window.scrollBy({ top: scroll, behavior: 'instant' });
      zoom = null;
      target = null;
      columnsRef.current = z.columns;
      setColumns(z.columns);
      try {
        localStorage.setItem(COLUMNS_KEY, String(z.columns));
      } catch {
        // Only this visit keeps the size
      }
    };

    const stopSettling = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(trackpadTimer);
    };

    // Glides to `columnsTo`, stopping the anchor photo short of the page ends,
    // which the final scroll can't go past
    const settle = (z: Zoom, columnsTo: number) => {
      stopSettling();
      target = columnsTo;
      const width = wrap.clientWidth;
      const box = wrap.getBoundingClientRect();
      const cell = albumCellOffset(z.index, columnsTo, width, gap);
      const visual = grid.style.transform;
      grid.style.transform = '';
      const pageHeight = document.documentElement.scrollHeight
        - albumGridHeight(grid.children.length, z.columns, width, gap)
        + albumGridHeight(grid.children.length, columnsTo, width, gap);
      grid.style.transform = visual;
      const wanted = window.scrollY + box.top + cell.y + z.ratioY * cell.size - z.y;
      const possible = Math.min(Math.max(0, pageHeight - window.innerHeight), Math.max(0, wanted));
      const from = { fraction: z.fraction, y: z.y };
      const toY = z.y + wanted - possible;
      const startedAt = performance.now();
      const tick = (now: number) => {
        const t = calm ? 1 : Math.min(1, (now - startedAt) / SETTLE_MS);
        const eased = easeOut(t);
        z.y = from.y + (toY - from.y) * eased;
        update(z, from.fraction + (columnsTo - from.fraction) * eased);
        if (t < 1) frame = requestAnimationFrame(tick);
        else finish(z);
      };
      frame = requestAnimationFrame(tick);
    };

    const settleOn = (z: Zoom) => settle(z, clampAlbumColumns(z.fraction, window.innerWidth));

    const stepBy = (step: number, x: number, y: number) => {
      if (!zoom) begin(x, y);
      const z = zoom!;
      settle(z, clampAlbumColumns((target ?? z.columns) + step, window.innerWidth));
    };
    stepRef.current = step => stepBy(step, window.innerWidth / 2, window.innerHeight / 2);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const [a, b] = [e.touches[0], e.touches[1]];
      const mid = midpoint(a, b);
      stopSettling();
      target = null;
      if (!zoom) begin(mid.x, mid.y);
      const z = zoom!;
      pinch = { fraction: z.fraction, distance: fingerDistance(a, b), mid, focus: { x: z.x, y: z.y } };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || !zoom || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const mid = midpoint(a, b);
      zoom.x = pinch.focus.x + mid.x - pinch.mid.x;
      zoom.y = pinch.focus.y + mid.y - pinch.mid.y;
      update(zoom, pinchColumnsFraction(pinch.fraction, pinch.distance, fingerDistance(a, b)));
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!pinch || e.touches.length >= 2) return;
      pinch = null;
      pinchEndedAt = Date.now();
      if (zoom) settleOn(zoom);
    };
    const onClick = (e: MouseEvent) => {
      if (Date.now() - pinchEndedAt >= CLICK_GUARD_MS) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // Trackpad pinches arrive as ctrl+wheel in Chrome, Edge and Firefox
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
      if (Math.abs(delta) >= WHEEL_NOTCH) {
        stepBy(delta > 0 ? 1 : -1, e.clientX, e.clientY);
        return;
      }
      stopSettling();
      target = null;
      if (!zoom) begin(e.clientX, e.clientY);
      const z = zoom!;
      update(z, z.fraction * Math.exp(delta * TRACKPAD_SPEED));
      trackpadTimer = window.setTimeout(() => settleOn(z), TRACKPAD_IDLE_MS);
    };
    // iOS Safari's own page zoom; touch-action alone doesn't always stop it there
    const onGesture = (e: Event) => e.preventDefault();

    grid.addEventListener('touchstart', onTouchStart, { passive: true });
    grid.addEventListener('touchmove', onTouchMove, { passive: false });
    grid.addEventListener('touchend', onTouchEnd);
    grid.addEventListener('touchcancel', onTouchEnd);
    grid.addEventListener('click', onClick, true);
    grid.addEventListener('wheel', onWheel, { passive: false });
    grid.addEventListener('gesturestart', onGesture);
    return () => {
      stopSettling();
      stepRef.current = () => {};
      grid.style.transform = '';
      grid.style.transformOrigin = '';
      grid.style.willChange = '';
      grid.style.gridTemplateColumns = columnsTemplate(columnsRef.current);
      grid.removeEventListener('touchstart', onTouchStart);
      grid.removeEventListener('touchmove', onTouchMove);
      grid.removeEventListener('touchend', onTouchEnd);
      grid.removeEventListener('touchcancel', onTouchEnd);
      grid.removeEventListener('click', onClick, true);
      grid.removeEventListener('wheel', onWheel);
      grid.removeEventListener('gesturestart', onGesture);
    };
  }, [enabled]);

  /** For the ＋／－ buttons: zooms around whatever is in the middle of the screen. */
  const stepColumns = useCallback((step: number) => stepRef.current(step), []);

  return {
    gridRef,
    columns,
    stepColumns,
    canShrink: columns < albumMaxColumns(window.innerWidth),
    canGrow: columns > ALBUM_MIN_COLUMNS,
  };
};
