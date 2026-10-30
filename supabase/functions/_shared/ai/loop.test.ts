import { describe, it, expect } from 'vitest';
import { executeAll } from './loop';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('executeAll', () => {
  it('同一輪的工具同時執行，結果照呼叫順序排', async () => {
    let running = 0;
    let peak = 0;
    const execute = async (name: string) => {
      running++;
      peak = Math.max(peak, running);
      await delay(name === 'a' ? 30 : 5);
      running--;
      return { name };
    };
    const results = await executeAll(execute, [
      { name: 'a', args: {} }, { name: 'b', args: {} }, { name: 'c', args: {} },
    ]);
    expect(peak).toBe(3);
    expect(results).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  });

  it('其中一支失敗只影響它自己，變成 { error }', async () => {
    const execute = async (name: string) => {
      if (name === 'bad') throw new Error('boom');
      return { ok: name };
    };
    const results = await executeAll(execute, [{ name: 'good', args: {} }, { name: 'bad', args: {} }]);
    expect(results).toEqual([{ ok: 'good' }, { error: 'boom' }]);
  });
});
