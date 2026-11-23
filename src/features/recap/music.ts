import type { Timeline } from './plan';

/**
 * 回顧影片的背景音樂：用 Web Audio 在瀏覽器裡「現場合成」。
 *
 * 不放任何音檔 —— 旋律、和弦、鼓組都是這支程式算出來的，沒有版權問題，上傳 IG 不會被消音。
 * 段落跟著 Timeline 的拍點走：開場是濾波器慢慢打開的鋪底，照片段落（drop）鼓組進來，
 * 統計數字那段抽掉大鼓留空間，結尾再回來一次然後淡出。
 */

export type MusicStyle = 'bright' | 'warm' | 'none';

export const MUSIC_STYLES: { key: MusicStyle; label: string; hint: string; bpm: number }[] = [
  { key: 'bright', label: '輕快', hint: '電子流行，節奏感強', bpm: 118 },
  { key: 'warm', label: '溫暖', hint: 'Lo-fi 爵士和弦，比較放鬆', bpm: 92 },
  { key: 'none', label: '不要音樂', hint: '只有畫面', bpm: 112 },
];

export const styleBpm = (style: MusicStyle): number => MUSIC_STYLES.find(s => s.key === style)?.bpm ?? 112;

interface Chord { bass: number; notes: number[] }

const BRIGHT_CHORDS: Chord[] = [
  { bass: 41, notes: [57, 60, 64, 67] }, // Fmaj9
  { bass: 45, notes: [55, 60, 64, 69] }, // Am7
  { bass: 38, notes: [57, 60, 62, 65] }, // Dm9
  { bass: 46, notes: [57, 62, 65, 69] }, // Bbmaj7
];

const WARM_CHORDS: Chord[] = [
  { bass: 38, notes: [53, 57, 60, 64] }, // Dm9
  { bass: 43, notes: [53, 59, 64, 69] }, // G13
  { bass: 36, notes: [52, 55, 59, 62] }, // Cmaj9
  { bass: 45, notes: [55, 61, 65, 67] }, // A7b13
];

// Four bars of eighth notes, null = rest. Stays on the F/C major pentatonic so it fits every chord.
const BRIGHT_HOOK: (number | null)[] = [
  76, null, 74, null, 72, null, 69, 72, null, null, 72, 74, 76, null, null, null,
  74, null, 72, null, 69, null, 67, 69, null, null, null, null, 65, 67, 69, null,
];
const WARM_HOOK: (number | null)[] = [
  null, null, 69, 72, 74, null, 72, null, null, null, null, null, 71, null, 67, null,
  null, null, 67, 69, 71, null, 74, null, 72, null, null, null, null, null, null, null,
];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Deterministic noise so the same trip always gets the same track */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const noiseBuffer = (ctx: BaseAudioContext, seconds: number, seed = 7): AudioBuffer => {
  const rand = seeded(seed);
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
  return buf;
};

const impulse = (ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer => {
  const rand = seeded(42);
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = (rand() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
};

interface Rig {
  ctx: OfflineAudioContext;
  /** Pads, bass and keys: ducked on every kick */
  duck: GainNode;
  /** Drums and leads: straight to the master */
  dry: GainNode;
  reverb: GainNode;
  delay: GainNode;
  delayNode: DelayNode;
  noise: AudioBuffer;
}

const buildRig = (ctx: OfflineAudioContext, duration: number): Rig => {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.78;
  // Fade the very end so the video doesn't stop on a cliff
  master.gain.setValueAtTime(0.78, Math.max(0, duration - 2.4));
  master.gain.linearRampToValueAtTime(0, duration - 0.05);
  comp.connect(master).connect(ctx.destination);

  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 2.6, 3);
  const verbOut = ctx.createGain();
  verbOut.gain.value = 0.35;
  verb.connect(verbOut).connect(comp);
  const reverb = ctx.createGain();
  reverb.connect(verb);

  const delayIn = ctx.createGain();
  const delayNode = ctx.createDelay(2);
  const feedback = ctx.createGain();
  feedback.gain.value = 0.32;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 3200;
  delayIn.connect(delayNode);
  delayNode.connect(delayTone).connect(feedback).connect(delayNode);
  const delayOut = ctx.createGain();
  delayOut.gain.value = 0.28;
  delayTone.connect(delayOut).connect(comp);

  const duck = ctx.createGain();
  duck.connect(comp);
  duck.connect(reverb);
  const dry = ctx.createGain();
  dry.connect(comp);

  return { ctx, duck, dry, reverb, delay: delayIn, delayNode, noise: noiseBuffer(ctx, 2) };
};

const env = (g: AudioParam, t: number, peak: number, attack: number, hold: number, release: number) => {
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  g.setValueAtTime(peak, t + attack + hold);
  g.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
};

// --- Instruments -----------------------------------------------------------

const kick = (r: Rig, t: number, gain = 1, low = false) => {
  const { ctx } = r;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(low ? 110 : 150, t);
  o.frequency.exponentialRampToValueAtTime(low ? 42 : 46, t + 0.12);
  env(g.gain, t, 0.95 * gain, 0.002, 0.02, low ? 0.28 : 0.36);
  o.connect(g).connect(r.dry);
  o.start(t);
  o.stop(t + 0.5);
  // Click for definition on phone speakers
  const c = ctx.createBufferSource();
  c.buffer = r.noise;
  const cf = ctx.createBiquadFilter();
  cf.type = 'highpass';
  cf.frequency.value = 3000;
  const cg = ctx.createGain();
  env(cg.gain, t, 0.12 * gain, 0.001, 0, 0.015);
  c.connect(cf).connect(cg).connect(r.dry);
  c.start(t, 0.3, 0.05);
};

const duckAt = (r: Rig, t: number, beat: number, depth = 0.4) => {
  const g = r.duck.gain;
  g.setValueAtTime(1, t);
  g.linearRampToValueAtTime(depth, t + 0.012);
  g.linearRampToValueAtTime(1, t + beat * 0.7);
};

const noiseHit = (
  r: Rig, t: number, type: BiquadFilterType, freq: number, q: number,
  peak: number, decay: number, out: AudioNode, offset = 0,
) => {
  const s = r.ctx.createBufferSource();
  s.buffer = r.noise;
  const f = r.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = r.ctx.createGain();
  env(g.gain, t, peak, 0.002, 0, decay);
  s.connect(f).connect(g).connect(out);
  s.start(t, offset % 1.5, decay + 0.1);
};

const clap = (r: Rig, t: number, gain = 1) => {
  // A real clap is a few hands slightly apart
  [0, 0.011, 0.022].forEach((dt, i) => noiseHit(r, t + dt, 'bandpass', 1500, 1.2, 0.5 * gain, i === 2 ? 0.16 : 0.03, r.dry, 0.1 * i));
  noiseHit(r, t + 0.022, 'bandpass', 1700, 0.8, 0.18 * gain, 0.25, r.reverb, 0.7);
};

const snareSoft = (r: Rig, t: number) => {
  noiseHit(r, t, 'bandpass', 2200, 0.9, 0.22, 0.12, r.dry, 0.4);
  noiseHit(r, t, 'lowpass', 900, 0.7, 0.18, 0.08, r.dry, 0.9);
  noiseHit(r, t, 'bandpass', 2000, 0.6, 0.08, 0.3, r.reverb, 1.1);
};

const hat = (r: Rig, t: number, open = false, gain = 1) =>
  noiseHit(r, t, 'highpass', 8000, 0.7, (open ? 0.12 : 0.09) * gain, open ? 0.2 : 0.035, r.dry, t * 0.37);

const crash = (r: Rig, t: number) => {
  noiseHit(r, t, 'highpass', 5000, 0.5, 0.22, 1.6, r.dry, 0.2);
  noiseHit(r, t, 'highpass', 4000, 0.5, 0.12, 2.2, r.reverb, 0.6);
};

const riser = (r: Rig, t: number, length: number) => {
  const { ctx } = r;
  const s = ctx.createBufferSource();
  s.buffer = r.noise;
  s.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 2;
  f.frequency.setValueAtTime(400, t);
  f.frequency.exponentialRampToValueAtTime(7000, t + length);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + length);
  g.gain.linearRampToValueAtTime(0, t + length + 0.02);
  s.connect(f).connect(g);
  g.connect(r.dry);
  g.connect(r.reverb);
  s.start(t);
  s.stop(t + length + 0.05);
};

/** Detuned saws through a low-pass: the wide, soft chord bed */
const pad = (r: Rig, t: number, length: number, notes: number[], cutoffFrom: number, cutoffTo: number, gain = 1) => {
  const { ctx } = r;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.7;
  f.frequency.setValueAtTime(cutoffFrom, t);
  f.frequency.exponentialRampToValueAtTime(cutoffTo, t + length);
  const g = ctx.createGain();
  env(g.gain, t, 0.07 * gain, 0.18, Math.max(0, length - 0.3), 0.5);
  f.connect(g);
  g.connect(r.duck);
  g.connect(r.reverb);
  for (const n of notes) {
    for (const detune of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(n);
      o.detune.value = detune;
      o.connect(f);
      o.start(t);
      o.stop(t + length + 0.7);
    }
  }
};

const bassNote = (r: Rig, t: number, length: number, midi: number, gain = 1) => {
  const { ctx } = r;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = hz(midi);
  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.value = hz(midi + 12);
  const g2 = ctx.createGain();
  g2.gain.value = 0.25;
  const g = ctx.createGain();
  env(g.gain, t, 0.42 * gain, 0.01, Math.max(0, length - 0.08), 0.06);
  o.connect(g);
  o2.connect(g2).connect(g);
  g.connect(r.duck);
  o.start(t);
  o2.start(t);
  o.stop(t + length + 0.1);
  o2.stop(t + length + 0.1);
};

const pluck = (r: Rig, t: number, midi: number, gain = 1, wet = true) => {
  const { ctx } = r;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = hz(midi);
  const o2 = ctx.createOscillator();
  o2.type = 'square';
  o2.frequency.value = hz(midi);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(5000, t);
  f.frequency.exponentialRampToValueAtTime(700, t + 0.25);
  const mix = ctx.createGain();
  mix.gain.value = 0.18;
  const g = ctx.createGain();
  env(g.gain, t, 0.16 * gain, 0.003, 0.02, 0.32);
  o.connect(f);
  o2.connect(mix).connect(f);
  f.connect(g);
  g.connect(r.dry);
  if (wet) {
    g.connect(r.delay);
    g.connect(r.reverb);
  }
  o.start(t);
  o2.start(t);
  o.stop(t + 0.5);
  o2.stop(t + 0.5);
};

/** Electric-piano-ish: sine plus a decaying bell partial */
const keys = (r: Rig, t: number, length: number, notes: number[], gain = 1) => {
  const { ctx } = r;
  for (const n of notes) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz(n);
    const bell = ctx.createOscillator();
    bell.type = 'sine';
    bell.frequency.value = hz(n) * 4;
    const bg = ctx.createGain();
    env(bg.gain, t, 0.025 * gain, 0.002, 0, 0.35);
    const g = ctx.createGain();
    env(g.gain, t, 0.07 * gain, 0.006, Math.max(0, length * 0.4), length * 0.8 + 0.4);
    o.connect(g);
    bell.connect(bg).connect(g);
    g.connect(r.duck);
    g.connect(r.reverb);
    o.start(t);
    bell.start(t);
    o.stop(t + length + 1.4);
    bell.stop(t + 0.5);
  }
};

const vinyl = (r: Rig, from: number, to: number) => {
  const rand = seeded(99);
  for (let t = from; t < to; t += 0.05 + rand() * 0.35) {
    noiseHit(r, t, 'highpass', 2500, 0.5, 0.02 + rand() * 0.03, 0.006, r.dry, rand());
  }
  const s = r.ctx.createBufferSource();
  s.buffer = r.noise;
  s.loop = true;
  const f = r.ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1200;
  f.Q.value = 0.4;
  const g = r.ctx.createGain();
  g.gain.value = 0.012;
  s.connect(f).connect(g).connect(r.dry);
  s.start(from);
  s.stop(to);
};

// --- Arrangement -------------------------------------------------------------

const arrangeBright = (r: Rig, tl: Timeline) => {
  const b = tl.beat;
  const { drop, stats, outro, end } = tl.marks;
  r.delayNode.delayTime.value = b * 0.75;
  const chordAt = (beatIndex: number) => BRIGHT_CHORDS[Math.floor(beatIndex / 4) % 4];

  for (let bar = 0; bar * 4 < end; bar++) {
    const beat0 = bar * 4;
    const t = beat0 * b;
    const chord = chordAt(beat0);
    const inIntro = beat0 < drop;
    const inStats = beat0 >= stats && beat0 < outro;
    const lastBar = beat0 + 4 >= end;
    const length = 4 * b;

    if (lastBar) {
      // Final chord rings out
      pad(r, t, length + 1, BRIGHT_CHORDS[0].notes, 2600, 1200, 1.1);
      bassNote(r, t, length, BRIGHT_CHORDS[0].bass, 0.9);
      crash(r, t);
      kick(r, t);
      continue;
    }
    if (inIntro) {
      const p = beat0 / drop;
      pad(r, t, length, chord.notes, 300 + 1500 * p, 500 + 2400 * p, 0.9);
    } else {
      pad(r, t, length, chord.notes, inStats ? 1200 : 2200, inStats ? 1600 : 3200);
    }

    for (let s = 0; s < 8; s++) {
      const st = t + s * b / 2;
      // Arp: chord tones an octave up, rolling pattern
      const arpNote = chord.notes[[0, 2, 1, 3, 2, 1, 3, 2][s]] + 12;
      pluck(r, st, arpNote, inIntro ? 0.35 + 0.4 * (beat0 / drop) : inStats ? 0.55 : 0.45);
      if (!inIntro && !inStats) {
        const hook = BRIGHT_HOOK[(Math.floor((beat0 - drop) / 4) % 4) * 8 + s];
        if (hook && beat0 >= drop + 8) pluck(r, st, hook, 0.75);
        if (s % 2 === 1) hat(r, st, s === 7 && bar % 2 === 1);
        else hat(r, st + b / 4, false, 0.5);
        if (s % 2 === 1) bassNote(r, st, b / 2 - 0.02, chord.bass + 12, 0.8);
        else if (s === 0) bassNote(r, st, b / 2 - 0.02, chord.bass, 0.9);
      }
      if (inStats && s % 2 === 1) hat(r, st, false, 0.6);
    }

    if (!inIntro && !inStats) {
      for (let k = 0; k < 4; k++) {
        kick(r, t + k * b);
        duckAt(r, t + k * b, b);
      }
      clap(r, t + b);
      clap(r, t + 3 * b);
      if (beat0 === drop || beat0 === outro) crash(r, t);
    }
    if (inStats) {
      clap(r, t + 2 * b, 0.8);
      kick(r, t, 0.7);
      duckAt(r, t, b * 2, 0.6);
    }
    // Build-ups into the drop and back out of the breakdown
    if (beat0 + 4 === drop || beat0 + 4 === outro) {
      riser(r, t, length);
      [0, 0.5, 1, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75].forEach((x, i) => clap(r, t + x * b, 0.25 + i * 0.05));
    }
  }
};

const arrangeWarm = (r: Rig, tl: Timeline) => {
  const b = tl.beat;
  const { drop, stats, outro, end } = tl.marks;
  r.delayNode.delayTime.value = b * 0.5;
  const swing = b * 0.08;
  vinyl(r, 0, tl.duration);

  for (let bar = 0; bar * 4 < end; bar++) {
    const beat0 = bar * 4;
    const t = beat0 * b;
    const chord = WARM_CHORDS[bar % 4];
    const inIntro = beat0 < drop;
    const inStats = beat0 >= stats && beat0 < outro;
    const lastBar = beat0 + 4 >= end;

    if (lastBar) {
      keys(r, t, 4 * b, WARM_CHORDS[2].notes, 1.2);
      bassNote(r, t, 3 * b, WARM_CHORDS[2].bass, 0.8);
      continue;
    }
    // Chord on 1, a push on the "and" of 2
    keys(r, t, 1.4 * b, chord.notes, inIntro ? 0.8 : 1);
    keys(r, t + 1.5 * b + swing, 1.2 * b, chord.notes, inIntro ? 0.6 : 0.8);
    if (!inIntro) {
      bassNote(r, t, 1.4 * b, chord.bass, 0.9);
      bassNote(r, t + 2.5 * b + swing, 1.2 * b, chord.bass + 7, 0.7);
    }

    for (let s = 0; s < 8; s++) {
      const st = t + s * b / 2 + (s % 2 ? swing : 0);
      if (!inIntro || beat0 >= 4) hat(r, st, false, s % 2 ? 0.45 : 0.7);
      if (!inIntro && !inStats) {
        const hook = WARM_HOOK[(Math.floor((beat0 - drop) / 4) % 4) * 8 + s];
        if (hook && beat0 >= drop + 8) pluck(r, st, hook, 0.6);
      }
    }
    if (!inIntro && !inStats) {
      kick(r, t, 0.85, true);
      kick(r, t + 2.5 * b + swing, 0.6, true);
      duckAt(r, t, b, 0.55);
      snareSoft(r, t + b);
      snareSoft(r, t + 3 * b);
    }
    if (inStats) snareSoft(r, t + 3 * b);
    if (beat0 + 4 === drop) riser(r, t + 2 * b, 2 * b);
  }
};

/**
 * Renders the whole track for this timeline. A 40-second track takes about a second offline.
 * Returns null for "no music" — the caller adds no audio track at all.
 */
export const renderMusic = async (style: MusicStyle, tl: Timeline, sampleRate = 48000): Promise<AudioBuffer | null> => {
  if (style === 'none') return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(tl.duration * sampleRate), sampleRate);
  const rig = buildRig(ctx, tl.duration);
  if (style === 'warm') arrangeWarm(rig, tl);
  else arrangeBright(rig, tl);
  return ctx.startRendering();
};
