import { resolvePhotoUrl } from '../../utils/storage';
import { VIDEO_H, VIDEO_W } from './render';

/**
 * 照片的準備與快取。手機記憶體有限（iPhone 上分頁超過幾百 MB 就會被直接重新載入），
 * 所以原圖只在準備時解碼一次、縮到「填滿 1080×1920 再留一點 Ken Burns 餘裕」的大小，
 * 存成小 JPEG；畫面要用時才解碼成 ImageBitmap，只留目前前後那幾張。
 * 另外每張存一份 48px 寬的縮圖：放大畫出來就是天然的模糊背景，不必靠 ctx.filter（Safari 舊版不支援）。
 */

export interface PhotoAsset {
  image: CanvasImageSource;
  width: number;
  height: number;
  blur: HTMLCanvasElement;
}

interface Prepared {
  blob: Blob;
  width: number;
  height: number;
  blur: HTMLCanvasElement;
}

/** Room for the slow zoom without upscaling */
const HEADROOM = 1.18;
/** Landscape photos sit in a full-width frame, so they never need more than this */
const MAX_SIDE = 2400;
const BLUR_W = 48;

const loadImage = async (blob: Blob): Promise<HTMLImageElement> => {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    // onload rather than img.decode(): decode() never settles for detached images in some WebViews
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = url;
    });
    return img;
  } finally {
    // The decoded pixels stay with the element; the URL is no longer needed
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality));

/** The size to keep: just big enough to cover the frame (or fill its width, for landscape shots) */
export const targetSize = (w: number, h: number): { width: number; height: number } => {
  const landscape = w / h > 1.15;
  const scale = landscape
    ? (VIDEO_W * HEADROOM) / w
    : Math.max(VIDEO_W / w, VIDEO_H / h) * HEADROOM;
  let s = Math.min(1, scale);
  s = Math.min(s, MAX_SIDE / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
};

/**
 * 用 CORS 抓原圖（要畫進 canvas 再編碼，no-cors 的圖會讓整張畫布不能讀）。
 * 網址加 `?recap=1`：PWA 只快取不帶查詢字串的圖片網址，相簿 <img> 存進去的 opaque 回應不會被拿來回應這裡，
 * 那正是「影片裡有些照片全黑」的原因。萬一還是拿到 opaque／錯誤，再換一個網址、略過 HTTP 快取重抓一次。
 */
const fetchPhoto = async (path: string, signal?: AbortSignal): Promise<Response> => {
  // 開放版是簽名網址（本來就帶 ?token=），要等簽好；查詢字串用 & 接在後面
  const base = await resolvePhotoUrl(path);
  if (!base) throw new Error('photo_url_unavailable');
  const sep = base.includes('?') ? '&' : '?';
  const attempt = (suffix: string, init: RequestInit) => fetch(`${base}${sep}${suffix}`, { ...init, signal, mode: 'cors' });
  try {
    const res = await attempt('recap=1', {});
    if (res.ok && res.type !== 'opaque') return res;
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  const retry = await attempt(`recap=${Date.now()}`, { cache: 'reload' });
  if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
  return retry;
};

/** HEIC/HEIF (iPhone, and Samsung's "high efficiency" photos): an ISO-BMFF box with an HEIF brand */
const isHeif = async (file: Blob): Promise<boolean> => {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const text = String.fromCharCode(...head.slice(4, 12));
  return text.startsWith('ftyp') && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(text.slice(4));
};

/**
 * 手機挑的照片，回傳瀏覽器讀得了的版本。HEIC／HEIF（iPhone、三星的「高效率照片」）
 * Chrome 讀不了，縮圖會破圖、影片也畫不出來，所以先轉成 JPEG（轉檔程式約 3 MB，只有遇到 HEIC 才下載）。
 * 讀不了也轉不了就丟錯，讓畫面說清楚，而不是默默不見。
 */
export const readLocalPhoto = async (file: File): Promise<Blob> => {
  try {
    const img = await loadImage(file);
    if (img.naturalWidth > 0) return file;
  } catch {
    // Try converting below
  }
  if (await isHeif(file)) {
    const { heicTo } = await import('heic-to/csp');
    return heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
  }
  throw new Error(`Unreadable image: ${file.type || 'unknown type'}`);
};

// --- The uploaded closing photo survives a reload ------------------------------------
// Phones often reload the page after a long encode or after the share sheet (memory), and the
// photo was only in memory, so "回去調整" came back without it (David 2026-11-24).
// It lives in this browser's IndexedDB, never on the server.

const DB_NAME = 'recap';
const OUTRO_STORE = 'outro';

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OUTRO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(OUTRO_STORE, mode).objectStore(OUTRO_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
};

export const saveOwnOutro = async (tripId: string, photo: Blob | null): Promise<void> => {
  try {
    if (photo) await withStore('readwrite', s => s.put(photo, tripId));
    else await withStore('readwrite', s => s.delete(tripId));
  } catch {
    // Private mode or storage blocked: it stays for this visit only
  }
};

export const loadOwnOutro = async (tripId: string): Promise<Blob | null> => {
  try {
    const found = await withStore<unknown>('readonly', s => s.get(tripId));
    return found instanceof Blob ? found : null;
  } catch {
    return null;
  }
};

export class PhotoStore {
  private prepared = new Map<string, Prepared>();
  private decoded = new Map<string, ImageBitmap | HTMLImageElement>();
  private pending = new Map<string, Promise<void>>();
  private failed = new Set<string>();
  /** Photos picked from this device: never uploaded, read straight from the file */
  private local = new Map<string, Blob>();

  addLocal(path: string, file: Blob) {
    this.local.set(path, file);
    this.failed.delete(path);
  }

  /** Photos that could not be read (the video skips them instead of showing black) */
  failedPaths(): Set<string> {
    return new Set(this.failed);
  }

  /** Downloads and shrinks every photo once. Photos that fail are skipped, not fatal. */
  async prepare(paths: string[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal) {
    let done = 0;
    const todo = paths.filter(p => !this.prepared.has(p) && !this.failed.has(p));
    onProgress?.(paths.length - todo.length, paths.length);
    done = paths.length - todo.length;
    // Two at a time: fast on Wi-Fi, and only two full-size decodes in memory at once
    const queue = [...todo];
    const worker = async () => {
      while (queue.length > 0) {
        if (signal?.aborted) return;
        const path = queue.shift()!;
        try {
          await this.prepareOne(path, signal);
        } catch (e) {
          if (signal?.aborted) return;
          console.warn('[recap] photo skipped', path, e);
          this.failed.add(path);
        }
        done += 1;
        onProgress?.(done, paths.length);
      }
    };
    await Promise.all([worker(), worker()]);
  }

  private async prepareOne(path: string, signal?: AbortSignal) {
    const local = this.local.get(path);
    const img = await loadImage(local ?? await (await fetchPhoto(path, signal)).blob());
    const { width, height } = targetSize(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await toBlob(c, 0.9);

    const blur = document.createElement('canvas');
    blur.width = BLUR_W;
    blur.height = Math.max(1, Math.round((BLUR_W * height) / width));
    const bctx = blur.getContext('2d')!;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(c, 0, 0, blur.width, blur.height);
    // Free the big canvas right away (iOS counts canvas memory separately)
    c.width = 1;
    c.height = 1;
    this.prepared.set(path, { blob, width, height, blur });
  }

  has(path: string) {
    return this.prepared.has(path);
  }

  /** Only the photos that made it through prepare() */
  usable(paths: string[]) {
    return paths.filter(p => this.prepared.has(p));
  }

  get(path: string): PhotoAsset | null {
    const p = this.prepared.get(path);
    const image = this.decoded.get(path);
    if (!p) return null;
    if (!image) return { image: p.blur, width: p.width, height: p.height, blur: p.blur };
    return { image, width: p.width, height: p.height, blur: p.blur };
  }

  isReady(path: string) {
    return this.decoded.has(path) || !this.prepared.has(path);
  }

  /** Decodes `keep` (if needed) and frees everything else. */
  async keepOnly(keep: string[]) {
    const wanted = new Set(keep);
    for (const [path, img] of this.decoded) {
      if (wanted.has(path)) continue;
      if ('close' in img) img.close();
      this.decoded.delete(path);
    }
    await Promise.all(keep.map(p => this.decode(p)));
  }

  private decode(path: string): Promise<void> {
    if (this.decoded.has(path)) return Promise.resolve();
    const prepared = this.prepared.get(path);
    if (!prepared) return Promise.resolve();
    let job = this.pending.get(path);
    if (!job) {
      job = (async () => {
        try {
          const img = typeof createImageBitmap === 'function'
            ? await createImageBitmap(prepared.blob)
            : await loadImage(prepared.blob);
          this.decoded.set(path, img);
        } finally {
          this.pending.delete(path);
        }
      })();
      this.pending.set(path, job);
    }
    return job;
  }

  dispose() {
    for (const img of this.decoded.values()) if ('close' in img) img.close();
    this.decoded.clear();
    this.prepared.clear();
  }
}
