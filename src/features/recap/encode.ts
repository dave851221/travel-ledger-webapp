import type { PhotoStore } from './images';
import { FPS, RecapRenderer, VIDEO_H, VIDEO_W, ensureFonts, pathsNear, type RecapScene } from './render';

/**
 * 把畫面一格一格畫出來交給 WebCodecs 壓成 H.264，再跟合成好的音樂（AAC）封裝成 MP4。
 * 全程在瀏覽器裡，不上傳、不寫資料庫。mediabunny 只在按下「產生影片」時才下載。
 *
 * iPhone（iOS 16.4 以上）、Android Chrome、電腦版 Chrome／Edge／Safari 都有 H.264 編碼器；
 * 沒有 AAC 編碼器的瀏覽器（Firefox、部分 Safari）改用 mediabunny 的 WASM 版。
 */

export interface EncodeSupport {
  ok: boolean;
  width: number;
  height: number;
  reason?: string;
}

export const checkSupport = async (): Promise<EncodeSupport> => {
  if (typeof VideoEncoder === 'undefined') {
    return { ok: false, width: 0, height: 0, reason: '這個瀏覽器還不支援在手機上產生影片，請把 iOS 更新到 16.4 以上，或改用 Chrome。' };
  }
  const { canEncodeVideo } = await import('mediabunny');
  for (const [width, height] of [[VIDEO_W, VIDEO_H], [720, 1280]] as const) {
    if (await canEncodeVideo('avc', { width, height })) return { ok: true, width, height };
  }
  return { ok: false, width: 0, height: 0, reason: '這台裝置沒有可用的 H.264 編碼器，無法產生 MP4。' };
};

/** Photo labels need their glyphs too */
export const dayTexts = (scene: RecapScene): string[] =>
  scene.timeline.segments.flatMap(s => (s.kind === 'shot'
    ? [s.day.city ?? '', s.photo.caption, scene.content.amountLabel?.(s.photo) ?? '']
    : []));

export interface EncodeOptions {
  scene: RecapScene;
  store: PhotoStore;
  audio: AudioBuffer | null;
  width: number;
  height: number;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

export const encodeRecap = async ({ scene, store, audio, width, height, onProgress, signal }: EncodeOptions): Promise<Blob> => {
  const mb = await import('mediabunny');
  await ensureFonts(scene.content, dayTexts(scene));
  if (audio && !(await mb.canEncodeAudio('aac'))) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new RecapRenderer(canvas, scene);

  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new mb.BufferTarget(),
  });
  const video = new mb.CanvasSource(canvas, {
    codec: 'avc',
    // IG re-encodes anyway; 8 Mbps keeps a 40-second clip around 40 MB
    bitrate: width >= 1080 ? 8_000_000 : 5_000_000,
    keyFrameInterval: 1,
  });
  output.addVideoTrack(video, { frameRate: FPS });
  let sound: InstanceType<typeof mb.AudioBufferSource> | null = null;
  if (audio) {
    sound = new mb.AudioBufferSource({ codec: 'aac', bitrate: 192_000 });
    output.addAudioTrack(sound);
  }

  try {
    await output.start();
    if (sound && audio) await sound.add(audio);

    const { duration } = scene.timeline;
    const frames = Math.round(duration * FPS);
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const t = f / FPS;
      // Decode the next few photos, free the rest (keeps memory flat on phones)
      if (f % 10 === 0) await store.keepOnly(pathsNear(scene.timeline, t, 1.5));
      renderer.draw(t);
      await video.add(t, 1 / FPS);
      if (f % 6 === 0) onProgress(f / frames);
    }
    sound?.close();
    video.close();
    await output.finalize();
    onProgress(1);
    const buffer = (output.target as InstanceType<typeof mb.BufferTarget>).buffer;
    if (!buffer) throw new Error('Empty output');
    return new Blob([buffer], { type: 'video/mp4' });
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
  } finally {
    renderer.dispose();
    canvas.width = canvas.height = 1;
  }
};
