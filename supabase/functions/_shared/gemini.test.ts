import { describe, it, expect } from 'vitest';
import {
  FatalError,
  RetryableError,
  runToolLoop,
  toFunctionResponseObject,
  type GeminiClient,
  type GeminiContent,
  type GenerateParams,
} from './gemini';
import type { GeminiFunctionDeclaration } from './tools/types';

/**
 * function calling 迴圈是 LINE 文字路徑的骨幹：模型先查、再提議，
 * 而 Gemini 3 的 thoughtSignature 一旦沒有原樣送回就是 400。
 * 這些性質沒辦法靠真機測試釘住（要打網路、要花額度），所以在這裡用假 client 測。
 */

const DECLARATIONS: GeminiFunctionDeclaration[] = [
  { name: 'list_expenses', description: 'list', parameters: { type: 'object', properties: {} } },
  { name: 'get_balance', description: 'balance', parameters: { type: 'object', properties: {} } },
  { name: 'reply', description: 'reply', parameters: { type: 'object', properties: {} } },
  { name: 'propose_expenses', description: 'propose', parameters: { type: 'object', properties: {} } },
];

const TERMINALS = ['propose_expenses', 'reply'];

/** 一則 model turn：帶幾個 functionCall */
function modelCalls(...calls: { name: string; args?: Record<string, unknown> }[]): GeminiContent {
  return { role: 'model', parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } })) };
}

/**
 * 把「第幾次呼叫回什麼」寫成腳本的假 client。
 * `calls` 記下每一次收到的 params，斷言就靠它。
 */
function scriptedClient(script: (GeminiContent | Error)[]): GeminiClient & { calls: GenerateParams[] } {
  const calls: GenerateParams[] = [];
  return {
    calls,
    generate(params: GenerateParams) {
      calls.push(params);
      const next = script.shift();
      if (!next) throw new Error('scripted client ran out of responses');
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  };
}

const base = (client: GeminiClient) => ({
  client,
  models: ['model-a', 'model-b'],
  contents: [{ role: 'user' as const, parts: [{ text: '嗨' }] }],
  declarations: DECLARATIONS,
  terminalNames: TERMINALS,
  execute: () => Promise.resolve({ ok: true }),
});

describe('runToolLoop', () => {
  it('先跑讀取工具，再由終結函式收尾', async () => {
    const client = scriptedClient([
      modelCalls({ name: 'list_expenses', args: { keyword: '拉麵' } }),
      modelCalls({ name: 'reply', args: { text: '找到了' } }),
    ]);
    const executed: string[] = [];
    const result = await runToolLoop({
      ...base(client),
      execute: (name) => {
        executed.push(name);
        return Promise.resolve({ count: 1 });
      },
    });

    expect(executed).toEqual(['list_expenses']);
    expect(result.call).toEqual({ name: 'reply', args: { text: '找到了' } });
    expect(result.model).toBe('model-a');

    // 第二輪送出去的 contents：原始那則 + 模型的 call + 我們的 functionResponse
    const second = client.calls[1].contents;
    expect(second).toHaveLength(3);
    expect(second[2].role).toBe('user');
    expect(second[2].parts[0].functionResponse).toEqual({
      name: 'list_expenses',
      response: { count: 1 },
    });
  });

  it('同一輪有多個 functionCall 時，functionResponse 依同順序排好', async () => {
    const client = scriptedClient([
      modelCalls({ name: 'get_balance' }, { name: 'list_expenses' }),
      modelCalls({ name: 'reply', args: { text: 'ok' } }),
    ]);
    await runToolLoop({
      ...base(client),
      execute: (name) => Promise.resolve({ from: name }),
    });

    const responses = client.calls[1].contents[2].parts;
    expect(responses.map((p) => p.functionResponse?.name)).toEqual(['get_balance', 'list_expenses']);
    expect(responses.map((p) => p.functionResponse?.response)).toEqual([
      { from: 'get_balance' },
      { from: 'list_expenses' },
    ]);
  });

  it('模型回的 content 原樣保留，thoughtSignature 不能被吃掉', async () => {
    const signed: GeminiContent = {
      role: 'model',
      parts: [{ functionCall: { name: 'list_expenses', args: {} }, thoughtSignature: 'sig-abc' }],
    };
    const client = scriptedClient([signed, modelCalls({ name: 'reply', args: { text: 'ok' } })]);
    await runToolLoop(base(client));

    const echoed = client.calls[1].contents[1];
    expect(echoed).toBe(signed);
    expect(echoed.parts[0].thoughtSignature).toBe('sig-abc');
  });

  it('最後一輪加上 allowedFunctionNames 強迫收尾', async () => {
    const client = scriptedClient([
      modelCalls({ name: 'list_expenses' }),
      modelCalls({ name: 'reply', args: { text: 'ok' } }),
    ]);
    await runToolLoop({ ...base(client), maxRounds: 2 });

    // 第一輪不限制、第二輪（＝最後一輪）限制成只能叫終結函式
    expect(client.calls[0].toolConfig?.functionCallingConfig).toEqual({ mode: 'ANY' });
    expect(client.calls[1].toolConfig?.functionCallingConfig).toEqual({
      mode: 'ANY',
      allowedFunctionNames: TERMINALS,
    });
  });

  it('已經超過 deadline 時第一輪就強迫收尾', async () => {
    const client = scriptedClient([modelCalls({ name: 'reply', args: { text: 'ok' } })]);
    await runToolLoop({ ...base(client), deadlineAt: Date.now() - 1000 });

    expect(client.calls[0].toolConfig?.functionCallingConfig.allowedFunctionNames).toEqual(TERMINALS);
  });

  it('中途遇到可重試錯誤就換模型，並從原始 contents 重來', async () => {
    const client = scriptedClient([
      modelCalls({ name: 'list_expenses' }),
      new RetryableError('HTTP 429'),
      modelCalls({ name: 'reply', args: { text: 'ok' } }),
    ]);
    const result = await runToolLoop(base(client));

    expect(result.model).toBe('model-b');
    // 第三次呼叫是換模型之後的第一輪：contents 必須只剩原始那一則，
    // 不能帶著前一個模型的 thoughtSignature（那會直接 400）
    expect(client.calls[2].model).toBe('model-b');
    expect(client.calls[2].contents).toHaveLength(1);
    expect(client.calls[2].contents[0].parts[0].text).toBe('嗨');
  });

  it('propose_* 與 reply 同一輪時，reply 的文字要一起帶回去', async () => {
    const client = scriptedClient([
      modelCalls(
        { name: 'reply', args: { text: '幫你記好了，確認一下' } },
        { name: 'propose_expenses', args: { expenses: [{ description: '晚餐', amount: 300 }] } },
      ),
    ]);
    const result = await runToolLoop(base(client));

    expect(result.call.name).toBe('propose_expenses');
    expect(result.extraText).toBe('幫你記好了，確認一下');
  });

  it('完全沒有 functionCall 時，把文字當成 reply', async () => {
    const client = scriptedClient([
      { role: 'model', parts: [{ text: '今天總共 1200 元' }] },
    ]);
    const result = await runToolLoop(base(client));

    expect(result.call).toEqual({ name: 'reply', args: { text: '今天總共 1200 元' } });
  });

  it('連文字都沒有就換下一個模型', async () => {
    const client = scriptedClient([
      { role: 'model', parts: [{ text: '' }] },
      modelCalls({ name: 'reply', args: { text: 'ok' } }),
    ]);
    const result = await runToolLoop(base(client));
    expect(result.model).toBe('model-b');
  });

  it('FatalError 直接往外丟，不換模型', async () => {
    const client = scriptedClient([new FatalError('Gemini 400 (schema/tool)')]);
    await expect(runToolLoop(base(client))).rejects.toThrow('schema/tool');
    expect(client.calls).toHaveLength(1);
  });

  it('所有模型都失敗時丟出 RATE_LIMIT 前綴的錯誤', async () => {
    const client = scriptedClient([
      new RetryableError('HTTP 429'),
      new RetryableError('HTTP 429'),
    ]);
    await expect(runToolLoop(base(client))).rejects.toThrow(/^RATE_LIMIT:/);
  });

  it('工具丟例外時把錯誤回給模型，不中斷迴圈', async () => {
    const client = scriptedClient([
      modelCalls({ name: 'list_expenses' }),
      modelCalls({ name: 'reply', args: { text: 'ok' } }),
    ]);
    await runToolLoop({
      ...base(client),
      execute: () => Promise.reject(new Error('db down')),
    });

    expect(client.calls[1].contents[2].parts[0].functionResponse?.response).toEqual({ error: 'db down' });
  });
});

describe('toFunctionResponseObject', () => {
  it('物件原樣通過', () => {
    expect(toFunctionResponseObject({ count: 2 })).toEqual({ count: 2 });
  });

  it('陣列與純值包成 { result }（functionResponse 只收物件）', () => {
    expect(toFunctionResponseObject([1, 2])).toEqual({ result: [1, 2] });
    expect(toFunctionResponseObject('hi')).toEqual({ result: 'hi' });
    expect(toFunctionResponseObject(null)).toEqual({ result: null });
  });

  it('太大就截斷並標記', () => {
    const huge = { rows: Array.from({ length: 2000 }, (_, i) => `expense-${i}`) };
    const out = toFunctionResponseObject(huge);
    expect(out.truncated).toBe(true);
    expect(String(out.result).length).toBe(6000);
  });
});
