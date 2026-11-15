import { describe, it, expect } from 'vitest';
import { executeAll, unwrapPseudoCall } from './loop';

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

describe('unwrapPseudoCall', () => {
  it('把寫成文字的 reply(...) 拆回內容', () => {
    expect(unwrapPseudoCall('reply(text="這筆是日幣還是台幣？")')).toBe('這筆是日幣還是台幣？');
    expect(unwrapPseudoCall('reply("好喔")')).toBe('好喔');
    expect(unwrapPseudoCall('reply(text="第一行\\n第二行")')).toBe('第一行\n第二行');
  });

  it('一般文字原樣回傳', () => {
    expect(unwrapPseudoCall('今天花了 3000 日幣')).toBe('今天花了 3000 日幣');
    expect(unwrapPseudoCall('可以 reply("x") 嗎')).toBe('可以 reply("x") 嗎');
  });
});
