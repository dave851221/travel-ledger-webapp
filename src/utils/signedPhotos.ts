/**
 * 開放版的照片網址：照片在 Cloudflare R2 的私有 bucket，畫面要用簽名網址（短期有效，由 Edge Function tlb-photos 簽）。
 *
 * photoUrl() 是同步的、到處都在用，所以這裡做成「先回一張透明圖，背景批次去簽，簽好通知重畫」：
 *   · photoUrl(path) 沒有可用的簽名網址時，把 path 排進下一批，先回 PLACEHOLDER
 *   · 一批最多 100 張一起簽（tlb-photos 的 sign，只簽自己是成員的旅程），簽好之後 version + 1
 *   · 用 usePhotoUrlVersion() 的元件會跟著重畫（Dashboard 掛一個，底下的元件跟著重畫；
 *     有 useMemo 的地方把 version 放進相依）
 * 簽 12 小時，剩不到 1 小時就重簽。舊版不會用到這個檔案（公開 bucket 直接組網址）。
 */
import { useSyncExternalStore } from 'react';
import { invokePhotos } from './photoStore';

const TTL_SECONDS = 12 * 60 * 60;
const REFRESH_BEFORE_MS = 60 * 60 * 1000;
const BATCH = 100;

/** 1×1 透明 GIF：簽好之前的佔位 */
export const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const cache = new Map<string, { url: string; expiresAt: number }>();
const queued = new Set<string>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

const fresh = (path: string) => {
  const hit = cache.get(path);
  return hit && hit.expiresAt - Date.now() > REFRESH_BEFORE_MS ? hit.url : null;
};

async function signBatch(paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH);
    try {
      const { urls, ttl } = await invokePhotos<{ urls: Record<string, string>; ttl?: number }>({ action: 'sign', paths: chunk });
      const expiresAt = Date.now() + (ttl ?? TTL_SECONDS) * 1000;
      Object.entries(urls ?? {}).forEach(([path, url]) => { if (url) cache.set(path, { url, expiresAt }); });
    } catch (e) {
      console.error('[PHOTO] sign failed', e);
    }
  }
  version += 1;
  listeners.forEach(l => l());
}

function flush(): void {
  scheduled = false;
  const paths = [...queued].filter(p => !inflight.has(p));
  queued.clear();
  if (paths.length === 0) return;
  const job = signBatch(paths).finally(() => paths.forEach(p => inflight.delete(p)));
  paths.forEach(p => inflight.set(p, job));
}

function enqueue(path: string): void {
  if (inflight.has(path)) return;
  queued.add(path);
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
}

/** 同步取網址：簽好了回簽名網址，還沒就排隊並先回透明圖 */
export function signedPhotoUrl(path: string): string {
  const url = fresh(path);
  if (url) return url;
  enqueue(path);
  return cache.get(path)?.url ?? PLACEHOLDER;
}

/** 非同步取網址（產生回顧影片抓原圖用）：等簽好再回；簽不到回 null */
export async function resolveSignedPhotoUrl(path: string): Promise<string | null> {
  const url = fresh(path);
  if (url) return url;
  enqueue(path);
  flush();
  await inflight.get(path);
  return cache.get(path)?.url ?? null;
}

/** 一次先把整趟的照片簽好（載入帳目後呼叫），之後畫面不必一張一張排隊 */
export function primePhotoUrls(paths: string[]): void {
  paths.forEach(p => { if (p && !fresh(p)) enqueue(p); });
}

/** 登出或換帳號時清掉（簽名網址等於臨時鑰匙，不留給下一個人） */
export function clearSignedPhotoUrls(): void {
  cache.clear();
  version += 1;
  listeners.forEach(l => l());
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const getVersion = () => version;

/** 簽名網址有更新時讓元件重畫 */
export function usePhotoUrlVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
