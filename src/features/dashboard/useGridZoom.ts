import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ALBUM_MIN_COLUMNS, albumMaxColumns, clampAlbumColumns, defaultAlbumColumns, pinchColumns } from '../../utils/album';

const COLUMNS_KEY = 'album_columns';
/** Accumulated wheel delta for one step. A mouse notch is 100, a trackpad pinch sends many small ones. */
const WHEEL_STEP = 30;
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

const fingerDistance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

interface Anchor {
  index: number;
  /** Where inside the photo the point was, 0 at its top and 1 at its bottom */
  ratio: number;
  /** The viewport y to keep that point at */
  y: number;
}

/**
 * 緊密格子的縮放：手機雙指開合、電腦觸控板雙指或 Ctrl＋滾輪，都是改每排幾張。
 * 欄數一變整頁高度就跟著變，所以記住手指（或游標）下面是哪一張，換完把它捲回原位。
 *
 * ⚠️ 用原生的 touch／wheel 監聽：React 的這兩個事件是 passive，preventDefault 擋不住瀏覽器的整頁縮放。
 * ⚠️ 用 touch event 而不是 pointer event：格子是 `touch-pan-y`，瀏覽器接手捲動時 pointer 會被 cancel。
 */
export const useGridZoom = (enabled: boolean) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(readColumns);
  const columnsRef = useRef(columns);
  const anchorRef = useRef<Anchor | null>(null);

  // From the grid's geometry, not elementFromPoint: the point can land in the gap between
  // two photos (the middle of the screen does at any even column count) or on the bottom nav
  const anchorAt = useCallback((x: number, y: number) => {
    const grid = gridRef.current;
    const first = grid?.firstElementChild;
    if (!grid || !first) {
      anchorRef.current = null;
      return;
    }
    const box = grid.getBoundingClientRect();
    const pitch = first.getBoundingClientRect().width + parseFloat(getComputedStyle(grid).columnGap);
    const column = Math.min(columnsRef.current - 1, Math.max(0, Math.floor((x - box.left) / pitch)));
    const row = Math.max(0, Math.floor((y - box.top) / pitch));
    const index = Math.min(grid.children.length - 1, row * columnsRef.current + column);
    const cell = grid.children[index].getBoundingClientRect();
    anchorRef.current = { index, ratio: (y - cell.top) / cell.height, y };
  }, []);

  const applyColumns = useCallback((next: number) => {
    const value = clampAlbumColumns(next, window.innerWidth);
    if (value === columnsRef.current) return;
    columnsRef.current = value;
    setColumns(value);
    try {
      localStorage.setItem(COLUMNS_KEY, String(value));
    } catch {
      // Only this visit keeps the size
    }
  }, []);

  // Runs before paint, so the photo under the fingers never visibly jumps
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const cell = anchor && gridRef.current?.children[anchor.index];
    if (!anchor || !cell) return;
    const rect = cell.getBoundingClientRect();
    window.scrollBy({ top: rect.top + anchor.ratio * rect.height - anchor.y, behavior: 'instant' });
  }, [columns]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!enabled || !grid) return;
    let pinch: { columns: number; distance: number } | null = null;
    let pinchEndedAt = 0;
    let wheelDelta = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const [a, b] = [e.touches[0], e.touches[1]];
      pinch = { columns: columnsRef.current, distance: fingerDistance(a, b) };
      anchorAt((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const distance = fingerDistance(e.touches[0], e.touches[1]);
      applyColumns(pinchColumns(pinch.columns, pinch.distance, distance, window.innerWidth));
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!pinch || e.touches.length >= 2) return;
      pinch = null;
      pinchEndedAt = Date.now();
      anchorRef.current = null;
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
      wheelDelta += e.deltaY;
      if (Math.abs(wheelDelta) < WHEEL_STEP) return;
      const step = wheelDelta > 0 ? 1 : -1;
      wheelDelta = 0;
      anchorAt(e.clientX, e.clientY);
      applyColumns(columnsRef.current + step);
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
      grid.removeEventListener('touchstart', onTouchStart);
      grid.removeEventListener('touchmove', onTouchMove);
      grid.removeEventListener('touchend', onTouchEnd);
      grid.removeEventListener('touchcancel', onTouchEnd);
      grid.removeEventListener('click', onClick, true);
      grid.removeEventListener('wheel', onWheel);
      grid.removeEventListener('gesturestart', onGesture);
    };
  }, [enabled, anchorAt, applyColumns]);

  /** For the ＋／－ buttons: keeps whatever is in the middle of the screen in place. */
  const stepColumns = useCallback((step: number) => {
    anchorAt(window.innerWidth / 2, window.innerHeight / 2);
    applyColumns(columnsRef.current + step);
  }, [anchorAt, applyColumns]);

  return {
    gridRef,
    columns,
    stepColumns,
    canShrink: columns < albumMaxColumns(window.innerWidth),
    canGrow: columns > ALBUM_MIN_COLUMNS,
  };
};
