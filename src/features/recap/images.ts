import { photoUrl } from '../../utils/storage';
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
  const attempt = (suffix: string, init: RequestInit) => fetch(`${photoUrl(path)}?${suffix}`, { ...init, signal, mode: 'cors' });
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

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 照片的拍攝日（YYYY-MM-DD）。JPEG 讀 EXIF 的 DateTimeOriginal（沒有就讀 DateTime），
 * 讀不到（PNG、被修圖軟體拿掉、手機轉檔）就用檔案的修改時間。
 */
export const photoTakenDate = async (file: File): Promise<string> => {
  try {
    const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    const exif = readExifDate(view);
    if (exif) return exif;
  } catch {
    // Not a JPEG or a broken header: fall back below
  }
  return ymd(new Date(file.lastModified || Date.now()));
};

/** Minimal EXIF walk: APP1 → TIFF → IFD0 → Exif IFD → 0x9003 (or IFD0 0x0132) */
export const readExifDate = (view: DataView): string | null => {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 4 <= view.byteLength) {
    const marker = view.getUint16(at);
    const size = view.getUint16(at + 2);
    if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966) {
      const tiff = at + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const u16 = (o: number) => view.getUint16(o, little);
      const u32 = (o: number) => view.getUint32(o, little);
      const entries = (ifd: number) => {
        const n = u16(ifd);
        return Array.from({ length: n }, (_, i) => ifd + 2 + i * 12).filter(e => e + 12 <= view.byteLength);
      };
      const ascii = (e: number) => {
        const count = u32(e + 4);
        const off = count > 4 ? tiff + u32(e + 8) : e + 8;
        let text = '';
        for (let i = 0; i < count - 1 && off + i < view.byteLength; i++) text += String.fromCharCode(view.getUint8(off + i));
        return text;
      };
      const toDate = (text: string) => (/^\d{4}:\d{2}:\d{2}/.test(text) && !text.startsWith('0000') ? text.slice(0, 10).replace(/:/g, '-') : null);
      const ifd0 = tiff + u32(tiff + 4);
      let fallback: string | null = null;
      for (const e of entries(ifd0)) {
        const tag = u16(e);
        if (tag === 0x0132) fallback = toDate(ascii(e));
        if (tag === 0x8769) {
          for (const x of entries(tiff + u32(e + 8))) if (u16(x) === 0x9003) {
            const d = toDate(ascii(x));
            if (d) return d;
          }
        }
      }
      return fallback;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
    at += 2 + size;
  }
  return null;
};
