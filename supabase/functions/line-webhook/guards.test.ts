import { describe, it, expect } from 'vitest';
import {
  applyParticipantDefaults,
  CANCEL_DRAFT_KEYWORDS,
  claimsCompletedAction,
  extractJSON,
  normalizeCurrency,
  normalizeDate,
  hasCurrencyHint,
  matchExpensesByQuestion,
  mentionsEditingExisting,
  normalizeExpenseAmountMaps,
  pickExpenseByRef,
  resolveCategory,
  resolveCurrencyByRule,
  resolveExpenseMembers,
  resolveMember,
  stripSelfMentions,
  summarizeHistoryEntry,
  summarizeTripExpenses,
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

describe('CANCEL_DRAFT_KEYWORDS', () => {
  it('精確比對，不會吃到「取消上一筆」', () => {
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

describe('stripSelfMentions', () => {
  it('只刪掉提及機器人的那一段，其他人的名字留著', () => {
    // 「@耀西 @小明 你付的晚餐 300」
    const raw = '@耀西 @小明 你付的晚餐 300';
    const mentionees = [
      { index: 0, length: 3, isSelf: true },
      { index: 4, length: 3, isSelf: false },
    ];
    expect(stripSelfMentions(raw, mentionees)).toBe('@小明 你付的晚餐 300');
  });

  it('提及在句中也切得掉', () => {
    const raw = '晚餐 300 @耀西';
    expect(stripSelfMentions(raw, [{ index: 7, length: 3, isSelf: true }])).toBe('晚餐 300');
  });

  it('多段自我提及由後往前刪，index 不會錯位', () => {
    const raw = '@耀西 晚餐 300 @耀西';
    const mentionees = [
      { index: 0, length: 3, isSelf: true },
      { index: 11, length: 3, isSelf: true },
    ];
    expect(stripSelfMentions(raw, mentionees)).toBe('晚餐 300');
  });

  it('沒有 mention 資料時原樣回傳（不再亂刪 @開頭的詞）', () => {
    expect(stripSelfMentions('@小明 你付的晚餐 300')).toBe('@小明 你付的晚餐 300');
    expect(stripSelfMentions('@小明 你付的晚餐 300', [])).toBe('@小明 你付的晚餐 300');
    expect(stripSelfMentions('晚餐 300', null)).toBe('晚餐 300');
  });

  it('欄位缺漏或超出範圍時不會爆掉', () => {
    expect(stripSelfMentions('晚餐 300', [{ isSelf: true }])).toBe('晚餐 300');
    expect(stripSelfMentions('晚餐 300', [{ index: 99, length: 3, isSelf: true }])).toBe('晚餐 300');
  });
});

describe('resolveCategory', () => {
  const categories = ['餐飲', '交通', '住宿', '其他'];

  it('完全相同或正規化後相同就直接採用', () => {
    expect(resolveCategory('交通', categories)).toEqual({ category: '交通', warning: null });
    expect(resolveCategory(' 交通 ', categories).category).toBe('交通');
  });

  it('清單外的分類退回預設並提醒', () => {
    const res = resolveCategory('美食', categories, '餐飲');
    expect(res.category).toBe('餐飲');
    expect(res.warning).toContain('美食');
  });

  it('沒有旅程預設時退回「其他」', () => {
    expect(resolveCategory('美食', categories).category).toBe('其他');
  });

  it('連「其他」都沒有就用清單第一個', () => {
    expect(resolveCategory('美食', ['餐飲', '交通']).category).toBe('餐飲');
  });

  it('旅程預設本身已不在清單裡時不採用它', () => {
    expect(resolveCategory('美食', categories, '已刪掉的分類').category).toBe('其他');
  });

  it('AI 沒填分類時退回預設但不吵使用者', () => {
    expect(resolveCategory('', categories, '餐飲')).toEqual({ category: '餐飲', warning: null });
  });

  it('旅程沒設分類清單就不驗證', () => {
    expect(resolveCategory('美食', [])).toEqual({ category: '美食', warning: null });
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

  // 改用 function calling 之後，「按了確認才會生效」正是我們要模型講的話。
  // regex 若連未來式一起殺，等於逼它改口說謊。
  it('未來式的說明不能被誤殺', () => {
    expect(claimsCompletedAction('幫你準備好修改卡片了，確認後就會修改好了')).toBe(false);
    expect(claimsCompletedAction('按下「確認修改」之後才會更新了')).toBe(false);
    expect(claimsCompletedAction('我可以幫你刪除，請按確認')).toBe(false);
    expect(claimsCompletedAction('卡片給你了，你按下去我就會幫你刪了')).toBe(false);
    expect(claimsCompletedAction('要刪除的話請按確認')).toBe(false);
  });

  it('過去式的完成宣稱仍然要攔', () => {
    expect(claimsCompletedAction('我幫你刪了')).toBe(true);
    expect(claimsCompletedAction('已經幫你把那筆刪掉了')).toBe(true);
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

describe('summarizeTripExpenses', () => {
  const members = ['代杰', 'Amy'];
  const precision = { TWD: 0, JPY: 0 };

  const rows = [
    {
      amount: 900, currency: 'TWD', category: '餐飲', date: '2026-09-01',
      payer_data: { 代杰: 900 }, split_data: { 代杰: 450, Amy: 450 },
    },
    {
      amount: 3000, currency: 'JPY', category: '交通', date: '2026-09-03',
      payer_data: { Amy: 3000 }, split_data: { 代杰: 1500, Amy: 1500 },
    },
    {
      amount: 100, currency: 'TWD', category: '餐飲', date: '2026-09-02',
      payer_data: { Amy: 100 }, split_data: { Amy: 100 },
    },
  ];

  it('算出筆數、日期範圍、各幣別合計與各分類合計', () => {
    const text = summarizeTripExpenses(rows, members, precision);
    expect(text).toContain('筆數：3 筆');
    expect(text).toContain('日期範圍：2026-09-01 ~ 2026-09-03');
    expect(text).toContain('各幣別合計：3000 JPY・1000 TWD');
    expect(text).toContain('交通 3000 JPY');
    expect(text).toContain('餐飲 1000 TWD');
  });

  it('每人的已付／應付／淨額分幣別計算', () => {
    const text = summarizeTripExpenses(rows, members, precision);
    // 代杰：付了 900 TWD，應付 450 TWD + 1500 JPY
    expect(text).toContain('- 代杰：已付 900 TWD｜應付 1500 JPY・450 TWD｜淨額 -1500 JPY・+450 TWD');
    // Amy：付了 3000 JPY + 100 TWD，應付 1500 JPY + 550 TWD
    expect(text).toContain('- Amy：已付 3000 JPY・100 TWD｜應付 1500 JPY・550 TWD｜淨額 +1500 JPY・-450 TWD');
  });

  it('結清紀錄不計入總額與分類，但要算進每人收支', () => {
    const withSettlement = [
      ...rows,
      {
        amount: 450, currency: 'TWD', category: '結清', date: '2026-09-04',
        is_settlement: true,
        payer_data: { Amy: 450 }, split_data: { 代杰: 450 },
      },
    ];
    const text = summarizeTripExpenses(withSettlement, members, precision);
    // 總額與筆數不變
    expect(text).toContain('筆數：3 筆');
    expect(text).toContain('各幣別合計：3000 JPY・1000 TWD');
    expect(text).not.toContain('結清 450 TWD');
    // Amy 還了 450 TWD 之後，兩人的 TWD 淨額歸零
    expect(text).toContain('- 代杰：已付 900 TWD｜應付 1500 JPY・900 TWD｜淨額 -1500 JPY・0 TWD');
    expect(text).toContain('- Amy：已付 3000 JPY・550 TWD｜應付 1500 JPY・550 TWD｜淨額 +1500 JPY・0 TWD');
  });

  it('金額用 Decimal 累加，不會出現浮點尾數', () => {
    const usd = [
      { amount: 0.1, currency: 'USD', category: '零食', date: '2026-09-01', payer_data: { 代杰: 0.1 }, split_data: { 代杰: 0.1 } },
      { amount: 0.2, currency: 'USD', category: '零食', date: '2026-09-01', payer_data: { 代杰: 0.2 }, split_data: { 代杰: 0.2 } },
    ];
    const text = summarizeTripExpenses(usd, ['代杰'], {});
    expect(text).toContain('各幣別合計：0.30 USD');
    expect(text).not.toContain('0.30000000000000004');
  });

  it('逐日合計讓「第一天花多少」答得出來（K12）', () => {
    const text = summarizeTripExpenses(rows, members, precision);
    expect(text).toContain('逐日合計：2026-09-01 900 TWD｜2026-09-02 100 TWD｜2026-09-03 3000 JPY');
  });

  it('同一天多筆會合併，且同一天的不同幣別分開列', () => {
    const sameDay = [
      { amount: 100, currency: 'TWD', category: '餐飲', date: '2026-09-01', payer_data: { 代杰: 100 }, split_data: { 代杰: 100 } },
      { amount: 200, currency: 'TWD', category: '餐飲', date: '2026-09-01', payer_data: { 代杰: 200 }, split_data: { 代杰: 200 } },
      { amount: 500, currency: 'JPY', category: '交通', date: '2026-09-01', payer_data: { 代杰: 500 }, split_data: { 代杰: 500 } },
    ];
    const text = summarizeTripExpenses(sameDay, ['代杰'], precision);
    expect(text).toContain('逐日合計：2026-09-01 500 JPY・300 TWD');
  });

  it('超過 30 天只留頭尾，中間明講省略了幾天', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      amount: 10, currency: 'TWD', category: '餐飲',
      date: `2026-09-${String(i + 1).padStart(2, '0')}`.replace('2026-09-3', '2026-10-0').slice(0, 10),
      payer_data: { 代杰: 10 }, split_data: { 代杰: 10 },
    }));
    // 保證產生 40 個不同日期
    const uniqueDays = new Set(many.map(r => r.date));
    expect(uniqueDays.size).toBeGreaterThan(30);

    const text = summarizeTripExpenses(many, ['代杰'], precision);
    expect(text).toContain('天省略');
    // 頭尾都還在
    const sorted = [...uniqueDays].sort();
    expect(text).toContain(sorted[0]);
    expect(text).toContain(sorted[sorted.length - 1]);
  });

  it('金額最大的 3 筆依折合主幣別排序（K13）', () => {
    // JPY 0.22：3000 JPY = 660 TWD，比 900 TWD 小
    const text = summarizeTripExpenses(
      rows.map((r, i) => ({ ...r, description: `第${i + 1}筆` })),
      members, precision,
      { rates: { TWD: 1, JPY: 0.22 }, baseCurrency: 'TWD' },
    );
    expect(text).toContain('金額最大的 3 筆（依折合 TWD 排序）：');
    expect(text).toContain('1. 2026-09-01 第1筆 900 TWD [餐飲]');
    expect(text).toContain('2. 2026-09-03 第2筆 3000 JPY（折合 660 TWD） [交通]');
    expect(text).toContain('3. 2026-09-02 第3筆 100 TWD [餐飲]');
  });

  it('沒給主幣別時退回用原始金額排序，且不加折合括號', () => {
    const text = summarizeTripExpenses(
      rows.map((r, i) => ({ ...r, description: `第${i + 1}筆` })),
      members, precision,
    );
    expect(text).toContain('金額最大的 3 筆：');
    // 沒折算的話 3000 JPY 就是最大的
    expect(text).toContain('1. 2026-09-03 第2筆 3000 JPY [交通]');
    expect(text).not.toContain('折合');
  });

  it('結清紀錄不會出現在逐日合計與最大金額裡', () => {
    const withSettlement = [
      ...rows,
      {
        amount: 99999, currency: 'TWD', description: '結清', category: '結清', date: '2026-09-04',
        is_settlement: true, payer_data: { Amy: 99999 }, split_data: { 代杰: 99999 },
      },
    ];
    const text = summarizeTripExpenses(withSettlement, members, precision, { baseCurrency: 'TWD' });
    expect(text).not.toContain('2026-09-04 99999 TWD');
    expect(text).not.toContain('99999 TWD [結清]');
  });

  it('支出少於 3 筆時標題跟著縮', () => {
    const text = summarizeTripExpenses([rows[0]], members, precision, { baseCurrency: 'TWD' });
    expect(text).toContain('金額最大的 1 筆');
  });

  it('沒有描述的支出標成「（無描述）」', () => {
    const text = summarizeTripExpenses([rows[0]], members, precision, { baseCurrency: 'TWD' });
    expect(text).toContain('（無描述）');
  });

  it('沒有支出時給一句話，不是一堆空欄位', () => {
    expect(summarizeTripExpenses([], members, precision)).toBe('（這趟旅程還沒有任何支出）');
  });

  it('沒有活動的成員標成「尚無收支」，而不是假裝有 0', () => {
    const text = summarizeTripExpenses(rows, [...members, '新來的'], precision);
    expect(text).toContain('- 新來的：尚無收支');
  });

  it('只出現在舊帳裡的名字也會被列出來（成員被移除或改名過）', () => {
    const text = summarizeTripExpenses(rows, ['代杰'], precision);
    expect(text).toContain('- Amy：已付');
  });

  it('沒有分類的支出歸到「（未分類）」', () => {
    const text = summarizeTripExpenses(
      [{ amount: 50, currency: 'TWD', date: '2026-09-01', payer_data: { 代杰: 50 }, split_data: { 代杰: 50 } }],
      ['代杰'], precision,
    );
    expect(text).toContain('（未分類） 50 TWD');
  });

  it('只有一天時日期範圍不重複印兩次', () => {
    const text = summarizeTripExpenses([rows[0]], members, precision);
    expect(text).toContain('日期範圍：2026-09-01\n');
    expect(text).not.toContain('2026-09-01 ~ 2026-09-01');
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

  it('群組的 user 訊息前面補上發言者（M17）', () => {
    expect(summarizeHistoryEntry('user', '我付的晚餐 300', '代杰')).toBe('代杰：我付的晚餐 300');
    // 一對一沒有 speaker_name，維持原樣
    expect(summarizeHistoryEntry('user', '晚餐 300', null)).toBe('晚餐 300');
    expect(summarizeHistoryEntry('user', '晚餐 300', '  ')).toBe('晚餐 300');
  });

  it('model 訊息不加發言者前綴', () => {
    expect(summarizeHistoryEntry('model', '好的唷', '代杰')).toBe('好的唷');
  });
});
