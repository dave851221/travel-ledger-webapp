import type { PhotoAsset } from './images';
import type { PersonSpending, RecapFact, RecapStat, SpendingRace } from './facts';
import type { OutroSegment, RecapDay, RecapPhoto, Segment, ShotSegment, Timeline, TransitionKind } from './plan';

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

export interface RecapContent {
  tripName: string;
  /** e.g. 2026.11.14 — 11.22 */
  dateLabel: string;
  members: string[];
  stats: RecapStat[];
  /** 趣味統計 (fun facts), shown on their own page after the numbers */
  facts?: RecapFact[];
  /** Trip length in days; photos outside it get no "Day N" */
  tripDays?: number;
  /** 每個人的花錢重點 */
  people?: PersonSpending[] | null;
  /** 花費賽跑: everyone's running total by day */
  race?: SpendingRace | null;
  /** Formats a base-currency amount for the race; leave out to hide the numbers */
  raceMoney?: (amount: number) => string;
  /** e.g. ¥8,850 for a photo's expense; leave out to hide amounts */
  amountLabel?: (photo: RecapPhoto) => string | null;
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
    ...content.stats.flatMap(s => [s.label, s.prefix ?? '', s.suffix ?? '', String(s.value)]),
    ...(content.facts ?? []).flatMap(f => [f.label, f.value, f.detail]),
    ...(content.people ?? []).flatMap(p => [p.member, ...p.categories.map(c => c.name)]), '旅途小彩蛋誰花得最多每個人的花錢重點凌晨晚上', ...extra,
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
  // Two-step bottom shade: light over the photo, darker behind the caption so white text reads even on white paper
  shade(ctx, H * 0.45, H * 0.62, 0, 0.3);
  shade(ctx, H * 0.62, H, 0.3, 0.72);
};

const formatStat = (stat: RecapStat, x: number): string => {
  if (typeof stat.value === 'string') return stat.value;
  const n = Math.round(stat.value * x);
  return n.toLocaleString('en-US');
};

/** The trip's own colours, blurred, drifting behind the numbers; `which` picks other photos for another page */
const drawTripBlur = (ctx: Ctx, scene: RecapScene, local: number, which: number) => {
  ctx.fillStyle = NAVY_DEEP;
  ctx.fillRect(0, 0, W, H);
  const shots = scene.timeline.segments.filter((s): s is ShotSegment => s.kind === 'shot');
  const pick = (k: number) => (shots.length > 0 ? scene.photo(shots[Math.floor(k * shots.length) % shots.length].photo.path) : null);
  const bgA = pick(which ? 0.3 : 0);
  const bgB = shots.length > 1 ? pick(which ? 0.8 : 0.5) : null;
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
};

const kickerLine = (ctx: Ctx, text: string, y: number, local: number, b: number) => {
  ctx.font = `500 34px ${SANS}`;
  ctx.fillStyle = ACCENT;
  let width = 0;
  riseText(ctx, () => { width = spacedText(ctx, text, MARGIN, y, 10); }, MARGIN, y, 50, span(local, b * 0.25, 0.8));
  if (!width) width = [...text].length * 44;
  ctx.fillRect(MARGIN + width + 22, y - 12, 120 * easeOutExpo(span(local, b * 0.5, 1)), 3);
};

/** 趣味統計：一行小標、一個大答案、一行補充，一拍一拍升上來 */
const drawFacts = (ctx: Ctx, scene: RecapScene, seg: Segment, t: number) => {
  const { timeline, content } = scene;
  const b = timeline.beat;
  const local = t - seg.start;
  drawTripBlur(ctx, scene, local, 1);
  const top = 470;
  kickerLine(ctx, '旅途小彩蛋', top, local, b);
  const facts = content.facts ?? [];
  const rowH = Math.min(210, 1000 / Math.max(1, facts.length));
  facts.forEach((fact, i) => {
    const y = top + 110 + i * rowH;
    const appear = b * (0.5 + i * 0.9);
    const p = span(local, appear, 0.7);
    if (p <= 0) return;
    ctx.save();
    ctx.font = `500 32px ${SANS}`;
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    riseText(ctx, () => ctx.fillText(fact.label, MARGIN, y), MARGIN, y, 44, p);
    const vy = y + Math.min(78, rowH * 0.4);
    let size = Math.min(66, rowH * 0.34);
    ctx.font = `700 ${size}px ${SANS}`;
    while (size > 40 && ctx.measureText(fact.value).width > W - MARGIN * 2) {
      size -= 3;
      ctx.font = `700 ${size}px ${SANS}`;
    }
    ctx.fillStyle = '#ffffff';
    riseText(ctx, () => ctx.fillText(fitText(ctx, fact.value, W - MARGIN * 2), MARGIN, vy), MARGIN, vy, size * 1.2, span(local, appear + 0.08, 0.9));
    ctx.font = `500 32px ${SANS}`;
    ctx.fillStyle = ACCENT;
    ctx.globalAlpha = clamp01((local - appear - 0.3) / 0.5);
    ctx.fillText(fitText(ctx, fact.detail, W - MARGIN * 2), MARGIN, vy + 50);
    ctx.restore();
  });
};

const RACE_COLORS = ['#f2a93b', '#4fc1b0', '#ef7a6b', '#8e8cf0', '#5aa9e6', '#a6d16b', '#f28fb8', '#c9a26b'];

/**
 * 花費賽跑：每人累積花費一天一天長出來，名次交換時長條平滑地換位置
 * （每半天定一次名次，中間滑過去，不會一格一格跳，也不會因為金額接近而疊在一起）。
 */
const drawRace = (ctx: Ctx, scene: RecapScene, seg: Segment, t: number) => {
  const { timeline, content } = scene;
  const race = content.race;
  const b = timeline.beat;
  const local = t - seg.start;
  drawTripBlur(ctx, scene, local, 1);
  const top = 470;
  kickerLine(ctx, '誰花得最多', top, local, b);
  if (!race) return;

  const members = Object.keys(race.totals);
  const days = race.dates.length;
  const run = Math.max(1, seg.end - seg.start - 0.6 - 1.8);
  const f = clamp01((local - 0.6) / run) * days;
  const k = Math.min(days - 1, Math.floor(f));
  const valuesAt = (x: number) => {
    const day = Math.min(days - 1, Math.floor(x));
    const frac = x >= days ? 1 : easeInOutCubic(x - Math.floor(x));
    return members.map(m => lerp(day === 0 ? 0 : race.totals[m][day - 1], race.totals[m][day], frac));
  };
  const ranksAt = (x: number) => {
    const v = valuesAt(x);
    const order = members.map((_, i) => i).sort((a, c) => v[c] - v[a] || a - c);
    const rank: number[] = [];
    order.forEach((idx, r) => { rank[idx] = r; });
    return rank;
  };
  const values = valuesAt(f);
  const max = Math.max(1, ...values);
  // Places are decided every half day and slide over, so close totals never sit on top of each other
  const STEP = 0.5;
  const g = f / STEP;
  const r0 = ranksAt(Math.floor(g) * STEP);
  const r1 = ranksAt(Math.min(days, Math.ceil(g) * STEP));
  const slide = easeInOutCubic(g - Math.floor(g));

  // Which day the race is on
  const date = race.dates[k];
  const dayP = span(local, b * 0.5, 0.8);
  ctx.save();
  ctx.globalAlpha = easeOutCubic(dayP);
  ctx.font = `800 120px ${NUM}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`DAY ${String(k + 1).padStart(2, '0')}`, MARGIN, top + 150);
  ctx.font = `600 40px ${NUM}`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(shortDate(date), MARGIN + 6, top + 210);
  ctx.restore();

  const areaTop = top + 290;
  const slot = Math.min(118, 700 / Math.max(1, members.length));
  const barH = slot * 0.62;
  const nameW = 190;
  const barX = MARGIN + nameW;
  const barMax = W - MARGIN - barX - 210;
  const appear = span(local, b * 0.75, 0.8);
  members.forEach((m, i) => {
    const v = values[i];
    const rank = lerp(r0[i], r1[i], slide);
    const y = areaTop + rank * slot;
    const color = RACE_COLORS[i % RACE_COLORS.length];
    ctx.save();
    ctx.globalAlpha = easeOutCubic(clamp01(appear * 1.6 - i * 0.12));
    ctx.font = `700 40px ${SANS}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, m, nameW - 20), MARGIN, y + barH * 0.72);
    const w = Math.max(barH * 0.3, (barMax * v) / max);
    ctx.fillStyle = color;
    roundRect(ctx, barX, y, w, barH, barH / 2);
    ctx.fill();
    if (content.raceMoney) {
      ctx.font = `700 36px ${NUM}`;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(content.raceMoney(Math.round(v)), barX + w + 18, y + barH * 0.7);
    }
    ctx.restore();
  });
};

/** 每個人的花錢重點：一人一列，最多三個分類疊成一條，寫出最大的那一類占幾成 */
const drawPeople = (ctx: Ctx, scene: RecapScene, seg: Segment, t: number) => {
  const { timeline, content } = scene;
  const b = timeline.beat;
  const local = t - seg.start;
  drawTripBlur(ctx, scene, local, 0);
  const top = 470;
  kickerLine(ctx, '每個人的花錢重點', top, local, b);
  const rows = (content.people ?? []).slice(0, 6);
  if (rows.length === 0) return;
  // One colour per category across everyone, so the same category matches between rows
  const colorOf = new Map<string, string>();
  for (const r of rows) for (const c of r.categories) if (!colorOf.has(c.name)) colorOf.set(c.name, RACE_COLORS[colorOf.size % RACE_COLORS.length]);
  const rowH = Math.min(200, 1000 / rows.length);
  const barW = W - MARGIN * 2;
  rows.forEach((r, i) => {
    const y = top + 110 + i * rowH;
    const appear = b * (0.5 + i * 0.8);
    const p = span(local, appear, 0.9);
    if (p <= 0) return;
    ctx.save();
    riseText(ctx, () => {
      ctx.font = `700 46px ${SANS}`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(r.member, MARGIN, y);
      if (content.raceMoney) {
        ctx.font = `700 38px ${NUM}`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.textAlign = 'right';
        ctx.fillText(content.raceMoney(r.total), W - MARGIN, y);
        ctx.textAlign = 'left';
      }
    }, MARGIN, y, 60, p);
    // Stacked bar of the top categories, growing in from the left
    const grow = easeOutCubic(span(local, appear + 0.2, 1.1));
    const by = y + 26;
    const bh = Math.min(34, rowH * 0.18);
    ctx.globalAlpha = clamp01(p * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, MARGIN, by, barW, bh, bh / 2);
    ctx.fill();
    ctx.save();
    roundRect(ctx, MARGIN, by, barW * grow, bh, bh / 2);
    ctx.clip();
    let x = MARGIN;
    for (const c of r.categories) {
      const w = (barW * c.share) / 100;
      ctx.fillStyle = colorOf.get(c.name) ?? ACCENT;
      ctx.fillRect(x, by, w, bh);
      x += w;
    }
    ctx.restore();
    const lead = r.categories[0];
    if (lead) {
      ctx.globalAlpha = clamp01((local - appear - 0.5) / 0.5);
      ctx.font = `500 32px ${SANS}`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      const rest = r.categories.slice(1).map(c => `${c.name} ${c.share}%`).join('   ');
      ctx.fillText(fitText(ctx, `最多花在 ${lead.name} ${lead.share}%${rest ? `   ${rest}` : ''}`, barW), MARGIN, by + bh + 44);
    }
    ctx.restore();
  });
};

const drawStats = (ctx: Ctx, scene: RecapScene, seg: Segment, t: number) => {
  const { timeline, content } = scene;
  const b = timeline.beat;
  const local = t - seg.start;
  drawTripBlur(ctx, scene, local, 0);

  const top = 500;
  kickerLine(ctx, '這趟旅程', top, local, b);

  const rowH = Math.min(230, 980 / Math.max(1, content.stats.length));
  const numSize = Math.min(140, rowH * 0.64);
  content.stats.forEach((stat, i) => {
    const y = top + 60 + numSize + i * rowH;
    const appear = b * (0.5 + i * 0.75);
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
  else if (seg.kind === 'facts') drawFacts(ctx, scene, seg, t);
  else if (seg.kind === 'race') drawRace(ctx, scene, seg, t);
  else if (seg.kind === 'people') drawPeople(ctx, scene, seg, t);
  else drawOutro(ctx, scene, seg, t, T);
  ctx.restore();
};

// --- Overlays that sit above transitions -----------------------------------

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const shortDate = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${date.slice(5, 7)}.${date.slice(8, 10)}  ${WEEKDAYS[d.getUTCDay()]}`;
};

/** The three lines under each photo: when, what, where (and how much, if amounts are on) */
/** The three caption lines a photo gets in the video: when, what, where (and how much) */
export const photoLabelLines = (photo: RecapPhoto, day: RecapDay, content: RecapContent): [string, string, string] => {
  const inTrip = day.dayNumber >= 1 && (!content.tripDays || day.dayNumber <= content.tripDays);
  const kicker = inTrip ? `DAY ${String(day.dayNumber).padStart(2, '0')}   ${shortDate(day.date)}` : shortDate(day.date);
  const amount = content.amountLabel?.(photo) ?? '';
  const where = day.city ?? '';
  const main = photo.caption || where || shortDate(day.date);
  const sub = [main === where ? '' : where, amount].filter(Boolean).join('  ·  ');
  return [kicker, main, sub];
};

const labelLines = (scene: RecapScene, seg: ShotSegment): [string, string, string] =>
  photoLabelLines(seg.photo, seg.day, scene.content);

/**
 * 每張照片自己的說明（第幾天、日期、這是什麼、在哪裡）。
 * 跟上一張一樣的那一行留在原地，換了內容的那一行才淡出、再從遮罩裡升上來，換張時字不會整塊跳動。
 */
const drawPhotoLabel = (ctx: Ctx, scene: RecapScene, t: number, T: number) => {
  const segs = scene.timeline.segments;
  const idx = segs.findIndex(s => s.kind === 'shot' && t >= s.start && t < s.end);
  if (idx < 0) return;
  const seg = segs[idx] as ShotSegment;
  const prev = segs[idx - 1]?.kind === 'shot' ? labelLines(scene, segs[idx - 1] as ShotSegment) : null;
  const next = segs[idx + 1]?.kind === 'shot' ? labelLines(scene, segs[idx + 1] as ShotSegment) : null;
  const lines = labelLines(scene, seg);
  const since = t - seg.start;
  const leaving = clamp01((t - (seg.end - T / 2)) / (T / 2));

  const base = H - SAFE_BOTTOM - 10;
  const slots = [
    { y: base - 150, h: 46 },
    { y: base - 62, h: 84 },
    { y: base, h: 50 },
  ];
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 28;
  const draws = [
    () => {
      ctx.font = `700 32px ${NUM}`;
      ctx.fillStyle = ACCENT;
      spacedText(ctx, lines[0], MARGIN, slots[0].y, 4);
    },
    () => {
      // Long names shrink a little before they get an ellipsis
      let size = 68;
      ctx.font = `700 ${size}px ${SANS}`;
      while (size > 50 && ctx.measureText(lines[1]).width > W - MARGIN * 2) {
        size -= 3;
        ctx.font = `700 ${size}px ${SANS}`;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fitText(ctx, lines[1], W - MARGIN * 2), MARGIN, slots[1].y);
    },
    () => {
      ctx.font = `500 36px ${SANS}`;
      ctx.fillStyle = 'rgba(255,255,255,0.84)';
      ctx.fillText(fitText(ctx, lines[2], W - MARGIN * 2), MARGIN, slots[2].y);
    },
  ];
  draws.forEach((draw, i) => {
    if (!lines[i]) return;
    const stays = prev !== null && prev[i] === lines[i];
    const goes = next === null || next[i] !== lines[i];
    const inP = stays ? 1 : clamp01((since - i * 0.08) / 0.6);
    ctx.save();
    ctx.globalAlpha = goes ? 1 - leaving : 1;
    riseText(ctx, draw, MARGIN, slots[i].y, slots[i].h, inP);
    ctx.restore();
  });
  // Accent rule beside the label: grows in on the first photo, then stays
  const firstShot = prev === null;
  const tick = firstShot ? easeOutExpo(clamp01(since / 0.8)) : 1;
  const lastLine = lines[2] ? 2 : 1;
  ctx.globalAlpha = next === null ? 1 - leaving : 1;
  ctx.fillStyle = ACCENT;
  ctx.fillRect(MARGIN - 34, slots[0].y - 30, 5, (slots[lastLine].y - slots[0].y + 40) * tick);
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
        drawBlurred(ctx, blurs, 'xy', a, q * 0.55, 1 + 0.25 * q);
      } else {
        const q = easeOutCubic((p - 0.5) * 2);
        drawBlurred(ctx, blurs, 'xy', b, (1 - q) * 0.55, 1.2 - 0.2 * q);
      }
      // A soft white bloom right at the cut
      const flash = 1 - Math.abs(p - 0.5) * 6;
      if (flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${flash * 0.15})`;
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'whip': {
      const e = easeInOutQuint(p);
      const amt = Math.sin(Math.PI * p) * 0.8;
      drawBlurred(ctx, blurs, 'x', a, amt, 1, -W * e);
      drawBlurred(ctx, blurs, 'x', b, amt, 1, W * (1 - e));
      break;
    }
    case 'rise': {
      const e = easeInOutQuint(p);
      const amt = Math.sin(Math.PI * p) * 0.8;
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

// Short cuts: long blurry transitions on one-second photos read as flicker
export const transitionLength = (tl: Timeline) => Math.min(0.32, Math.max(0.22, tl.beat * 0.5));

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
    drawPhotoLabel(ctx, this.scene, t, T);
  }

  dispose() {
    this.layerA.width = this.layerA.height = 1;
    this.layerB.width = this.layerB.height = 1;
    this.blurs.dispose();
  }
}
