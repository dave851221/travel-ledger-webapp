import { describe, it, expect } from 'vitest';
import {
  applyParticipantDefaults,
  CANCEL_DRAFT_KEYWORDS,
  claimsCompletedAction,
  detectRecordIntent,
  extractJSON,
  normalizeCurrency,
  normalizeDate,
  hasCurrencyHint,
  matchExpensesByQuestion,
  mentionsEditingExisting,
  normalizeExpenseAmountMaps,
  pickExpenseByRef,
  resolveCurrencyByRule,
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

  it('指示代名詞與時間指稱也算受詞（T1）', () => {
    // 真機回報：「那筆」認得、「那個」不認得，同一句話卻被當成新支出重複記了一筆
    expect(detectRecordIntent('剛剛那個改250')).toBe('edit');
    expect(detectRecordIntent('剛才那個刪掉')).toBe('delete');
    expect(detectRecordIntent('最近一筆改成 800')).toBe('edit');
    expect(detectRecordIntent('上一個改為 500')).toBe('edit');
  });

  it('加了新受詞之後「改天」仍然不能誤判', () => {
    expect(detectRecordIntent('剛剛那個改天再說')).toBeNull();
    expect(detectRecordIntent('這個改天再處理')).toBeNull();
  });

  it('CANCEL_DRAFT_KEYWORDS 精確比對，不會吃到「取消上一筆」', () => {
    expect(CANCEL_DRAFT_KEYWORDS.includes('取消')).toBe(true);
    expect(CANCEL_DRAFT_KEYWORDS.includes('取消上一筆')).toBe(false);
  });
});

describe('mentionsEditingExisting', () => {
  it('有修改動詞就算', () => {
    expect(mentionsEditingExisting('剛剛那個改250')).toBe(true);
    expect(mentionsEditingExisting('改成小明付')).toBe(true);
    expect(mentionsEditingExisting('金額改一下')).toBe(true);
  });

  it('「不對／錯了／打錯／記錯／更正」也算', () => {
    expect(mentionsEditingExisting('不對，是 500')).toBe(true);
    expect(mentionsEditingExisting('金額錯了')).toBe(true);
    expect(mentionsEditingExisting('我打錯了')).toBe(true);
    expect(mentionsEditingExisting('記錯店名')).toBe(true);
    expect(mentionsEditingExisting('更正一下日期')).toBe(true);
  });

  it('單純記帳或閒聊不算', () => {
    expect(mentionsEditingExisting('晚餐 300')).toBe(false);
    expect(mentionsEditingExisting('今天好累')).toBe(false);
    expect(mentionsEditingExisting('剛剛那個改天再說')).toBe(false);
    expect(mentionsEditingExisting('')).toBe(false);
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

describe('resolveCurrencyByRule', () => {
  // 旅程主幣 TWD、記帳預設 JPY —— T3 回報的那趟旅程
  const trip = { base_currency: 'TWD', default_currency: 'JPY' };

  it('source=none 一律用記帳預設幣別，忽略 AI 填的值', () => {
    // 「夾娃娃300」沒提幣別，AI 卻抄了 context 裡的主幣 TWD
    const res = resolveCurrencyByRule('TWD', 'none', '夾娃娃300', trip);
    expect(res.currency).toBe('JPY');
    expect(res.overrode).toBe(true);
  });

  it('source=stated 但文字裡沒有幣別字眼 → 視同 none，退回預設', () => {
    const res = resolveCurrencyByRule('TWD', 'stated', '夾娃娃300', trip);
    expect(res.currency).toBe('JPY');
    expect(res.overrode).toBe(true);
  });

  it('source=stated 且文字有「日幣」→ 採用 AI 的值', () => {
    const res = resolveCurrencyByRule('JPY', 'stated', '晚餐 3000 日幣', trip);
    expect(res.currency).toBe('JPY');
    expect(res.overrode).toBe(false);
  });

  it('明講台幣時就算與預設不同也照用', () => {
    expect(resolveCurrencyByRule('TWD', 'stated', '機場接送 台幣 1200', trip).currency).toBe('TWD');
    expect(resolveCurrencyByRule('USD', 'stated', '咖啡 US$4.5', trip).currency).toBe('USD');
  });

  it('source=preference 直接採用 AI 的值（程式驗不了自由文字）', () => {
    const res = resolveCurrencyByRule('JPY', 'preference', '晚餐 300', trip);
    expect(res.currency).toBe('JPY');
    expect(res.overrode).toBe(false);
  });

  it('OCR 路徑（text 為 null）沒有文字可驗，stated 直接採信', () => {
    expect(resolveCurrencyByRule('JPY', 'stated', null, trip).currency).toBe('JPY');
    // 但收據上也看不出來時，none 仍然走預設
    expect(resolveCurrencyByRule('TWD', 'none', null, trip).currency).toBe('JPY');
  });

  it('沒有 default_currency 時退回主幣別', () => {
    const res = resolveCurrencyByRule('JPY', 'none', '晚餐 300', { base_currency: 'TWD' });
    expect(res.currency).toBe('TWD');
  });

  it('認不得的 source 當成 stated 處理（舊模型不會壞掉）', () => {
    expect(resolveCurrencyByRule('JPY', '', '3000円', trip).currency).toBe('JPY');
    expect(resolveCurrencyByRule('TWD', undefined, '晚餐 300', trip).currency).toBe('JPY');
  });

  it('AI 沒填幣別時不會回空字串', () => {
    expect(resolveCurrencyByRule('', 'stated', '3000 日幣', trip).currency).toBe('JPY');
  });
});

describe('pickExpenseByRef', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('「#3」取第三筆（1-based）', () => {
    expect(pickExpenseByRef('#3', list)).toEqual({ id: 'c' });
    expect(pickExpenseByRef('3', list)).toEqual({ id: 'c' });
    expect(pickExpenseByRef('＃1', list)).toEqual({ id: 'a' });
  });

  it('超出範圍、空值或不是數字都回 null', () => {
    expect(pickExpenseByRef('#4', list)).toBeNull();
    expect(pickExpenseByRef('#0', list)).toBeNull();
    expect(pickExpenseByRef('', list)).toBeNull();
    expect(pickExpenseByRef(undefined, list)).toBeNull();
    // 舊行為的殘留：模型如果還是抄了一整串網址，不能誤取到某一筆
    expect(pickExpenseByRef('https://x.supabase.co/storage/v1/a.jpg', [{ id: 'a' }])).toBeNull();
  });
});

describe('matchExpensesByQuestion', () => {
  const list = [
    { description: 'Lawson (便利商店)' },
    { description: '一蘭ラーメン (拉麵)' },
    { description: '計程車' },
  ];

  it('店名原封不動出現在問句裡就命中（忽略括號後的中文說明）', () => {
    expect(matchExpensesByQuestion('剛剛 Lawson 那筆買了什麼', list))
      .toEqual([{ description: 'Lawson (便利商店)' }]);
    expect(matchExpensesByQuestion('lawson 的收據', list)).toHaveLength(1);
  });

  it('沒有命中就回空陣列，交給 AI 挑', () => {
    expect(matchExpensesByQuestion('剛剛那張收據買了什麼', list)).toEqual([]);
    expect(matchExpensesByQuestion('', list)).toEqual([]);
  });

  it('命中多筆時全部回傳（呼叫端再交給 AI 二選一）', () => {
    const dupes = [{ description: '一蘭 (拉麵)' }, { description: '一蘭 (伴手禮)' }];
    expect(matchExpensesByQuestion('一蘭那兩筆分別是什麼', dupes)).toHaveLength(2);
  });

  it('單字描述不會讓整份清單都命中', () => {
    // 1 個字的 key 不列入比對
    expect(matchExpensesByQuestion('那筆水多少錢', [{ description: '水' }])).toEqual([]);
  });
});

describe('hasCurrencyHint', () => {
  it('認得中文詞、符號與 ISO 代碼', () => {
    expect(hasCurrencyHint('3000 日幣')).toBe(true);
    expect(hasCurrencyHint('ラーメン 1200円')).toBe(true);
    expect(hasCurrencyHint('¥3000')).toBe(true);
    expect(hasCurrencyHint('US$20')).toBe(true);
    expect(hasCurrencyHint('晚餐 500 twd')).toBe(true);
    expect(hasCurrencyHint('NT 500')).toBe(true);
  });

  it('沒提到幣別就是沒提到', () => {
    expect(hasCurrencyHint('夾娃娃300')).toBe(false);
    expect(hasCurrencyHint('晚餐 300')).toBe(false);
    expect(hasCurrencyHint('')).toBe(false);
    expect(hasCurrencyHint(null)).toBe(false);
  });

  it('拉丁代碼要有邊界，不能被英文單字誤觸', () => {
    // 「restaurant」含有 nt，沒有邊界的話會被當成使用者明講了台幣
    expect(hasCurrencyHint('restaurant 300')).toBe(false);
    expect(hasCurrencyHint('dinner 3000')).toBe(false);
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
