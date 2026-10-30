import { useCallback, useEffect, useRef, useState } from 'react';
import { readQueue, removeFromQueue, subscribeQueue, uploadQueue, type QueuedExpense } from '../utils/offlineQueue';

/**
 * 離線記帳佇列的畫面端：回傳目前還沒上傳的支出，並在恢復連線、回到前景、打開頁面時自動上傳。
 *
 * `onUploaded` 要重新抓帳目並回傳 Promise —— 抓完才把那幾筆移出佇列，
 * 否則畫面上會先消失一下再出現。
 */
export const useOfflineQueue = (
  enabled: boolean,
  onUploaded: (count: number) => Promise<unknown>,
) => {
  const [queue, setQueue] = useState<QueuedExpense[]>(() => readQueue());
  const onUploadedRef = useRef(onUploaded);
  useEffect(() => { onUploadedRef.current = onUploaded; }, [onUploaded]);

  useEffect(() => subscribeQueue(() => setQueue(readQueue())), []);

  const flush = useCallback(async () => {
    if (!navigator.onLine || readQueue().length === 0) return;
    const ids = await uploadQueue();
    if (ids.length === 0) return;
    await onUploadedRef.current(ids.length);
    removeFromQueue(ids);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    flush();
    const onVisible = () => { if (document.visibilityState === 'visible') flush(); };
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, flush]);

  return { queue, flush };
};
