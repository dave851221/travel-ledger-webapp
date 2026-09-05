import { describe, it, expect } from 'vitest';
import {
  deleteExpense,
  listExpenses,
  prepareExpense,
  prepareExpenseUpdate,
  resolveExpenseRef,
} from './expenses.ts';
import type { ExpenseRow, ScopedContext, TripRow } from './types.ts';

/**
 * 工具層是「一筆支出怎麼進到資料庫」的唯一實作 —— 在它出現以前，
 * 同一段驗證在 line-webhook 裡有三份（OCR、文字、確認存入），
 * 而三份之間的漂移正是這個專案反覆出現的 bug 型態。
 *
 * 這支測試釘住的是「規則」而不是「某一條路徑」：暱稱怎麼對、幣別聽誰的、
 * 分類對不上怎麼辦、補完預設值之後 Σ 還等不等於總額。
 */

const TODAY = '2026-09-05';

const TRIP: TripRow = {
  id: 'trip-1',
  name: '東京行',
  access_code: null,
  members: ['代杰', '小明', 'Amy'],
  categories: ['餐飲', '交通', '其他'],
  base_currency: 'TWD',
  default_currency: 'JPY',
  default_category: '餐飲',
  default_payer: [],
  default_split_members: [],
  rates: { TWD: 1, JPY: 0.22 },
  precision_config: { TWD: 0, JPY: 0, USD: 2 },
  is_archived: false,
  created_at: '2026-08-01T00:00:00Z',
};

/** 有 USD 匯率的版本，用來測「換幣別會改變精度」 */
const TRIP_WITH_USD: TripRow = { ...TRIP, rates: { TWD: 1, JPY: 0.22, USD: 32 } };

const sum = (map: Record<string, number>) =>
  Object.values(map).reduce((a, b) => a + b, 0);

// ============================================================
// 假的 Supabase client
//
// 只要能撐起 from().select().eq()… 這條鏈，並在被 await 時吐出固定的列就夠了。
// 工具層刻意不自己建 client，就是為了讓這件事做得到。
// ============================================================

type Row = Record<string, unknown>;

function makeFakeDb(rows: Row[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};

  const chain = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };
  for (const m of ['from', 'select', 'eq', 'is', 'not', 'gte', 'lte', 'order', 'limit', 'update', 'insert', 'delete']) {
    builder[m] = chain(m);
  }
  // 單列查詢：回傳最後一次 .eq('id', …) 指名的那一列
  const single = (...args: unknown[]) => {
    calls.push({ method: 'maybeSingle', args });
    const idEq = calls.filter(c => c.method === 'eq' && c.args[0] === 'id').pop();
    const wanted = idEq?.args[1];
    const row = wanted !== undefined
      ? rows.find(r => r.id === wanted) ?? null
      : rows[0] ?? null;
    return Promise.resolve({ data: row, error: null });
  };
  builder.maybeSingle = single;
  builder.single = single;
  // 整條鏈本身是 thenable，await 就拿到全部的列
  builder.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(onFulfilled);

  const ctx = { db: builder, trip: { id: 'trip-1' } } as unknown as ScopedContext;
  return { ctx, calls };
}

// ============================================================
// prepareExpense
// ============================================================

describe('prepareExpense', () => {
  it('把暱稱對應回成員清單裡的正式名稱', () => {
    const { expense, unresolvedMembers } = prepareExpense({
      description: '晚餐',
      amount: 900,
      currency: 'JPY',
      currency_source: 'stated',
      payer_data: [{ member: 'amy', amount: 900 }],
      split_details: [{ member: '明', amount: 450 }, { member: 'AMY', amount: 450 }],
    }, TRIP, { today: TODAY, actorName: '小明', sourceText: '晚餐 900 日幣 Amy 付的' });

    expect(unresolvedMembers).toEqual([]);
    expect(Object.keys(expense.payer_data)).toEqual(['Amy']);
    expect(Object.keys(expense.split_details).sort()).toEqual(['Amy', '小明']);
  });

  it('對不上的名字會被挑出來，而不是自己造一個成員', () => {
    const { unresolvedMembers, expense } = prepareExpense({
      description: '晚餐',
      amount: 600,
      payer_data: [{ member: '路人甲', amount: 600 }],
    }, TRIP, { today: TODAY, actorName: '小明', sourceText: '晚餐 600' });

    expect(unresolvedMembers).toEqual(['路人甲']);
    // 拿掉之後付款人是空的，改由旅程預設補上（OCR 路徑靠這個把照片留住）
    expect(Object.keys(expense.payer_data)).toEqual(['小明']);
  });

  it('幣別 stated：文字裡真的有幣別字眼才採信', () => {
    const stated = prepareExpense(
      { description: '晚餐', amount: 3000, currency: 'JPY', currency_source: 'stated' },
      TRIP, { today: TODAY, sourceText: '晚餐 3000 日幣' },
    );
    expect(stated.expense.currency).toBe('JPY');
  });

  it('幣別 stated 但文字裡沒有幣別字眼：退回旅程的記帳預設（T3）', () => {
    const bogus = prepareExpense(
      { description: '夾娃娃', amount: 300, currency: 'TWD', currency_source: 'stated' },
      TRIP, { today: TODAY, sourceText: '夾娃娃300' },
    );
    // 主幣是 TWD，但記帳預設是 JPY —— 模型常把結算主幣當成該填的值
    expect(bogus.expense.currency).toBe('JPY');
  });

  it('幣別 none：一律用記帳預設幣別，完全忽略 AI 填的值', () => {
    const none = prepareExpense(
      { description: '晚餐', amount: 300, currency: 'TWD', currency_source: 'none' },
      TRIP, { today: TODAY, sourceText: '晚餐300' },
    );
    expect(none.expense.currency).toBe('JPY');
  });

  it('幣別 preference：採用 AI 的值（偏好是自由文字，程式驗不了）', () => {
    const pref = prepareExpense(
      { description: '晚餐', amount: 300, currency: 'TWD', currency_source: 'preference' },
      TRIP, { today: TODAY, sourceText: '晚餐300' },
    );
    expect(pref.expense.currency).toBe('TWD');
  });

  it('OCR（sourceText 為 null）沒有文字可驗，stated 直接採信', () => {
    const ocr = prepareExpense(
      { description: 'ローソン', amount: 780, currency: 'JPY', currency_source: 'stated' },
      TRIP, { today: TODAY, sourceText: null },
    );
    expect(ocr.expense.currency).toBe('JPY');
  });

  it('分類不在清單裡就退回旅程預設，並回一句提醒', () => {
    const { expense, warnings } = prepareExpense(
      { description: '午餐', amount: 500, category: '美食' },
      TRIP, { today: TODAY, sourceText: '午餐500' },
    );
    expect(expense.category).toBe('餐飲');
    expect(warnings.some(w => w.includes('美食'))).toBe(true);
  });

  it('日期離今天超過一年就退回今天', () => {
    const { expense, warnings } = prepareExpense(
      { description: '午餐', amount: 500, date: '2019-05-01' },
      TRIP, { today: TODAY, sourceText: '午餐500' },
    );
    expect(expense.date).toBe(TODAY);
    expect(warnings.some(w => w.includes('2019-05-01'))).toBe(true);
  });

  it('沒給付款人與分攤時補上預設值，且 Σ 仍然等於總額（H6）', () => {
    const { expense } = prepareExpense(
      { description: '晚餐', amount: 1000 },
      TRIP, { today: TODAY, actorName: '小明', sourceText: '晚餐1000' },
    );
    // 傳訊者付錢、全員均分
    expect(Object.keys(expense.payer_data)).toEqual(['小明']);
    expect(Object.keys(expense.split_details).sort()).toEqual(['Amy', '代杰', '小明']);
    expect(sum(expense.payer_data)).toBe(1000);
    expect(sum(expense.split_details)).toBe(1000);
    // 除不盡的餘數整筆落在調整成員身上，不是每個人多一塊
    expect(expense.split_details['小明']).toBe(334);
    expect(expense.adjustment_member).toBe('小明');
  });

  it('旅程預設付款人優先於傳訊者', () => {
    const trip = { ...TRIP, default_payer: ['代杰'], default_split_members: ['代杰', 'Amy'] };
    const { expense } = prepareExpense(
      { description: '晚餐', amount: 1000 },
      trip, { today: TODAY, actorName: '小明', sourceText: '晚餐1000' },
    );
    expect(Object.keys(expense.payer_data)).toEqual(['代杰']);
    expect(Object.keys(expense.split_details).sort()).toEqual(['Amy', '代杰']);
    expect(sum(expense.split_details)).toBe(1000);
  });

  it('幣別被拒（旅程沒有這個匯率）時仍然回傳正規化好的內容（M10）', () => {
    const { expense, reject } = prepareExpense(
      { description: '午餐', amount: 20.456, currency: 'USD', currency_source: 'stated' },
      TRIP, { today: TODAY, actorName: '小明', sourceText: '午餐 20 USD' },
    );
    expect(reject).toBeTruthy();
    expect(reject).toContain('USD');
    // 「以 XXX 存入」的流程要靠這份內容把辨識結果存成 pending，不能是空的
    expect(expense.currency).toBe('USD');
    expect(expense.amount).toBe(20.46);
    expect(sum(expense.split_details)).toBe(20.46);
  });

  it('AI 明確指定的分帳金額會被保留，不會被均分蓋掉', () => {
    const { expense } = prepareExpense({
      description: '晚餐',
      amount: 1000,
      currency: 'JPY',
      currency_source: 'stated',
      payer_data: [{ member: '代杰', amount: 1000 }],
      split_details: [{ member: '代杰', amount: 700 }, { member: '小明', amount: 300 }],
    }, TRIP, { today: TODAY, sourceText: '晚餐 1000 日幣 代杰 700 小明 300' });

    expect(expense.split_details).toEqual({ 代杰: 700, 小明: 300 });
  });
});

// ============================================================
// prepareExpenseUpdate
// ============================================================

const EXISTING: ExpenseRow = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  trip_id: 'trip-1',
  date: '2026-09-01',
  category: '餐飲',
  description: '晚餐',
  amount: 900,
  currency: 'JPY',
  payer_data: { 代杰: 900 },
  split_data: { 代杰: 300, 小明: 300, Amy: 300 },
  adjustment_member: '小明',
  photo_urls: [],
  is_settlement: false,
  deleted_at: null,
  created_at: '2026-09-01T10:00:00Z',
};

describe('prepareExpenseUpdate', () => {
  it('沒給的欄位一律沿用原值', () => {
    const { expense, changes } = prepareExpenseUpdate(
      EXISTING, { description: '晚餐（拉麵）' }, TRIP, { today: TODAY, sourceText: null },
    );
    expect(expense.description).toBe('晚餐（拉麵）');
    expect(expense.amount).toBe(900);
    expect(expense.currency).toBe('JPY');
    expect(expense.date).toBe('2026-09-01');
    expect(expense.category).toBe('餐飲');
    expect(expense.split_details).toEqual({ 代杰: 300, 小明: 300, Amy: 300 });
    expect(changes).toEqual([{ field: 'description', before: '晚餐', after: '晚餐（拉麵）' }]);
  });

  it('改金額而沒指定分攤時，沿用原本的參與者重新均分', () => {
    const { expense } = prepareExpenseUpdate(
      EXISTING, { amount: 1000 }, TRIP, { today: TODAY, sourceText: null },
    );
    expect(expense.payer_data).toEqual({ 代杰: 1000 });
    // 餘數給原本的 adjustment_member
    expect(expense.split_details).toEqual({ 代杰: 333, 小明: 334, Amy: 333 });
    expect(sum(expense.split_details)).toBe(1000);
  });

  it('adjustment_member 只要還在分攤名單裡就沿用', () => {
    const { expense } = prepareExpenseUpdate(
      EXISTING, { amount: 1000 }, TRIP, { today: TODAY, sourceText: null },
    );
    expect(expense.adjustment_member).toBe('小明');
  });

  it('adjustment_member 已不在分攤名單裡就重挑', () => {
    const { expense } = prepareExpenseUpdate(
      EXISTING,
      { split_details: [{ member: '代杰', amount: 0 }, { member: 'Amy', amount: 0 }] },
      TRIP, { today: TODAY, sourceText: null },
    );
    // 付款人與分攤都有代杰，餘數就給他
    expect(expense.adjustment_member).toBe('代杰');
    expect(sum(expense.split_details)).toBe(900);
  });

  it('換幣別會依新幣別的精度重算金額與分帳', () => {
    const usdRow: ExpenseRow = {
      ...EXISTING,
      currency: 'USD',
      amount: 100.5,
      payer_data: { 代杰: 100.5 },
      split_data: { 代杰: 33.5, 小明: 33.5, Amy: 33.5 },
    };
    const { expense, changes } = prepareExpenseUpdate(
      usdRow, { currency: 'JPY', currency_source: 'stated' },
      TRIP_WITH_USD, { today: TODAY, sourceText: null },
    );
    // JPY 是 0 位小數
    expect(expense.currency).toBe('JPY');
    expect(expense.amount).toBe(101);
    expect(sum(expense.split_details)).toBe(101);
    expect(changes.map(c => c.field).sort()).toEqual(['amount', 'currency', 'payer_data', 'split_data']);
  });

  it('分類與日期照樣走驗證，改壞了會回警告', () => {
    const { expense, warnings } = prepareExpenseUpdate(
      EXISTING, { category: '美食', date: '2019-01-01' }, TRIP, { today: TODAY, sourceText: null },
    );
    expect(expense.category).toBe('餐飲');
    expect(expense.date).toBe(TODAY);
    expect(warnings.length).toBe(2);
  });

  it('沒有任何欄位真的改變時 changes 是空的', () => {
    const { changes } = prepareExpenseUpdate(EXISTING, {}, TRIP, { today: TODAY, sourceText: null });
    expect(changes).toEqual([]);
  });
});

// ============================================================
// listExpenses
// ============================================================

const LIST_ROWS: Row[] = [
  {
    id: 'aaaaaaaa-1', date: '2026-09-04', description: '一蘭ラーメン', amount: 980, currency: 'JPY',
    category: '餐飲', payer_data: { 代杰: 980 }, split_data: { 代杰: 490, 小明: 490 },
    photo_urls: ['expenses/trip-1/a.jpg'], is_settlement: false,
  },
  {
    id: 'bbbbbbbb-1', date: '2026-09-03', description: 'JR 車票', amount: 1200, currency: 'JPY',
    category: '交通', payer_data: { Amy: 1200 }, split_data: { Amy: 600, 小明: 600 },
    photo_urls: [], is_settlement: false,
  },
  {
    id: 'cccccccc-1', date: '2026-09-02', description: 'Lawson 早餐', amount: 420, currency: 'JPY',
    category: '餐飲', payer_data: { 小明: 420 }, split_data: { 小明: 420 },
    photo_urls: [], is_settlement: false,
  },
];

describe('listExpenses', () => {
  it('把每一列縮成 AI 看得懂的摘要，ref 是 uuid 前 8 碼', async () => {
    const { ctx } = makeFakeDb(LIST_ROWS);
    const result = await listExpenses({}, ctx);
    expect(result.count).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.expenses[0]).toMatchObject({
      ref: 'aaaaaaaa', description: '一蘭ラーメン', amount: 980, hasPhoto: true,
    });
    expect(result.expenses[1].hasPhoto).toBe(false);
  });

  it('成員過濾看的是 payer_data 與 split_data 的 key', async () => {
    const { ctx } = makeFakeDb(LIST_ROWS);
    const result = await listExpenses({ member: 'Amy' }, ctx);
    expect(result.expenses.map(e => e.ref)).toEqual(['bbbbbbbb']);
  });

  it('payer 只看付錢的人', async () => {
    const { ctx } = makeFakeDb(LIST_ROWS);
    const result = await listExpenses({ payer: '小明' }, ctx);
    expect(result.expenses.map(e => e.ref)).toEqual(['cccccccc']);
  });

  it('關鍵字比對描述，不分大小寫', async () => {
    const { ctx } = makeFakeDb(LIST_ROWS);
    const result = await listExpenses({ keyword: 'lawson' }, ctx);
    expect(result.expenses.map(e => e.ref)).toEqual(['cccccccc']);
  });

  it('limit 切完之後會標記 truncated', async () => {
    const { ctx } = makeFakeDb(LIST_ROWS);
    const result = await listExpenses({ limit: 2 }, ctx);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('limit 有上限，AI 填 999 也只會拿到 50 筆的量', async () => {
    const { ctx, calls } = makeFakeDb(LIST_ROWS);
    await listExpenses({ limit: 999 }, ctx);
    // SQL 端的上限是固定的 200，limit 只影響記憶體裡的切片
    expect(calls.some(c => c.method === 'limit' && c.args[0] === 200)).toBe(true);
  });

  it('預設排除結清紀錄', async () => {
    const { ctx, calls } = makeFakeDb(LIST_ROWS);
    await listExpenses({}, ctx);
    expect(calls.some(c => c.method === 'not' && c.args[0] === 'is_settlement')).toBe(true);

    const second = makeFakeDb(LIST_ROWS);
    await listExpenses({ includeSettlements: true }, second.ctx);
    expect(second.calls.some(c => c.method === 'not' && c.args[0] === 'is_settlement')).toBe(false);
  });

  it('日期與分類交給資料庫過濾', async () => {
    const { ctx, calls } = makeFakeDb(LIST_ROWS);
    await listExpenses({ from: '2026-09-01', to: '2026-09-30', category: '餐飲' }, ctx);
    expect(calls.some(c => c.method === 'gte' && c.args[0] === 'date')).toBe(true);
    expect(calls.some(c => c.method === 'lte' && c.args[0] === 'date')).toBe(true);
    expect(calls.some(c => c.method === 'eq' && c.args[0] === 'category')).toBe(true);
  });
});

// ============================================================
// resolveExpenseRef
// ============================================================

describe('resolveExpenseRef', () => {
  const rows: Row[] = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', is_settlement: false, deleted_at: null, description: '晚餐' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', is_settlement: false, deleted_at: null, description: '午餐' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000003', is_settlement: false, deleted_at: null, description: '車票' },
    { id: 'cccccccc-0000-4000-8000-000000000004', is_settlement: false, deleted_at: '2026-09-04T00:00:00Z', description: '已刪除' },
    { id: 'dddddddd-0000-4000-8000-000000000005', is_settlement: true, deleted_at: null, description: '結清' },
  ];

  it('唯一命中才回傳', async () => {
    const { ctx } = makeFakeDb(rows);
    const found = await resolveExpenseRef('bbbbbbbb', ctx);
    expect(found?.description).toBe('車票');
  });

  it('開頭的 # 會被忽略，完整 uuid 也認得', async () => {
    const { ctx } = makeFakeDb(rows);
    expect((await resolveExpenseRef('#bbbbbbbb', ctx))?.description).toBe('車票');
    const full = makeFakeDb(rows);
    expect((await resolveExpenseRef('bbbbbbbb-0000-4000-8000-000000000003', full.ctx))?.description).toBe('車票');
  });

  it('前綴撞到兩筆時回 null —— 刪錯一筆帳比說「講清楚一點」糟得多', async () => {
    const { ctx } = makeFakeDb(rows);
    expect(await resolveExpenseRef('aaaaaaaa', ctx)).toBeNull();
  });

  it('預設排除已刪除與結清紀錄', async () => {
    const { ctx } = makeFakeDb(rows);
    expect(await resolveExpenseRef('cccccccc', ctx)).toBeNull();
    const settlement = makeFakeDb(rows);
    expect(await resolveExpenseRef('dddddddd', settlement.ctx)).toBeNull();
  });

  it('includeDeleted 才找得到垃圾桶裡的（還原用）', async () => {
    const { ctx } = makeFakeDb(rows);
    const found = await resolveExpenseRef('cccccccc', ctx, { includeDeleted: true });
    expect(found?.description).toBe('已刪除');
  });

  it('空字串一律 null，不要退化成「隨便挑一筆」', async () => {
    const { ctx } = makeFakeDb(rows);
    expect(await resolveExpenseRef('  ', ctx)).toBeNull();
  });
});

// ============================================================
// deleteExpense
// ============================================================

describe('deleteExpense', () => {
  it('已經在垃圾桶裡的不再 UPDATE 一次（H3：deleted_at 不能被刷新）', async () => {
    const { ctx, calls } = makeFakeDb([
      { id: 'x1', description: '晚餐', deleted_at: '2026-09-04T00:00:00Z' },
    ]);
    const result = await deleteExpense('x1', ctx);
    expect(result).toEqual({ ok: false, reason: 'already_deleted', description: '晚餐' });
    expect(calls.some(c => c.method === 'update')).toBe(false);
  });

  it('查無此列（或不屬於這趟旅程）回 not_found', async () => {
    const { ctx } = makeFakeDb([{ id: 'other', description: '別人的', deleted_at: null }]);
    const result = await deleteExpense('x1', ctx);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('正常刪除時會限定旅程範圍', async () => {
    const { ctx, calls } = makeFakeDb([{ id: 'x1', description: '晚餐', deleted_at: null }]);
    const result = await deleteExpense('x1', ctx);
    expect(result).toEqual({ ok: true, description: '晚餐' });
    expect(calls.some(c => c.method === 'eq' && c.args[0] === 'trip_id')).toBe(true);
    expect(calls.some(c => c.method === 'update')).toBe(true);
  });
});
