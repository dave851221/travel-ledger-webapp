import { describe, it, expect } from 'vitest';
import {
  applyParticipantDefaults,
  CANCEL_DRAFT_KEYWORDS,
  claimsCompletedAction,
  detectRecordIntent,
  extractJSON,
  normalizeCurrency,
  normalizeDate,
  normalizeExpenseAmountMaps,
  resolveExpenseMembers,
  resolveMember,
  summarizeHistoryEntry,
  toAmountMap,
} from './guards';
import { calculateDistribution } from '../_shared/finance';

/**
 * 這些函式是 LINE Bot 的防線：AI 回傳的內容全部先經過它們才會落地，
 * 路由要不要攔截使用者的訊息也靠它們判斷。
 *
 * 過去它們埋在 index.ts 兩千多行裡沒有任何測試，改 prompt 或改路由時
 * 已經有兩次把先前做好的行為蓋掉（見 docs/LINE_SCENARIOS.md 開頭）。
 * 這支測試把行為釘住。
 */

describe('detectRecordIntent', () => {
  it('「改 + 數字」是修改意圖', () => {
    expect(detectRecordIntent('剛剛那筆改 500')).toBe('edit');
    expect(detectRecordIntent('剛剛那筆改500')).toBe('edit');
    expect(detectRecordIntent('那筆帳改成 800')).toBe('edit');
    expect(detectRecordIntent('編輯支出')).toBe('edit');
  });

  it('刪除動詞優先於修改動詞', () => {
    expect(detectRecordIntent('把昨天那筆刪掉')).toBe('delete');
    expect(detectRecordIntent('刪除支出')).toBe('delete');
    expect(detectRecordIntent('把那筆紀錄移除，順便改成 500')).toBe('delete');
  });

  it('只有動詞或只有受詞都不算', () => {
    // 「改天」不是「改 + 數字」，不能誤判
    expect(detectRecordIntent('這筆帳我改天再處理')).toBeNull();
    // 「行程」不是紀錄類的受詞
    expect(detectRecordIntent('取消行程')).toBeNull();
    expect(detectRecordIntent('刪掉這張照片')).toBeNull();
    expect(detectRecordIntent('晚餐 300')).toBeNull();
    expect(detectRecordIntent('')).toBeNull();
  });

  it('「取消上一筆」不是刪除意圖（走撤銷路徑）', () => {
    expect(detectRecordIntent('取消上一筆')).toBeNull();
  });

  it('CANCEL_DRAFT_KEYWORDS 精確比對，不會吃到「取消上一筆」', () => {
    expect(CANCEL_DRAFT_KEYWORDS.includes('取消')).toBe(true);
    expect(CANCEL_DRAFT_KEYWORDS.includes('取消上一筆')).toBe(false);
  });
});

describe('claimsCompletedAction', () => {
  it('攔下 AI 的假完成宣稱', () => {
    expect(claimsCompletedAction('好的，已經幫您刪除了！')).toBe(true);
    expect(claimsCompletedAction('我已經修改好了唷')).toBe(true);
    expect(claimsCompletedAction('幫你改了')).toBe(true);
    expect(claimsCompletedAction('已更新這筆支出')).toBe(true);
  });

  it('誠實說明做不到的話不該被攔', () => {
    expect(claimsCompletedAction('我沒辦法刪除已存檔的支出')).toBe(false);
    expect(claimsCompletedAction('請輸入「刪除支出」，我會列出近期紀錄')).toBe(false);
    expect(claimsCompletedAction('Yoshi! 今天總共花了 1200 元')).toBe(false);
  });
});

describe('resolveMember', () => {
  const members = ['王小明', 'Amy', '代杰'];

  it('完全相同直接採用', () => {
    expect(resolveMember('代杰', members)).toBe('代杰');
  });

  it('忽略大小寫與空白', () => {
    expect(resolveMember('amy', members)).toBe('Amy');
    expect(resolveMember(' A M Y ', members)).toBe('Amy');
  });

  it('子字串有唯一解時採用', () => {
    expect(resolveMember('小明', members)).toBe('王小明');
  });

  it('有兩個候選就不猜', () => {
    expect(resolveMember('明', ['小明', '小明哥'])).toBeNull();
  });

  it('對不上或空字串回 null', () => {
    expect(resolveMember('阿花', members)).toBeNull();
    expect(resolveMember('', members)).toBeNull();
    expect(resolveMember('   ', members)).toBeNull();
  });
});

describe('resolveExpenseMembers', () => {
  it('把暱稱換成正式名稱，同一人被指到兩次則金額相加', () => {
    const expense = {
      payer_data: { 小明: 200, 王小明: 300 },
      split_details: { amy: 500 },
    };
    const { unresolved } = resolveExpenseMembers(expense, ['王小明', 'Amy']);
    expect(unresolved).toEqual([]);
    expect(expense.payer_data).toEqual({ 王小明: 500 });
    expect(expense.split_details).toEqual({ Amy: 500 });
  });

  it('對不上的名字會被回報且不寫進結果', () => {
    const expense = { payer_data: { 阿花: 300 }, split_details: { 阿花: 300 } };
    const { unresolved } = resolveExpenseMembers(expense, ['王小明']);
    expect(unresolved).toEqual(['阿花']);
    expect(expense.payer_data).toEqual({});
  });
});

describe('applyParticipantDefaults', () => {
  const trip = { members: ['代杰', 'Amy', '王小明'] };

  it('空付款人時採用旅程預設付款人', () => {
    const expense = { payer_data: {}, split_details: {} };
    const filled = applyParticipantDefaults(
      { ...expense },
      { ...trip, default_payer: ['Amy'] },
    );
    expect(filled.filledPayer).toBe(true);
  });

  it('沒有旅程預設時用傳訊者對應的成員', () => {
    const expense: any = { payer_data: {}, split_details: {} };
    applyParticipantDefaults(expense, trip, '小明');
    expect(Object.keys(expense.payer_data)).toEqual(['王小明']);
    // 分攤沒設定就是全員
    expect(Object.keys(expense.split_details)).toEqual(trip.members);
  });

  it('傳訊者也對不上時退回成員第一位', () => {
    const expense: any = { payer_data: {}, split_details: {} };
    applyParticipantDefaults(expense, trip, '路人甲');
    expect(Object.keys(expense.payer_data)).toEqual(['代杰']);
  });

  it('旅程預設含已被移除的成員時會先過濾掉', () => {
    const expense: any = { payer_data: {}, split_details: {} };
    applyParticipantDefaults(expense, {
      ...trip,
      default_payer: ['已離開的人'],
      default_split_members: ['Amy', '已離開的人'],
    }, '代杰');
    expect(Object.keys(expense.payer_data)).toEqual(['代杰']);
    expect(Object.keys(expense.split_details)).toEqual(['Amy']);
  });

  it('補上的預設值是 0 佔位：分配時必須改傳 {} 當 lockedData', () => {
    // 這是 index.ts 兩個呼叫端的契約。曾經直接把佔位 map 交給 calculateDistribution，
    // 0 被當成鎖定金額，三人均分的 900 變成 900/0/0。
    const expense: any = { payer_data: {}, split_details: {} };
    const { filledSplit } = applyParticipantDefaults(expense, trip);
    const members = Object.keys(expense.split_details);
    expect(members).toEqual(trip.members);
    expect(Object.values(expense.split_details)).toEqual([0, 0, 0]);

    const right = calculateDistribution(900, members, filledSplit ? {} : expense.split_details, members[0], 0);
    expect(Object.values(right)).toEqual([300, 300, 300]);

    const wrong = calculateDistribution(900, members, expense.split_details, members[0], 0);
    expect(wrong[members[0]]).toBe(900);
  });

  it('AI 已經給了內容就完全不動它', () => {
    const expense: any = { payer_data: { Amy: 300 }, split_details: { 代杰: 300 } };
    const filled = applyParticipantDefaults(expense, trip, '代杰');
    expect(filled).toEqual({ filledPayer: false, filledSplit: false });
    expect(expense.payer_data).toEqual({ Amy: 300 });
  });
});

describe('normalizeCurrency', () => {
  const trip = { rates: { TWD: 1, JPY: 0.22 }, base_currency: 'TWD' };

  it('rates 內的幣別直接放行', () => {
    expect(normalizeCurrency('JPY', trip)).toEqual({ currency: 'JPY', warning: null, reject: null });
  });

  it('合法但旅程沒設匯率 → reject', () => {
    const res = normalizeCurrency('usd', trip);
    expect(res.currency).toBe('USD');
    expect(res.warning).toBeNull();
    expect(res.reject).toContain('USD');
  });

  it('亂碼幣別 → 退回預設並警告', () => {
    const res = normalizeCurrency('YEN', trip);
    expect(res.currency).toBe('TWD');
    expect(res.warning).toContain('YEN');
    expect(res.reject).toBeNull();
  });

  it('空字串 → 退回預設且不警告', () => {
    expect(normalizeCurrency('', trip)).toEqual({ currency: 'TWD', warning: null, reject: null });
    expect(normalizeCurrency(undefined, trip).warning).toBeNull();
  });

  it('default_currency 優先於 base_currency 當 fallback', () => {
    expect(normalizeCurrency('', { ...trip, default_currency: 'JPY' }).currency).toBe('JPY');
  });
});

describe('normalizeDate', () => {
  const today = '2026-09-04';

  it('合法日期原樣回傳', () => {
    expect(normalizeDate('2026-09-02', today)).toEqual({ date: '2026-09-02', warning: null });
  });

  it('格式錯 → 退回今天', () => {
    const res = normalizeDate('2026/9/2', today);
    expect(res.date).toBe(today);
    expect(res.warning).toContain('格式');
  });

  it('不存在的日期 → 退回今天', () => {
    const res = normalizeDate('2026-02-30', today);
    expect(res.date).toBe(today);
    expect(res.warning).toContain('不存在');
  });

  it('距今超過一年 → 退回今天', () => {
    expect(normalizeDate('2019-09-02', today).date).toBe(today);
    expect(normalizeDate('2031-09-02', today).warning).toContain('超過一年');
  });

  it('沒給日期時退回今天但不吵使用者', () => {
    expect(normalizeDate('', today)).toEqual({ date: today, warning: null });
  });
});

describe('toAmountMap', () => {
  it('接受 schema 產生的陣列形式', () => {
    expect(toAmountMap([{ member: '代杰', amount: 300 }])).toEqual({ 代杰: 300 });
  });

  it('接受舊版的物件形式', () => {
    expect(toAmountMap({ 代杰: '300' })).toEqual({ 代杰: 300 });
  });

  it('同名相加，空名字略過', () => {
    expect(toAmountMap([
      { member: '代杰', amount: 200 },
      { member: '代杰', amount: 100 },
      { member: '  ', amount: 999 },
    ])).toEqual({ 代杰: 300 });
  });

  it('非物件回空 map', () => {
    expect(toAmountMap(null)).toEqual({});
    expect(toAmountMap('abc')).toEqual({});
  });

  it('normalizeExpenseAmountMaps 會把 split_data 併成 split_details', () => {
    const expense: any = { payer_data: [{ member: 'A', amount: 1 }], split_data: { A: 1 } };
    normalizeExpenseAmountMaps(expense);
    expect(expense.payer_data).toEqual({ A: 1 });
    expect(expense.split_details).toEqual({ A: 1 });
  });
});

describe('extractJSON', () => {
  it('剝掉 markdown code block', () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('沒有 code block 時取第一個 { 到最後一個 }', () => {
    expect(extractJSON('好的：{"a":1} 以上')).toBe('{"a":1}');
  });

  it('完全沒有 JSON 時原樣回傳', () => {
    expect(extractJSON('  hello  ')).toBe('hello');
  });
});

describe('summarizeHistoryEntry', () => {
  it('記帳建議壓成一行並附上草稿編號', () => {
    const content = '[記帳建議] ' + JSON.stringify({
      description: '晚餐', amount: 300, currency: 'TWD', nonce: 'ab12cd34',
    });
    expect(summarizeHistoryEntry('model', content)).toBe(
      '（我先前提出的記帳建議：晚餐 300 TWD，草稿編號 ab12cd34）',
    );
  });

  it('舊格式（沒有 nonce）仍可摘要', () => {
    const content = '[記帳建議] ' + JSON.stringify({ description: '晚餐', amount: 300, currency: 'TWD' });
    expect(summarizeHistoryEntry('model', content)).toBe('（我先前提出的記帳建議：晚餐 300 TWD）');
  });

  it('壞掉的 JSON 有保底文字', () => {
    expect(summarizeHistoryEntry('model', '[記帳建議] {壞掉')).toBe('（我先前提出過一筆記帳建議）');
  });

  it('一般訊息只做長度截斷', () => {
    expect(summarizeHistoryEntry('user', '晚餐 300')).toBe('晚餐 300');
    expect(summarizeHistoryEntry('user', 'x'.repeat(400))).toHaveLength(301);
  });
});
