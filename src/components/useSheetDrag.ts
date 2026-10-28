import { useEffect, useRef } from 'react';

/** Phones only: from sm up the sheets are centred dialogs, not bottom sheets. */
const PHONE_QUERY = '(max-width: 639.98px)';
/** Pixels of downward movement before a touch counts as a drag rather than a tap. */
const DRAG_SLOP = 6;
/** px/ms — a quick flick closes the sheet even if it moved only a little. */
const FLICK_VELOCITY = 0.6;

interface Options {
  /**
   * Also start the drag from inside the scrolling body when it is scrolled to the top.
   * Off for sheets that hold forms, so pulling a half-filled form down to see the top
   * doesn't throw it away; those close from the grab handle and title bar only.
   */
  fromContent?: boolean;
  /** Pass the open state for sheets that stay mounted while closed, so the listeners attach on open. */
  enabled?: boolean;
}

/**
 * 手機底部面板的「往下拉收起」。
 *
 * 回傳兩個 ref：`sheetRef` 放在面板本身，`handleRef` 放在把手與標題列（從這裡拉一律有效），
 * `scrollRef` 放在會捲動的內容區（`fromContent` 時，捲到最上面再往下拉也能收起）。
 * 拉超過面板高度的四分之一（最多 140px）或快速往下撥就關閉，否則彈回原位。
 */
export const useSheetDrag = (onClose: () => void, { fromContent = true, enabled = true }: Options = {}) => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!enabled || !sheet) return;
    const phone = window.matchMedia(PHONE_QUERY);
    let startY = 0;
    let startTime = 0;
    let offset = 0;
    let armed = false;
    let dragging = false;

    const reset = () => {
      armed = false;
      dragging = false;
      offset = 0;
    };

    const onStart = (e: TouchEvent) => {
      reset();
      if (!phone.matches || e.touches.length !== 1) return;
      const target = e.target as HTMLElement;
      // 輸入框要能選字、拖游標，不能被搶走
      if (target.closest('input, textarea, select, [data-no-sheet-drag]')) return;
      const onHandle = !!handleRef.current?.contains(target);
      const scroller = scrollRef.current;
      const atTop = !scroller || scroller.scrollTop <= 0;
      armed = onHandle || (fromContent && atTop);
      startY = e.touches[0].clientY;
      startTime = e.timeStamp;
    };

    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const delta = e.touches[0].clientY - startY;
      if (!dragging) {
        // 先往上滑就是要捲內容，這次觸控不再當成拖曳
        if (delta < -DRAG_SLOP) { armed = false; return; }
        if (delta < DRAG_SLOP) return;
        dragging = true;
        sheet.style.transition = 'none';
      }
      offset = Math.max(0, delta - DRAG_SLOP);
      // 擋掉 iOS 捲到頂之後的回彈，面板才會跟著手指走
      if (e.cancelable) e.preventDefault();
      sheet.style.transform = `translateY(${offset}px)`;
    };

    const onEnd = (e: TouchEvent) => {
      if (!dragging) { reset(); return; }
      const velocity = offset / Math.max(1, e.timeStamp - startTime);
      const threshold = Math.min(140, sheet.offsetHeight * 0.25);
      sheet.style.transition = 'transform 0.2s ease-out';
      if (offset > threshold || velocity > FLICK_VELOCITY) {
        sheet.style.transform = 'translateY(100%)';
        window.setTimeout(() => closeRef.current(), 180);
      } else {
        sheet.style.transform = '';
      }
      reset();
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
    };
  }, [fromContent, enabled]);

  return { sheetRef, handleRef, scrollRef };
};
