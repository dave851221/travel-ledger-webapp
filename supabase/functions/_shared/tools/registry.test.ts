import { describe, it, expect } from 'vitest';
import { TOOLS, runTool, toGeminiFunctionDeclarations } from './registry.ts';
import type { JsonSchema, ToolContext } from './types.ts';

/**
 * 這支測試看守的是「schema 送得出去嗎」。
 *
 * Gemini 的 function declaration 只吃 OpenAPI 的一個子集：帶了
 * `additionalProperties`、`$ref`、`oneOf`／`anyOf` 或 STRING 的 `format`，
 * 整個請求會直接 400，而錯誤訊息不會告訴你是哪一條規則。
 * 那種錯誤只有在真的對 LINE 講話時才會出現 —— 剛好是最不該壞的時候。
 */

const FORBIDDEN_KEYS = ['additionalProperties', '$ref', 'oneOf', 'anyOf', 'allOf', 'format'];

/** 遞迴掃過整棵 schema，回傳所有違規的路徑 */
function findForbidden(node: unknown, path: string): string[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child, i) => findForbidden(child, `${path}[${i}]`));

  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // properties 底下的 key 是使用者定義的欄位名，不是 schema 關鍵字 ——
    // 真的有人把欄位取名叫 format 也不該誤判
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        found.push(...findForbidden(sub, `${path}.properties.${prop}`));
      }
      continue;
    }
    if (FORBIDDEN_KEYS.includes(key)) found.push(`${path}.${key}`);
    found.push(...findForbidden(value, `${path}.${key}`));
  }
  return found;
}

describe('工具 schema', () => {
  it.each(TOOLS.map(t => [t.name, t.inputSchema] as [string, JsonSchema]))(
    '%s 的 inputSchema 不含 Gemini 不支援的關鍵字',
    (_name, schema) => {
      expect(findForbidden(schema, 'root')).toEqual([]);
    },
  );

  it.each(TOOLS.map(t => [t.name, t.inputSchema] as [string, JsonSchema]))(
    '%s 的 type 一律小寫（MCP 要求，Gemini 兩種都收）',
    (_name, schema) => {
      const types: string[] = [];
      const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        const obj = node as Record<string, unknown>;
        if (typeof obj.type === 'string') types.push(obj.type);
        Object.values(obj).forEach(walk);
      };
      walk(schema);
      expect(types.length).toBeGreaterThan(0);
      expect(types.every(t => t === t.toLowerCase())).toBe(true);
    },
  );

  it('每一支工具都是物件參數，且 required 只列真的存在的欄位', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      const props = Object.keys(tool.inputSchema.properties ?? {});
      for (const key of tool.inputSchema.required ?? []) {
        expect(props).toContain(key);
      }
    }
  });

  it('每一支工具都有給模型看的說明', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});

describe('toGeminiFunctionDeclarations', () => {
  it('名稱與 TOOLS 一致，parameters 就是 inputSchema 本身', () => {
    const declarations = toGeminiFunctionDeclarations();
    expect(declarations.map(d => d.name)).toEqual(TOOLS.map(t => t.name));
    declarations.forEach((d, i) => {
      expect(d.parameters).toBe(TOOLS[i].inputSchema);
      expect(d.description).toBe(TOOLS[i].description);
    });
  });

  it('可以只挑一部分 —— 唯讀情境不該讓模型看得到 delete_expense', () => {
    const declarations = toGeminiFunctionDeclarations(['list_expenses', 'get_balance']);
    expect(declarations.map(d => d.name)).toEqual(['list_expenses', 'get_balance']);
  });

  it('工具清單涵蓋 MCP_SERVER_DESIGN §2 的那一組語意', () => {
    expect(TOOLS.map(t => t.name).sort()).toEqual([
      'create_expense', 'delete_expense', 'get_balance', 'get_settlement_plan',
      'get_trip', 'list_expenses', 'restore_expense', 'update_expense',
    ]);
  });
});

describe('runTool', () => {
  it('不認得的名字要炸出來 —— 那代表 declarations 與 registry 不同步', async () => {
    await expect(runTool('nope', {}, {} as ToolContext)).rejects.toThrow('Unknown tool: nope');
  });

  it('get_trip 不碰資料庫，直接回 ctx 裡的旅程', async () => {
    const ctx = {
      db: null,
      today: '2026-09-05',
      trip: {
        id: 'trip-1', name: '東京行', access_code: 'secret',
        members: ['代杰'], categories: ['餐飲'],
        base_currency: 'TWD', default_currency: 'JPY',
        rates: { TWD: 1 }, precision_config: { TWD: 0 },
        is_archived: false, created_at: '2026-08-01T00:00:00Z',
      },
    } as unknown as ToolContext;

    const result = await runTool('get_trip', {}, ctx) as Record<string, unknown>;
    expect(result.name).toBe('東京行');
    expect(result.today).toBe('2026-09-05');
    expect(result.defaultCurrency).toBe('JPY');
    // 通行碼永遠不離開伺服器
    expect(Object.keys(result)).not.toContain('access_code');
  });
});
