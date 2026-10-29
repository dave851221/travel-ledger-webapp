import { afterEach, describe, it, expect, vi } from 'vitest';
import { QUOTA_COOLDOWN_MS, withFallback } from './fallback';
import type { AiProvider, AiTask, FallbackReason, GenerateRequest } from './types';

/** 記下被叫了幾次、做什麼都回固定結果（或固定失敗）的假供應商 */
function fakeProvider(name: string, opts: { fail?: Error; noAudio?: boolean } = {}): AiProvider & { calls: string[] } {
  const calls: string[] = [];
  const run = (what: string) => {
    calls.push(what);
    return opts.fail ? Promise.reject(opts.fail) : Promise.resolve(name);
  };
  return {
    name,
    calls,
    supports: (task: AiTask) => !(opts.noAudio && task === 'audio'),
    generate: (req: GenerateRequest) => run(`generate:${req.task}`),
    runToolLoop: () => run('loop').then((model) => ({ kind: 'terminal' as const, call: { name: 'reply', args: {} }, model })),
  };
}

const req = (task: AiTask): GenerateRequest => ({ task, messages: [{ role: 'user', parts: [{ text: '嗨' }] }] });

afterEach(() => { vi.useRealTimers(); });

describe('withFallback', () => {
  it('主要的成功就不碰備援', async () => {
    const claude = fakeProvider('claude');
    const gemini = fakeProvider('gemini');
    expect(await withFallback(claude, gemini).generate(req('vision'))).toBe('claude');
    expect(gemini.calls).toEqual([]);
  });

  it('主要的失敗時改用備援（文字迴圈也一樣）', async () => {
    const claude = fakeProvider('claude', { fail: new Error('AI_BUSY: Claude failed') });
    const gemini = fakeProvider('gemini');
    const ai = withFallback(claude, gemini);
    expect(await ai.generate(req('vision'))).toBe('gemini');
    expect((await ai.runToolLoop({} as never)).model).toBe('gemini');
  });

  it('主要的做不到（語音）就直接交給備援，不先試一次', async () => {
    const claude = fakeProvider('claude', { noAudio: true });
    const gemini = fakeProvider('gemini');
    expect(await withFallback(claude, gemini).generate(req('audio'))).toBe('gemini');
    expect(claude.calls).toEqual([]);
  });

  it('兩邊都失敗時丟備援的錯誤', async () => {
    const claude = fakeProvider('claude', { fail: new Error('AI_QUOTA: limit') });
    const gemini = fakeProvider('gemini', { fail: new Error('RATE_LIMIT: free quota') });
    await expect(withFallback(claude, gemini).generate(req('text'))).rejects.toThrow(/^RATE_LIMIT:/);
  });

  it('改用備援時通知呼叫端是額度用完還是其他錯誤', async () => {
    const reasons: FallbackReason[] = [];
    const onFallback = (r: FallbackReason) => reasons.push(r);
    const gemini = fakeProvider('gemini');
    await withFallback(fakeProvider('claude', { fail: new Error('AI_QUOTA: limit') }), gemini).generate({ ...req('text'), onFallback });
    await withFallback(fakeProvider('claude', { fail: new Error('AI_BUSY: timeout') }), gemini).generate({ ...req('text'), onFallback });
    expect(reasons).toEqual(['quota', 'error']);
  });

  it('語音直接交給備援是預期的分工，不通知', async () => {
    const reasons: FallbackReason[] = [];
    await withFallback(fakeProvider('claude', { noAudio: true }), fakeProvider('gemini'))
      .generate({ ...req('audio'), onFallback: (r) => reasons.push(r) });
    expect(reasons).toEqual([]);
  });

  it('額度用完之後一段時間內直接用備援，不再先白打一次', async () => {
    vi.useFakeTimers();
    const claude = fakeProvider('claude', { fail: new Error('AI_QUOTA: limit') });
    const ai = withFallback(claude, fakeProvider('gemini'));
    const reasons: FallbackReason[] = [];
    const onFallback = (r: FallbackReason) => reasons.push(r);

    await ai.generate({ ...req('text'), onFallback });
    await ai.generate({ ...req('text'), onFallback });
    expect(claude.calls).toHaveLength(1);
    expect(reasons).toEqual(['quota', 'quota']);

    vi.advanceTimersByTime(QUOTA_COOLDOWN_MS + 1);
    await ai.generate({ ...req('text'), onFallback });
    expect(claude.calls).toHaveLength(2);
  });

  it('沒有備援時原樣回傳主要的', () => {
    const claude = fakeProvider('claude');
    expect(withFallback(claude)).toBe(claude);
  });
});
