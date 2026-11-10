import { useEffect, useRef } from 'react';

/**
 * 讓「返回」先關掉最上層的面板（表單、明細、照片檢視），而不是離開整個旅程。
 *
 * 手機上按 Android 的返回鍵、或 iPhone 從邊緣往右滑，瀏覽器做的是「上一頁」。
 * 面板開著的時候上一頁是首頁，填到一半的表單就整個不見了。
 *
 * 做法：每開一層面板就 pushState 一筆同網址的紀錄，收到 popstate 就關掉最上面那一層。
 * 所有面板共用一份狀態，延後一點點才對帳（reconcile）——
 * 「關掉明細、同時打開編輯表單」這種一關一開，前後層數一樣，history 完全不用動；
 * 若各自在 effect 裡 back()／pushState()，back 是非同步的，會把剛開的那一層關掉。
 *
 * 面板可以拒絕關閉（表單有還沒存的內容時先問一聲）：它還開著，對帳時就把那筆紀錄補回去。
 */

interface Entry {
  id: number;
  close: () => void;
}

/** Open overlays, oldest first */
const stack: Entry[] = [];
/** History entries we have pushed and not yet seen popped */
let depth = 0;
/** popstate events caused by our own history.go(), not by the user */
let ignorePops = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
let listening = false;

/** Long enough for React to commit the state change that a close() triggered */
const SETTLE_MS = 60;

const isOverlayEntry = () => !!(window.history.state && (window.history.state as { overlay?: boolean }).overlay);

const reconcile = () => {
  timer = null;
  const want = stack.length;
  if (want > depth) {
    for (let i = depth; i < want; i++) {
      // Keep the router's own state (key, idx) so it sees the same location on the way back
      window.history.pushState({ ...(window.history.state ?? {}), overlay: true }, '');
    }
    depth = want;
  } else if (want < depth) {
    const extra = depth - want;
    depth = want;
    // The router navigated somewhere else while a panel was open: those entries are no longer on top,
    // going back would undo that navigation. Leave them; a stale entry only costs one extra back press.
    if (!isOverlayEntry()) return;
    ignorePops++;
    window.history.go(-extra);
  }
};

const schedule = () => {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(reconcile, SETTLE_MS);
};

const onPopState = () => {
  if (ignorePops > 0) { ignorePops--; return; }
  // Not one of ours: an ordinary route change, or a stale entry from before a reload
  if (depth === 0 || stack.length === 0) return;
  depth--;
  stack[stack.length - 1].close();
  schedule();
};

/**
 * @param isOpen whether the overlay is showing
 * @param onClose called when the user goes back while this overlay is the topmost one
 * @param enabled pass false where the overlay is the whole page (LIFF), so back keeps its normal meaning
 */
export const useBackClose = (isOpen: boolean, onClose: () => void, enabled = true) => {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen || !enabled) return;
    if (!listening) {
      window.addEventListener('popstate', onPopState);
      listening = true;
    }
    const entry: Entry = { id: nextId++, close: () => closeRef.current() };
    stack.push(entry);
    schedule();
    return () => {
      const i = stack.findIndex(e => e.id === entry.id);
      if (i >= 0) stack.splice(i, 1);
      schedule();
    };
  }, [isOpen, enabled]);
};
