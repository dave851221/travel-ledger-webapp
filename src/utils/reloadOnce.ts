/** 網站更新後 lazy chunk 抓不到時的處理（見 components/AppErrorBoundary.tsx） */
const RELOAD_KEY = 'app_chunk_reload_at';

export const isChunkError = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|Failed to fetch/i.test(msg);
};

/** 自動重新整理一次；30 秒內已經重整過就不再自動來（交給畫面上的按鈕） */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { /* 無痕模式之類，照樣重整 */ }
  window.location.reload();
  return true;
}

