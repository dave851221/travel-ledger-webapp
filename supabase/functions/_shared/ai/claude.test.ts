import { describe, it, expect } from 'vitest';
// 一定要寫出 .ts —— vitest.config.ts 的 alias 只認得 `deps.ts`，才會換成 Node 版
import { Anthropic } from '../deps.ts';
import {
  classifyClaudeError,
  createClaudeProvider,
  sniffImageType,
  toClaudeMessages,
  toClaudeSchema,
  type ClaudeClient,
} from './claude';
import { FatalError, RetryableError, type FunctionDeclaration } from './types';

/**
 * Claude 這一側同樣用假 client 測：送出去的 request 長什麼樣、
 * 迴圈怎麼把 tool_use 對回 tool_result、錯誤怎麼翻成與 Gemini 同一套語意。
 */

type CreateBody = Anthropic.MessageCreateParamsNonStreaming;

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** 一則假的 Message。只放迴圈會讀到的欄位。 */
function message(content: unknown[], stop_reason = 'tool_use'): Anthropic.Message {
  return { id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, usage } as unknown as Anthropic.Message;
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t });

function scriptedClient(script: (Anthropic.Message | Error)[]): ClaudeClient & { calls: CreateBody[] } {
  const calls: CreateBody[] = [];
  return {
    calls,
    messages: {
      create(body: CreateBody) {
        // 迴圈之後還會 push，留一份當下的快照
        calls.push({ ...body, messages: [...body.messages] });
        const next = script.shift();
        if (!next) return Promise.reject(new Error('scripted client ran out of responses'));
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      },
    },
  };
}

const DECLARATIONS: FunctionDeclaration[] = [
  { name: 'list_expenses', description: 'list', parameters: { type: 'object', properties: {} } },
  { name: 'reply', description: 'reply', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'propose_expenses', description: 'propose', parameters: { type: 'object', properties: {} } },
];

const loopReq = (over: Record<string, unknown> = {}) => ({
  task: 'text' as const,
  messages: [{ role: 'user' as const, parts: [{ text: '嗨' }] }],
  system: '你是耀西',
  declarations: DECLARATIONS,
  terminalNames: ['propose_expenses', 'reply'],
  execute: () => Promise.resolve({ ok: true }),
  ...over,
});

const apiError = (status: number, msg: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: msg } }, undefined, new Headers());

describe('Claude 的格式轉換', () => {
  it('從 base64 開頭判斷圖片格式，不信呼叫端給的提示', () => {
    expect(sniffImageType('iVBORw0KGgoAAA', 'image/jpeg')).toBe('image/png');
    expect(sniffImageType('/9j/4AAQ', 'image/png')).toBe('image/jpeg');
    expect(sniffImageType('????', 'image/webp')).toBe('image/webp');
    expect(sniffImageType('????', 'application/pdf')).toBe('image/jpeg');
  });

  it('文字與圖片轉成 content block，空字串的 text 濾掉', () => {
    expect(toClaudeMessages([
      { role: 'user', parts: [{ text: '' }, { text: '這張' }, { media: { mimeType: 'image/jpeg', data: 'iVBORw0KGgo' } }] },
      { role: 'assistant', parts: [{ text: '好' }] },
    ])).toEqual([
      { role: 'user', content: [
        { type: 'text', text: '這張' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo' } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }] },
    ]);
  });

  it('音訊直接拒絕（Claude 沒有音訊輸入）', () => {
    expect(() => toClaudeMessages([{ role: 'user', parts: [{ media: { mimeType: 'audio/m4a', data: 'x' } }] }]))
      .toThrow(FatalError);
  });

  it('結構化輸出的 schema 每個 object 都補上 additionalProperties: false', () => {
    expect(toClaudeSchema({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'object', properties: { a: { type: 'number' } } } } },
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } } } } },
    });
  });
});

describe('classifyClaudeError', () => {
  it('429、5xx、529 過載、連線失敗都可以重試', () => {
    expect(classifyClaudeError(apiError(429, 'slow down'))).toBeInstanceOf(RetryableError);
    expect(classifyClaudeError(apiError(529, 'overloaded'))).toBeInstanceOf(RetryableError);
    expect(classifyClaudeError(new Anthropic.APIConnectionError({ message: 'timed out' }))).toBeInstanceOf(RetryableError);
  });

  it('額度或儲值用完翻成 AI_QUOTA', () => {
    expect(classifyClaudeError(apiError(400, 'Your credit balance is too low')).message).toMatch(/^AI_QUOTA:/);
    expect(classifyClaudeError(apiError(400, 'You have reached your specified workspace API usage limits')).message).toMatch(/^AI_QUOTA:/);
    expect(classifyClaudeError(apiError(402, 'billing')).message).toMatch(/^AI_QUOTA:/);
  });

  it('金鑰錯誤與其他 400 不重試', () => {
    expect(classifyClaudeError(apiError(401, 'invalid x-api-key'))).toBeInstanceOf(FatalError);
    expect(classifyClaudeError(apiError(400, 'messages: text content blocks must be non-empty'))).toBeInstanceOf(FatalError);
  });
});

describe('createClaudeProvider().generate', () => {
  it('帶上 schema 與 effort，不送 temperature；讀 text block 而不是第一個 block', async () => {
    const client = scriptedClient([message([{ type: 'thinking', thinking: '', signature: 's' }, text('{"type":"expense"}')], 'end_turn')]);
    const provider = createClaudeProvider({ client });
    const out = await provider.generate({
      task: 'vision',
      messages: [{ role: 'user', parts: [{ text: '收據' }] }],
      json: true,
      schema: { type: 'object', properties: { type: { type: 'string' } } },
      temperature: 0.2,
    });

    expect(out).toBe('{"type":"expense"}');
    const body = client.calls[0];
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, properties: { type: { type: 'string' } } } },
    });
  });

  it('不支援語音', async () => {
    const provider = createClaudeProvider({ client: scriptedClient([]) });
    expect(provider.supports('audio')).toBe(false);
    await expect(provider.generate({ task: 'audio', messages: [] })).rejects.toThrow(FatalError);
  });

  it('瞬間的 529 自己補打一次', async () => {
    const client = scriptedClient([apiError(529, 'overloaded'), message([text('好')], 'end_turn')]);
    const out = await createClaudeProvider({ client }).generate({ task: 'text', messages: [{ role: 'user', parts: [{ text: '嗨' }] }] });
    expect(out).toBe('好');
    expect(client.calls).toHaveLength(2);
  });

  it('補打還是失敗就丟 AI_BUSY（不是 Gemini 那種「免費額度用完」）', async () => {
    const client = scriptedClient([apiError(429, 'x'), apiError(429, 'x')]);
    await expect(createClaudeProvider({ client }).generate({ task: 'text', messages: [{ role: 'user', parts: [{ text: '嗨' }] }] }))
      .rejects.toThrow(/^AI_BUSY:/);
  });

  it('額度用完不重試，原樣帶著 AI_QUOTA 往外丟', async () => {
    const client = scriptedClient([apiError(400, 'Your credit balance is too low')]);
    await expect(createClaudeProvider({ client }).generate({ task: 'text', messages: [{ role: 'user', parts: [{ text: '嗨' }] }] }))
      .rejects.toThrow(/^AI_QUOTA:/);
    expect(client.calls).toHaveLength(1);
  });
});

describe('createClaudeProvider().runToolLoop', () => {
  it('先跑讀取工具，tool_result 對回 tool_use 的 id，再由終結函式收尾', async () => {
    const client = scriptedClient([
      message([toolUse('t1', 'list_expenses', { keyword: '拉麵' })]),
      message([toolUse('t2', 'reply', { text: '找到了' })]),
    ]);
    const executed: string[] = [];
    const result = await createClaudeProvider({ client }).runToolLoop(loopReq({
      execute: (name: string) => { executed.push(name); return Promise.resolve({ count: 1 }); },
    }));

    expect(executed).toEqual(['list_expenses']);
    expect(result.call).toEqual({ name: 'reply', args: { text: '找到了' } });
    expect(result.model).toBe('claude-haiku-5-5');

    const first = client.calls[0];
    expect(first.tool_choice).toEqual({ type: 'any' });
    // system 自己一個快取斷點：跨訊息只有 system + tools 是相同的
    expect(first.system).toEqual([{ type: 'text', text: '你是耀西', cache_control: { type: 'ephemeral' } }]);
    expect(first.tools?.map((t) => (t as Anthropic.Tool).name)).toEqual(['list_expenses', 'reply', 'propose_expenses']);

    // 第二輪：原始那則 + 模型的 tool_use（原樣）+ 我們的 tool_result
    const second = client.calls[1].messages;
    expect(second).toHaveLength(3);
    expect(second[1].role).toBe('assistant');
    expect(second[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"count":1}' }],
    });
  });

  it('propose_* 與 reply 同一輪時，reply 的文字一起帶回去', async () => {
    const client = scriptedClient([
      message([toolUse('a', 'reply', { text: '確認一下' }), toolUse('b', 'propose_expenses', { expenses: [] })]),
    ]);
    const result = await createClaudeProvider({ client }).runToolLoop(loopReq());
    expect(result.call.name).toBe('propose_expenses');
    expect(result.extraText).toBe('確認一下');
  });

  it('最後一輪補一句話要求直接收尾', async () => {
    const client = scriptedClient([
      message([toolUse('t1', 'list_expenses')]),
      message([toolUse('t2', 'reply', { text: 'ok' })]),
    ]);
    await createClaudeProvider({ client }).runToolLoop(loopReq({ maxRounds: 2 }));

    const lastUser = client.calls[1].messages[2];
    const blocks = lastUser.content as Anthropic.ContentBlockParam[];
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[1]).toMatchObject({ type: 'text' });
    expect((blocks[1] as Anthropic.TextBlockParam).text).toContain('收尾');
  });

  it('沒有呼叫函式但有文字時當成 reply', async () => {
    const client = scriptedClient([message([text('今天總共 1200 元')], 'end_turn')]);
    const result = await createClaudeProvider({ client }).runToolLoop(loopReq());
    expect(result.call).toEqual({ name: 'reply', args: { text: '今天總共 1200 元' } });
  });

  it('一直只查不收尾就算失敗（AI_BUSY），交給備援', async () => {
    const client = scriptedClient([
      message([toolUse('t1', 'list_expenses')]),
      message([toolUse('t2', 'list_expenses')]),
    ]);
    await expect(createClaudeProvider({ client }).runToolLoop(loopReq({ maxRounds: 2 })))
      .rejects.toThrow(/^AI_BUSY:/);
  });

  it('開了 webSearch 才帶 web_search，搜過的次數從上限扣掉', async () => {
    const searched = (content: unknown[], n: number) =>
      ({ ...message(content), usage: { ...usage, server_tool_use: { web_search_requests: n, web_fetch_requests: 0 } } }) as Anthropic.Message;
    const client = scriptedClient([
      searched([toolUse('t1', 'list_expenses')], 1),
      message([toolUse('t2', 'reply', { text: 'ok' })]),
    ]);
    await createClaudeProvider({ client }).runToolLoop(loopReq({
      webSearch: { maxUses: 2, location: { city: '高山', country: 'JP' } },
    }));
    const search = (body: CreateBody) => body.tools?.find((t) => t.name === 'web_search') as Anthropic.WebSearchTool20250305 | undefined;
    expect(search(client.calls[0])).toMatchObject({
      type: 'web_search_20250305', max_uses: 2, user_location: { type: 'approximate', city: '高山', country: 'JP' },
    });
    expect(search(client.calls[1])?.max_uses).toBe(1);

    const plain = scriptedClient([message([toolUse('t1', 'reply', { text: 'ok' })])]);
    await createClaudeProvider({ client: plain }).runToolLoop(loopReq());
    expect(search(plain.calls[0])).toBeUndefined();
  });

  it('pause_turn 原樣再送一次，不補 user 訊息', async () => {
    const client = scriptedClient([
      message([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '白川鄉' } }], 'pause_turn'),
      message([toolUse('t2', 'reply', { text: 'ok' })]),
    ]);
    const result = await createClaudeProvider({ client }).runToolLoop(loopReq({ webSearch: { maxUses: 2 } }));
    expect(result.call.name).toBe('reply');
    const second = client.calls[1].messages;
    expect(second).toHaveLength(2);
    expect(second[1].role).toBe('assistant');
  });

  it('Console 沒開放 web search（400）就關掉搜尋重打，不讓整則訊息失敗', async () => {
    const client = scriptedClient([
      apiError(400, 'web_search is not enabled for this organization'),
      message([toolUse('t1', 'reply', { text: 'ok' })]),
    ]);
    const result = await createClaudeProvider({ client }).runToolLoop(loopReq({ webSearch: { maxUses: 2 } }));
    expect(result.call.name).toBe('reply');
    expect(client.calls[1].tools?.some((t) => t.name === 'web_search')).toBe(false);
  });

  it('工具丟例外時把錯誤回給模型，不中斷迴圈', async () => {
    const client = scriptedClient([
      message([toolUse('t1', 'list_expenses')]),
      message([toolUse('t2', 'reply', { text: 'ok' })]),
    ]);
    await createClaudeProvider({ client }).runToolLoop(loopReq({ execute: () => Promise.reject(new Error('db down')) }));
    const results = client.calls[1].messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(results[0].content).toBe('{"error":"db down"}');
  });
});
