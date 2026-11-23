import type { PhotoAsset } from './images';
import type { OutroSegment, RecapDay, Segment, ShotSegment, Timeline, TransitionKind } from './plan';

/**
 * 回顧影片的畫面：給一個時間 t（秒），畫出那一格。
 * 不靠任何外部套件與 ctx.filter（Safari 舊版沒有），模糊一律用「縮小再放大」與多次疊畫來做。
 * 所有座標都以 1080×1920 計算，預覽用的小畫布只是先 scale 一次。
 *
 * 版面避開 IG Reels 的介面：上方 220px、下方 420px 不放字（帳號列、說明文字、按鈕會蓋住）。
 */

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const FPS = 30;

const W = VIDEO_W;
const H = VIDEO_H;
const SAFE_BOTTOM = 440;
const MARGIN = 84;

const ACCENT = '#f2a93b';
const NAVY = '#14213d';
const NAVY_DEEP = '#0a1122';

const SANS = "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif";
const NUM = "'Manrope', 'Noto Sans TC', system-ui, sans-serif";

export interface RecapStat {
  label: string;
  /** A number counts up; a string just appears */
  value: number | string;
  prefix?: string;
  suffix?: string;
}

export interface RecapContent {
  tripName: string;
  /** e.g. 2026.11.14 — 11.22 */
  dateLabel: string;
  members: string[];
  stats: RecapStat[];
}

export interface RecapScene {
  timeline: Timeline;
  content: RecapContent;
  photo: (path: string) => PhotoAsset | null;
}

/**
 * Canvas text uses whatever font is loaded at draw time, and the web fonts load lazily
 * (Google Fonts splits Noto Sans TC by character), so ask for exactly the glyphs the video uses.
 */
export const ensureFonts = async (content: RecapContent, extra: string[] = []): Promise<void> => {
  if (typeof document === 'undefined' || !document.fonts) return;
  const text = [
    content.tripName, content.dateLabel, ...content.members, '旅行回顧這趟旅程旅遊小本本週日一二三四五六…·',
    ...content.stats.flatMap(s => [s.label, s.prefix ?? '', s.suffix ?? '', String(s.value)]), ...extra,
  ].join('');
  const jobs = [
    ...['500', '700'].map(w => document.fonts.load(`${w} 40px 'Noto Sans TC'`, text)),
    ...['600', '700', '800'].map(w => document.fonts.load(`${w} 40px 'Manrope'`, 'DAY0123456789.,—$NT¥€')),
  ];
  await Promise.race([Promise.allSettled(jobs), new Promise(r => setTimeout(r, 4000))]);
};

// --- Easing ---------------------------------------------------------------

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeInOutQuint = (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2);
const easeInCubic = (x: number) => x * x * x;
/** 0→1 over [from, from + length] */
const span = (t: number, from: number, length: number) => clamp01((t - from) / length);
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;

// --- Drawing helpers -------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

/** Draws `asset` so it covers the box, scaled by `zoom` around its centre plus an offset */
const drawCover = (ctx: Ctx, img: CanvasImageSource, iw: number, ih: number, x: number, y: number, w: number, h: number, zoom = 1, dx = 0, dy = 0) => {
  const s = Math.max(w / iw, h / ih) * zoom;
  const dw = iw * s;
  const dh = ih * s;
  // Keep the pan inside the picture so no edge shows
  const maxX = Math.max(0, (dw - w) / 2);
  const maxY = Math.max(0, (dh - h) / 2);
  const ox = Math.max(-maxX, Math.min(maxX, dx));
  const oy = Math.max(-maxY, Math.min(maxY, dy));
  ctx.drawImage(img, x + (w - dw) / 2 + ox, y + (h - dh) / 2 + oy, dw, dh);
};

const drawBlurCover = (ctx: Ctx, asset: PhotoAsset, zoom: number, darken: number) => {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawCover(ctx, asset.blur, asset.blur.width, asset.blur.height, 0, 0, W, H, zoom);
  ctx.fillStyle = `rgba(6, 10, 20, ${darken})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
};

const roundRect = (ctx: Ctx, x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

/** Text with tracking; canvas letterSpacing is not everywhere yet */
const spacedText = (ctx: Ctx, text: string, x: number, y: number, spacing: number, align: 'left' | 'center' = 'left') => {
  const chars = [...text];
  const widths = chars.map(c => ctx.measureText(c).width);
  const total = widths.reduce<number>((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + spacing;
  });
  ctx.textAlign = prev;
  return total;
};

/** Greedy wrap that works for Chinese (no spaces) and keeps Latin words whole */
export const wrapText = (measure: (s: string) => number, text: string, maxWidth: number, maxLines: number): string[] => {
  const tokens = text.match(/[A-Za-z0-9'’.,:&-]+\s*|\s+|./gu) ?? [];
  const lines: string[] = [];
  let line = '';
  for (const tok of tokens) {
    const next = line + tok;
    if (line && measure(next.trimEnd()) > maxWidth) {
      lines.push(line.trimEnd());
      line = tok.trimStart();
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line.trim()) lines.push(line.trimEnd());
  else if (lines.length === maxLines && line.trim()) {
    // Out of room: ellipsis on the last line
    let last = lines[maxLines - 1];
    while (last && measure(last + '…') > maxWidth) last = [...last].slice(0, -1).join('');
    lines[maxLines - 1] = last + '…';
  }
  return lines;
};

const fitText = (ctx: Ctx, text: string, maxWidth: number) => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s && ctx.measureText(s + '…').width > maxWidth) s = [...s].slice(0, -1).join('');
  return s + '…';
};

/** A line that slides up out of a mask (the "modern title" reveal) */
const riseText = (ctx: Ctx, draw: () => void, x: number, y: number, lineHeight: number, progress: number, maskWidth = W) => {
  if (progress <= 0) return;
  const e = easeOutExpo(progress);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 20, y - lineHeight * 0.95, maskWidth, lineHeight * 1.3);
  ctx.clip();
  ctx.translate(0, (1 - e) * lineHeight * 0.9);
  ctx.globalAlpha *= clamp01(progress * 3);
  draw();
  ctx.restore();
};

const shade = (ctx: Ctx, from: number, to: number, alphaTop: number, alphaBottom: number) => {
  const g = ctx.createLinearGradient(0, from, 0, to);
  g.addColorStop(0, `rgba(5, 8, 16, ${alphaTop})`);
  g.addColorStop(1, `rgba(5, 8, 16, ${alphaBottom})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, from, W, to - from);
};

const vignette = (ctx: Ctx, strength: number) => {
  const g = ctx.createRadialGradient(W / 2, H * 0.48, H * 0.32, W / 2, H * 0.5, H * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
};

// --- Photo with Ken Burns -------------------------------------------------

interface Motion { zoomFrom: number; zoomTo: number; dx: number; dy: number }

const MOTIONS: Motion[] = [
  { zoomFrom: 1.04, zoomTo: 1.14, dx: -30, dy: 0 },
  { zoomFrom: 1.15, zoomTo: 1.05, dx: 34, dy: -20 },
  { zoomFrom: 1.06, zoomTo: 1.14, dx: 0, dy: 40 },
  { zoomFrom: 1.14, zoomTo: 1.04, dx: -36, dy: 24 },
  { zoomFrom: 1.05, zoomTo: 1.13, dx: 30, dy: -30 },
];

/** Full-bleed for portrait shots; landscape ones sit in a full-width frame over their own blur */
const drawPhoto = (ctx: Ctx, asset: PhotoAsset | null, u: number, motion: Motion, frameCenter = 0.45) => {
  if (!asset) {
    ctx.fillStyle = NAVY_DEEP;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const zoom = lerp(motion.zoomFrom, motion.zoomTo, u);
  const pan = u - 0.5;
  const landscape = asset.width / asset.height > 1.15;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (!landscape) {
    drawCover(ctx, asset.image, asset.width, asset.height, 0, 0, W, H, zoom, motion.dx * pan * 2, motion.dy * pan * 2);
  } else {
    drawBlurCover(ctx, asset, 1.25 + 0.08 * u, 0.32);
    const fw = W;
    const fh = Math.round(W / Math.min(asset.width / asset.height, 1.9));
    const fy = Math.round(H * frameCenter - fh / 2);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 60;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, fy, fw, fh);
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.rect(0, fy, fw, fh);
    ctx.clip();
    const z = 1 + (zoom - 1) * 0.6;
    drawCover(ctx, asset.image, asset.width, asset.height, 0, fy, fw, fh, z, motion.dx * pan * 3, 0);
  }
  ctx.restore();
};

// --- Segments --------------------------------------------------------------

const segWindow = (seg: Segment, t: number, T: number) =>
  clamp01((t - (seg.start - T / 2)) / (seg.end - seg.start + T));

const firstPhoto = (scene: RecapScene) => {
  const s = scene.timeline.segments.find((x): x is ShotSegment => x.kind === 'shot');
  return s ? scene.photo(s.photo.path) : null;
};

const drawIntro = (ctx: Ctx, scene: RecapScene, t: number) => {
  const { content, timeline } = scene;
  const b = timeline.beat;
  const bg = firstPhoto(scene);
  if (bg) {
    drawBlurCover(ctx, bg, 1.2 + t * 0.01, 0.2);
    ctx.globalAlpha = 0.55;
    drawPhoto(ctx, bg, clamp01(t / (timeline.segments[0].end + 0.5)), { zoomFrom: 1.2, zoomTo: 1.1, dx: 0, dy: 0 });
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = NAVY;
    ctx.fillRect(0, 0, W, H);
  }
  shade(ctx, 0, H, 0.55, 0.85);

  ctx.textBaseline = 'alphabetic';
  // Kicker + accent rule
  const ky = 760;
  ctx.font = `500 34px ${SANS}`;
  ctx.fillStyle = ACCENT;
  riseText(ctx, () => spacedText(ctx, '旅行回顧', MARGIN, ky, 10), MARGIN, ky, 50, span(t, b * 0.5, 0.9));
  const rule = easeOutExpo(span(t, b * 1, 1.2));
  ctx.fillStyle = ACCENT;
  ctx.fillRect(MARGIN + 196, ky - 12, 120 * rule, 3);

  // Title
  ctx.font = `700 100px ${SANS}`;
  const lines = wrapText(s => ctx.measureText(s).width, content.tripName, W - MARGIN * 2, 3);
  const lh = 128;
  lines.forEach((line, i) => {
    const y = ky + 150 + i * lh;
    ctx.fillStyle = '#ffffff';
    riseText(ctx, () => ctx.fillText(line, MARGIN, y), MARGIN, y, lh, span(t, b * (1.5 + i * 0.5), 1.1));
  });

  const after = ky + 150 + lines.length * lh + 20;
  ctx.font = `600 44px ${NUM}`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  riseText(ctx, () => ctx.fillText(content.dateLabel, MARGIN, after), MARGIN, after, 60, span(t, b * 3.5, 1));
  ctx.font = `500 38px ${SANS}`;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  const members = fitText(ctx, content.members.join('  ·  '), W - MARGIN * 2);
  riseText(ctx, () => ctx.fillText(members, MARGIN, after + 74), MARGIN, after + 74, 56, span(t, b * 4.25, 1));

  // Fade in from black
  const fade = 1 - span(t, 0, 0.8);
  if (fade > 0) {
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, W, H);
  }
};

const drawShot = (ctx: Ctx, scene: RecapScene, seg: ShotSegment, t: number, T: number) => {
  const u = segWindow(seg, t, T);
  drawPhoto(ctx, scene.photo(seg.photo.path), u, MOTIONS[seg.index % MOTIONS.length]);
  shade(ctx, 0, 300, 0.28, 0);
  shade(ctx, H * 0.55, H, 0, 0.62);
};

const formatStat = (stat: RecapStat, x: number): string => {
  if (typeof stat.value === 'string') return stat.value;
  const n = Math.round(stat.value * x);
  return n.toLocaleString('en-US');
};

const drawStats = (ctx: Ctx, scene: RecapScene, seg: Segment, t: number) => {
  const { timeline, content } = scene;
  const b = timeline.beat;
  const local = t - seg.start;
  ctx.fillStyle = NAVY_DEEP;
  ctx.fillRect(0, 0, W, H);
  // The trip's own colours, blurred, drifting behind the numbers
  const shots = timeline.segments.filter((s): s is ShotSegment => s.kind === 'shot');
  const bgA = shots[0] ? scene.photo(shots[0].photo.path) : null;
  const bgB = shots.length > 1 ? scene.photo(shots[Math.floor(shots.length / 2)].photo.path) : null;
  if (bgA) drawBlurCover(ctx, bgA, 1.3 + local * 0.02, 0);
  if (bgB) {
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(local * 0.5);
    drawBlurCover(ctx, bgB, 1.5 - local * 0.02, 0);
    ctx.globalAlpha = 1;
  }
  const tint = ctx.createLinearGradient(0, 0, 0, H);
  tint.addColorStop(0, 'rgba(10,17,34,0.72)');
  tint.addColorStop(1, 'rgba(10,17,34,0.88)');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, W, H);

  const top = 500;
  ctx.font = `500 34px ${SANS}`;
  ctx.fillStyle = ACCENT;
  riseText(ctx, () => spacedText(ctx, '這趟旅程', MARGIN, top, 10), MARGIN, top, 50, span(local, b * 0.25, 0.8));
  ctx.fillRect(MARGIN + 196, top - 12, 120 * easeOutExpo(span(local, b * 0.5, 1)), 3);

  const rowH = Math.min(230, 980 / Math.max(1, content.stats.length));
  const numSize = Math.min(140, rowH * 0.64);
  content.stats.forEach((stat, i) => {
    const y = top + 60 + numSize + i * rowH;
    const appear = b * (1 + i * 1.5);
    const p = span(local, appear, 0.9);
    if (p <= 0) return;
    const count = easeOutCubic(span(local, appear, b * 2.2));
    const big = typeof stat.value === 'string' ? numSize * 0.72 : numSize;
    ctx.save();
    riseText(ctx, () => {
      let x = MARGIN;
      if (stat.prefix) {
        ctx.font = `700 56px ${NUM}`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(stat.prefix, x, y);
        x += ctx.measureText(stat.prefix).width + 12;
      }
      ctx.font = typeof stat.value === 'string' ? `700 ${big}px ${SANS}` : `800 ${big}px ${NUM}`;
      ctx.fillStyle = '#ffffff';
      const text = typeof stat.value === 'string' ? fitText(ctx, stat.value, W - MARGIN * 2) : formatStat(stat, count);
      ctx.fillText(text, x, y);
      x += ctx.measureText(text).width + 16;
      if (stat.suffix) {
        ctx.font = `700 52px ${SANS}`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(stat.suffix, x, y);
      }
    }, MARGIN, y, big * 1.05, p);
    ctx.font = `500 34px ${SANS}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.globalAlpha = clamp01((local - appear - 0.2) / 0.5);
    ctx.fillText(stat.label, MARGIN, y + 54);
    ctx.restore();
  });
};

/** The ticket logo, drawn so it doesn't depend on an icon font */
const drawBrandMark = (ctx: Ctx, x: number, y: number, size: number) => {
  ctx.save();
  ctx.fillStyle = ACCENT;
  roundRect(ctx, x, y, size, size, size * 0.29);
  ctx.fill();
  const tw = size * 0.56;
  const th = size * 0.4;
  const tx = x + (size - tw) / 2;
  const ty = y + (size - th) / 2;
  ctx.strokeStyle = NAVY;
  ctx.lineWidth = size * 0.07;
  ctx.lineJoin = 'round';
  const notch = th * 0.22;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx + tw, ty);
  ctx.lineTo(tx + tw, ty + th / 2 - notch);
  ctx.arc(tx + tw, ty + th / 2, notch, -Math.PI / 2, Math.PI / 2, true);
  ctx.lineTo(tx + tw, ty + th);
  ctx.lineTo(tx, ty + th);
  ctx.lineTo(tx, ty + th / 2 + notch);
  ctx.arc(tx, ty + th / 2, notch, Math.PI / 2, -Math.PI / 2, true);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([size * 0.05, size * 0.05]);
  ctx.lineWidth = size * 0.05;
  ctx.beginPath();
  ctx.moveTo(tx + tw * 0.62, ty + th * 0.18);
  ctx.lineTo(tx + tw * 0.62, ty + th * 0.82);
  ctx.stroke();
  ctx.restore();
};

const drawOutro = (ctx: Ctx, scene: RecapScene, seg: OutroSegment, t: number, T: number) => {
  const { timeline, content } = scene;
  const b = timeline.beat;
  const local = t - seg.start;
  const u = segWindow(seg, t, T);
  const asset = seg.photo ? scene.photo(seg.photo.path) : firstPhoto(scene);
  // Landscape photos sit higher here so the closing text sits under them, not over faces
  drawPhoto(ctx, asset, u, { zoomFrom: 1.16, zoomTo: 1.03, dx: 0, dy: 0 }, 0.33);
  shade(ctx, H * 0.48, H, 0, 0.9);

  const baseY = H - SAFE_BOTTOM - 40;
  ctx.textAlign = 'center';
  ctx.font = `700 64px ${SANS}`;
  ctx.fillStyle = '#ffffff';
  const lines = wrapText(s => ctx.measureText(s).width, content.tripName, W - MARGIN * 2, 2);
  const lh = 84;
  const titleTop = baseY - 260 - (lines.length - 1) * lh;
  lines.forEach((line, i) => {
    const y = titleTop + i * lh;
    riseText(ctx, () => ctx.fillText(line, W / 2, y), 0, y, lh, span(local, b * (0.5 + i * 0.4), 1));
  });
  ctx.font = `500 36px ${SANS}`;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  const members = fitText(ctx, content.members.join('  ·  '), W - MARGIN * 2);
  riseText(ctx, () => ctx.fillText(members, W / 2, baseY - 170), 0, baseY - 170, 52, span(local, b * 1.5, 1));

  // Brand lock-up
  const brandP = span(local, b * 2.5, 1);
  if (brandP > 0) {
    ctx.save();
    ctx.globalAlpha = easeOutCubic(brandP);
    ctx.font = `700 44px ${SANS}`;
    const label = '旅遊小本本';
    const tw = ctx.measureText(label).width;
    const mark = 64;
    const gap = 22;
    const total = mark + gap + tw;
    const x0 = W / 2 - total / 2;
    const y0 = baseY - 40 + (1 - easeOutExpo(brandP)) * 30;
    drawBrandMark(ctx, x0, y0 - mark / 2 - 14, mark);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x0 + mark + gap, y0);
    ctx.restore();
  }
  ctx.textAlign = 'left';

  // Fade out over the last second and a bit
  const out = span(t, timeline.duration - 1.4, 1.3);
  if (out > 0) {
    ctx.fillStyle = `rgba(0,0,0,${easeInCubic(out) * 0.6 + out * 0.4})`;
    ctx.fillRect(0, 0, W, H);
  }
};

const drawSegment = (ctx: Ctx, scene: RecapScene, seg: Segment, t: number, T: number) => {
  ctx.save();
  if (seg.kind === 'intro') drawIntro(ctx, scene, t);
  else if (seg.kind === 'shot') drawShot(ctx, scene, seg, t, T);
  else if (seg.kind === 'stats') drawStats(ctx, scene, seg, t);
  else drawOutro(ctx, scene, seg, t, T);
  ctx.restore();
};

// --- Overlays that sit above transitions -----------------------------------

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const shortDate = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${date.slice(5, 7)}.${date.slice(8, 10)}  ${WEEKDAYS[d.getUTCDay()]}`;
};

/** How long the big day number stays up on a day's first photo */
const dayIntroHold = (seg: ShotSegment) => Math.min(1.1, (seg.end - seg.start) * 0.55);

/** The day's corner label stays put while photos change underneath it */
const drawDayLabel = (ctx: Ctx, scene: RecapScene, t: number, T: number) => {
  const segs = scene.timeline.segments;
  const idx = segs.findIndex(s => s.kind === 'shot' && t >= s.start && t < s.end);
  if (idx < 0) return;
  const day = (segs[idx] as ShotSegment).day;
  const sameDay = (k: number) => segs[k]?.kind === 'shot' && (segs[k] as ShotSegment).day.date === day.date;
  let first = idx;
  while (sameDay(first - 1)) first--;
  let last = idx;
  while (sameDay(last + 1)) last++;
  const opener = segs[first] as ShotSegment;
  // Comes in once the big number has gone, leaves during the first half of the cut out of the day
  const since = t - opener.start - (opener.dayStart ? dayIntroHold(opener) + 0.15 : 0);
  const exit = clamp01((t - (segs[last].end - T / 2)) / (T / 2));
  if (since <= 0 || exit >= 1) return;
  drawDayText(ctx, day, since, 1 - exit);
};

const drawDayText = (ctx: Ctx, day: RecapDay, since: number, alpha: number) => {
  const base = H - SAFE_BOTTOM - 20;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 24;
  const hasPlace = !!(day.city || day.title);
  const main = day.city || shortDate(day.date);
  const sub = day.city ? day.title : undefined;
  const lines: { draw: () => void; y: number; h: number }[] = [];

  let y = base - (sub ? 150 : 96) - (hasPlace ? 56 : 0);
  ctx.font = `700 34px ${NUM}`;
  const kickerY = y;
  lines.push({
    y: kickerY, h: 46, draw: () => {
      ctx.font = `700 34px ${NUM}`;
      ctx.fillStyle = ACCENT;
      const w = spacedText(ctx, `DAY ${String(day.dayNumber).padStart(2, '0')}`, MARGIN, kickerY, 6);
      if (hasPlace) {
        ctx.font = `600 30px ${NUM}`;
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.fillText(shortDate(day.date), MARGIN + w + 26, kickerY);
      }
    },
  });
  y += 96;
  const mainY = y;
  lines.push({
    y: mainY, h: 90, draw: () => {
      ctx.font = `700 76px ${SANS}`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fitText(ctx, main, W - MARGIN * 2), MARGIN, mainY);
    },
  });
  if (sub) {
    y += 64;
    const subY = y;
    lines.push({
      y: subY, h: 52, draw: () => {
        ctx.font = `500 38px ${SANS}`;
        ctx.fillStyle = 'rgba(255,255,255,0.86)';
        ctx.fillText(fitText(ctx, sub, W - MARGIN * 2), MARGIN, subY);
      },
    });
  }
  lines.forEach((l, i) => riseText(ctx, l.draw, MARGIN, l.y, l.h, clamp01((since - i * 0.09) / 0.7)));
  // Accent tick beside the label
  const tick = easeOutExpo(clamp01(since / 0.8));
  ctx.fillStyle = ACCENT;
  ctx.fillRect(MARGIN - 34, kickerY - 30, 5, (y - kickerY + 44) * tick);
  ctx.restore();
};

/** The big day number that opens each day */
const drawDayIntro = (ctx: Ctx, scene: RecapScene, t: number) => {
  const segs = scene.timeline.segments;
  const seg = segs.find((s): s is ShotSegment => s.kind === 'shot' && s.dayStart && t >= s.start - 0.05 && t < s.start + 1.6);
  if (!seg) return;
  const local = t - seg.start;
  const hold = dayIntroHold(seg);
  const inP = clamp01(local / 0.5);
  const outP = clamp01((local - hold) / 0.35);
  if (outP >= 1) return;
  ctx.save();
  // Darken the photo while the number is up
  ctx.fillStyle = `rgba(5,8,16,${0.42 * easeOutCubic(inP) * (1 - outP)})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1 - easeInCubic(outP);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const cy = H * 0.47;
  ctx.font = `700 40px ${NUM}`;
  ctx.fillStyle = ACCENT;
  riseText(ctx, () => spacedText(ctx, 'DAY', W / 2, cy - 250, 14, 'center'), 0, cy - 250, 56, inP);
  const scale = lerp(1.18, 1, easeOutExpo(inP)) + outP * 0.06;
  ctx.translate(W / 2, cy);
  ctx.scale(scale, scale);
  ctx.font = `800 340px ${NUM}`;
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha *= clamp01(inP * 2);
  ctx.fillText(String(seg.day.dayNumber).padStart(2, '0'), 0, 110);
  ctx.restore();
};

// --- Transitions ---------------------------------------------------------

/**
 * Cheap blurs: shrink the layer into a tiny canvas and stretch it back.
 * Shrinking only one axis gives a directional (motion) blur; both axes a soft blur.
 */
class Blurs {
  private x = document.createElement('canvas');
  private y = document.createElement('canvas');
  private xy = document.createElement('canvas');

  constructor(width: number, height: number) {
    this.x.width = Math.max(1, Math.round(width / 28));
    this.x.height = Math.max(1, Math.round(height / 2));
    this.y.width = Math.max(1, Math.round(width / 2));
    this.y.height = Math.max(1, Math.round(height / 28));
    this.xy.width = Math.max(1, Math.round(width / 14));
    this.xy.height = Math.max(1, Math.round(height / 14));
  }

  of(kind: 'x' | 'y' | 'xy', src: CanvasImageSource): HTMLCanvasElement {
    const c = this[kind];
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  dispose() {
    for (const c of [this.x, this.y, this.xy]) c.width = c.height = 1;
  }
}

const drawAt = (ctx: Ctx, src: CanvasImageSource, scale: number, dx = 0, dy = 0) =>
  ctx.drawImage(src, (W - W * scale) / 2 + dx, (H - H * scale) / 2 + dy, W * scale, H * scale);

/** A layer with some blur mixed in, `amount` 0…1 */
const drawBlurred = (ctx: Ctx, blurs: Blurs, kind: 'x' | 'y' | 'xy', src: CanvasImageSource, amount: number, scale = 1, dx = 0, dy = 0) => {
  ctx.globalAlpha = 1;
  drawAt(ctx, src, scale, dx, dy);
  if (amount > 0.03) {
    ctx.globalAlpha = Math.min(1, amount);
    drawAt(ctx, blurs.of(kind, src), scale, dx, dy);
    if (kind === 'xy') {
      // Two faint larger copies give the blur a direction: outward from the centre
      ctx.globalAlpha = 0.22 * amount;
      drawAt(ctx, src, scale * (1 + 0.06 * amount), dx, dy);
      ctx.globalAlpha = 0.12 * amount;
      drawAt(ctx, src, scale * (1 + 0.12 * amount), dx, dy);
    }
  }
  ctx.globalAlpha = 1;
};

const composite = (ctx: Ctx, blurs: Blurs, kind: TransitionKind, a: CanvasImageSource, b: CanvasImageSource, p: number) => {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  switch (kind) {
    case 'zoom': {
      if (p < 0.5) {
        const q = easeInCubic(p * 2);
        drawBlurred(ctx, blurs, 'xy', a, q * 1.3, 1 + 0.5 * q);
      } else {
        const q = easeOutCubic((p - 0.5) * 2);
        drawBlurred(ctx, blurs, 'xy', b, (1 - q) * 1.3, 1.4 - 0.4 * q);
      }
      // A soft white bloom right at the cut
      const flash = 1 - Math.abs(p - 0.5) * 5;
      if (flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${flash * 0.3})`;
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'whip': {
      const e = easeInOutQuint(p);
      const amt = Math.sin(Math.PI * p) * 1.6;
      drawBlurred(ctx, blurs, 'x', a, amt, 1, -W * e);
      drawBlurred(ctx, blurs, 'x', b, amt, 1, W * (1 - e));
      break;
    }
    case 'rise': {
      const e = easeInOutQuint(p);
      const amt = Math.sin(Math.PI * p) * 1.6;
      drawBlurred(ctx, blurs, 'y', a, amt * 0.6, 1, 0, -H * e * 0.35);
      ctx.fillStyle = `rgba(0,0,0,${e * 0.6})`;
      ctx.fillRect(0, 0, W, H);
      drawBlurred(ctx, blurs, 'y', b, amt, 1, 0, H * (1 - e));
      break;
    }
    case 'shutter': {
      const s = 1 - 0.05 * easeInOutCubic(p);
      ctx.drawImage(a, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s);
      ctx.fillStyle = `rgba(0,0,0,${0.5 * p})`;
      ctx.fillRect(0, 0, W, H);
      const bars = 6;
      const bw = W / bars;
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < bars; i++) {
        const local = easeInOutCubic(clamp01((p - i * 0.06) / 0.7));
        const h = H * local;
        ctx.rect(i * bw - 0.5, i % 2 === 0 ? 0 : H - h, bw + 1, h);
      }
      ctx.clip();
      const bs = 1.08 - 0.08 * easeOutCubic(p);
      ctx.drawImage(b, (W - W * bs) / 2, (H - H * bs) / 2, W * bs, H * bs);
      ctx.restore();
      break;
    }
    case 'reveal': {
      const e = easeInOutCubic(p);
      const s = 1 + 0.08 * e;
      ctx.drawImage(a, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s);
      ctx.fillStyle = `rgba(0,0,0,${0.45 * e})`;
      ctx.fillRect(0, 0, W, H);
      const rw = lerp(W * 0.28, W * 1.02, e);
      const rh = lerp(H * 0.2, H * 1.02, e);
      ctx.save();
      roundRect(ctx, (W - rw) / 2, (H - rh) / 2, rw, rh, lerp(60, 0, e));
      ctx.clip();
      const bs = 1.2 - 0.2 * easeOutCubic(p);
      ctx.drawImage(b, (W - W * bs) / 2, (H - H * bs) / 2, W * bs, H * bs);
      ctx.restore();
      break;
    }
    default: {
      ctx.drawImage(a, 0, 0, W, H);
      ctx.globalAlpha = easeInOutCubic(p);
      const s = 1.04 - 0.04 * p;
      ctx.drawImage(b, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s);
    }
  }
  ctx.restore();
};

// --- Renderer --------------------------------------------------------------

export const transitionLength = (tl: Timeline) => Math.min(0.5, Math.max(0.3, tl.beat * 0.72));

/** Which photo paths the frames around `t` need decoded */
export const pathsNear = (tl: Timeline, t: number, ahead = 1.2): string[] => {
  const out = new Set<string>();
  const shots = tl.segments.filter((s): s is ShotSegment => s.kind === 'shot');
  for (const s of tl.segments) {
    if (s.end + 0.6 < t || s.start - ahead > t) continue;
    if (s.kind === 'shot') out.add(s.photo.path);
    if (s.kind === 'outro' && s.photo) out.add(s.photo.path);
    if ((s.kind === 'intro' || (s.kind === 'outro' && !s.photo)) && shots[0]) out.add(shots[0].photo.path);
  }
  return [...out];
};

export class RecapRenderer {
  private ctx: Ctx;
  private layerA: HTMLCanvasElement;
  private layerB: HTMLCanvasElement;
  private blurs: Blurs;
  private scale: number;
  private scene: RecapScene;

  constructor(canvas: HTMLCanvasElement, scene: RecapScene) {
    this.scene = scene;
    this.scale = canvas.width / W;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    const make = () => {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      return c;
    };
    this.layerA = make();
    this.layerB = make();
    this.blurs = new Blurs(canvas.width, canvas.height);
  }

  setScene(scene: RecapScene) {
    this.scene = scene;
  }

  private paint(target: HTMLCanvasElement | null, seg: Segment, t: number, T: number) {
    const ctx = target ? target.getContext('2d')! : this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    drawSegment(ctx, this.scene, seg, t, T);
  }

  draw(t: number) {
    const { timeline } = this.scene;
    const segs = timeline.segments;
    const T = transitionLength(timeline);
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    let i = 0;
    for (let k = segs.length - 1; k >= 0; k--) if (t >= segs[k].start) { i = k; break; }
    const seg = segs[i];
    const next = segs[i + 1];
    let from: number | null = null;
    if (i > 0 && t < seg.start + T / 2) from = i - 1;
    else if (next && t >= next.start - T / 2) from = i;

    if (from === null) {
      this.paint(null, seg, t, T);
    } else {
      const a = segs[from];
      const b = segs[from + 1];
      const p = clamp01((t - (b.start - T / 2)) / T);
      this.paint(this.layerA, a, t, T);
      this.paint(this.layerB, b, t, T);
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      composite(ctx, this.blurs, timeline.transitions[from + 1], this.layerA, this.layerB, p);
    }

    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    vignette(ctx, 0.28);
    drawDayIntro(ctx, this.scene, t);
    drawDayLabel(ctx, this.scene, t, T);
  }

  dispose() {
    this.layerA.width = this.layerA.height = 1;
    this.layerB.width = this.layerB.height = 1;
    this.blurs.dispose();
  }
}
