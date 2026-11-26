import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

/** 拖到畫面上下緣這麼近時自動捲動 */
const EDGE = 90;
const MAX_SCROLL_STEP = 14;

/**
 * 拖曳把手排序（滑鼠與觸控共用 Pointer Events）。
 *
 * 容器底下每個項目要有 `data-sort-key`；按住把手拖，指標越過鄰居的中線就呼叫 `onMove(from, to)`，
 * 清單即時換位置（不做跟手的位移動畫，換位置本身就是回饋）。拖到畫面上下緣會自動捲動，長清單也拖得到底。
 * 只有把手 `touch-action: none`，其餘地方照常捲動頁面。
 */
export function useDragSort(keys: string[], onMove: (from: number, to: number) => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<{ key: string; y: number; raf: number } | null>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const reposition = useCallback(() => {
    const d = drag.current;
    const container = containerRef.current;
    if (!d || !container) return;
    const from = keysRef.current.indexOf(d.key);
    if (from < 0) return;
    // 目標位置 = 中線在指標上方的「其他項目」有幾個
    let to = 0;
    container.querySelectorAll<HTMLElement>(':scope > [data-sort-key]').forEach(el => {
      if (el.dataset.sortKey === d.key) return;
      const r = el.getBoundingClientRect();
      if (d.y > r.top + r.height / 2) to++;
    });
    if (to !== from) onMoveRef.current(from, to);
  }, []);

  const autoScroll = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    const h = window.innerHeight;
    const step = d.y < EDGE ? -Math.ceil(((EDGE - d.y) / EDGE) * MAX_SCROLL_STEP)
      : d.y > h - EDGE ? Math.ceil(((d.y - (h - EDGE)) / EDGE) * MAX_SCROLL_STEP)
      : 0;
    if (step) {
      window.scrollBy(0, step);
      reposition();
    }
    d.raf = requestAnimationFrame(autoScroll);
  }, [reposition]);

  const listeners = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);

  const end = useCallback(() => {
    if (drag.current) cancelAnimationFrame(drag.current.raf);
    drag.current = null;
    if (listeners.current) {
      window.removeEventListener('pointermove', listeners.current.move);
      window.removeEventListener('pointerup', listeners.current.up);
      window.removeEventListener('pointercancel', listeners.current.up);
      listeners.current = null;
    }
    setDragging(null);
  }, []);

  useEffect(() => end, [end]);

  // 監聽掛在 window：拖曳中清單會重排，把手的 DOM 節點被搬動時 pointer capture 可能掉，掛在把手上會斷
  const handleProps = (key: string) => ({
    'data-drag-handle': '',
    style: { touchAction: 'none' } as React.CSSProperties,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      end();
      const pointerId = e.pointerId;
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId || !drag.current) return;
        drag.current.y = ev.clientY;
        reposition();
      };
      listeners.current = { move, up: end };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      drag.current = { key, y: e.clientY, raf: requestAnimationFrame(autoScroll) };
      setDragging(key);
    },
  });

  return { containerRef, dragging, handleProps };
}
