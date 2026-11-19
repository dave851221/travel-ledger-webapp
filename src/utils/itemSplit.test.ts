import { describe, it, expect } from 'vitest';
import { splitByItems, sanitizeReceiptItems, reconcileReceiptItems, UNREAD_ITEM_NAME } from './itemSplit';
import { splitByItems as botSplit, reconcileReceiptItems as botReconcile } from '../../supabase/functions/_shared/itemSplit';

const sum = (m: Record<string, number>) => Object.values(m).reduce<number>((a, b) => a + (Number(b) || 0), 0);
const ALL = ['代杰', '賢佑', '文暄', '家蓉'];

describe('splitByItems：照這兩天的真實收據重跑', () => {
  it('7-11（內含稅）：賢佑只有一瓶 210，其他是代杰的 → 1,307／210', () => {
    const items = [
      { name: 'おにぎり', amount: 168 }, { name: 'サンドイッチ', amount: 398 },
      { name: '唐揚げ', amount: 259 }, { name: 'ビール', amount: 482 }, { name: 'お茶', amount: 210 },
    ];
    const r = splitByItems(1517, items, [['代杰'], ['代杰'], ['代杰'], ['代杰'], ['賢佑']], ALL, 0, '代杰');
    expect(r.split).toEqual({ 代杰: 1307, 賢佑: 210 });
    expect(sum(r.split)).toBe(1517);
  });

  it('唐吉訶德：共用的品項幾個人平分，加總等於總額', () => {
    // 490 是兩人共用的 980；家蓉自己 739、文暄自己 278；三人共用 1470 → 各 490
    const items = [
      { name: '面膜', amount: 980 }, { name: '藥妝 A', amount: 739 },
      { name: '藥妝 B', amount: 278 }, { name: '零食', amount: 980 },
    ];
    const r = splitByItems(2977, items,
      [['代杰', '賢佑'], ['家蓉'], ['文暄'], ['家蓉', '文暄']], ALL, 0, '家蓉');
    expect(r.split).toEqual({ 代杰: 490, 賢佑: 490, 家蓉: 1229, 文暄: 768 });
    expect(sum(r.split)).toBe(2977);
  });

  it('沒指定的品項由原本的分攤名單平分', () => {
    const items = [{ name: '雞皮', amount: 300 }, { name: '啤酒', amount: 600 }, { name: '飯糰', amount: 400 }];
    const r = splitByItems(1300, items, [['賢佑'], ['賢佑'], []], ALL, 0, '代杰');
    expect(r.split).toEqual({ 賢佑: 1000, 代杰: 100, 文暄: 100, 家蓉: 100 });
  });
});

describe('splitByItems：稅、折扣與尾差', () => {
  it('外税 10%：依比例放大，尾差給付款人，加總一定等於總額', () => {
    const items = [{ name: 'A', amount: 333 }, { name: 'B', amount: 333 }, { name: 'C', amount: 334 }];
    const r = splitByItems(1100, items, [['代杰'], ['賢佑'], ['文暄']], ALL, 0, '代杰');
    expect(sum(r.split)).toBe(1100);
    expect(r.split).toEqual({ 代杰: 367, 賢佑: 366, 文暄: 367 });
    expect(r.itemsTotal).toBe(1000);
  });

  it('整單打折：依比例縮小', () => {
    const r = splitByItems(900, [{ name: 'A', amount: 500 }, { name: 'B', amount: 500 }], [['代杰'], ['賢佑']], ALL, 0, '代杰');
    expect(r.split).toEqual({ 代杰: 450, 賢佑: 450 });
  });

  it('付款人沒分到東西時，尾差給分到最多的人', () => {
    const r = splitByItems(1001, [{ name: 'A', amount: 600 }, { name: 'B', amount: 400 }], [['賢佑'], ['文暄']], ALL, 0, '代杰');
    expect(sum(r.split)).toBe(1001);
    expect(r.adjustment).toBe('賢佑');
  });

  it('美金兩位小數', () => {
    const r = splitByItems(10, [{ name: 'A', amount: 10 }], [['代杰', '賢佑', '文暄']], ALL, 2, '代杰');
    expect(r.split).toEqual({ 代杰: 3.34, 賢佑: 3.33, 文暄: 3.33 });
  });

  it('品項全是 0 元時平分總額', () => {
    const r = splitByItems(300, [{ name: 'A', amount: 0 }, { name: 'B', amount: 0 }], [['代杰'], ['賢佑']], ALL, 0, '代杰');
    expect(sum(r.split)).toBe(300);
  });
});

describe('splitByItems：按份數分（×5 啤酒 2 瓶給 A、3 瓶給 B）', () => {
  it('份數分完：依份數比例分', () => {
    const items = [{ name: '啤酒', amount: 1000, qty: 5 }, { name: '毛豆', amount: 300 }];
    const r = splitByItems(1300, items, [[], ['文暄']], ALL, 0, '代杰', [{ 代杰: 2, 賢佑: 3 }, null]);
    expect(r.split).toEqual({ 代杰: 400, 賢佑: 600, 文暄: 300 });
  });

  it('份數沒分完：剩下的由 others 平分', () => {
    const items = [{ name: '啤酒', amount: 1000, qty: 5 }, { name: '毛豆', amount: 300 }];
    // 代杰 2 瓶 = 400；剩 3 瓶 600 由代杰、賢佑平分各 300；毛豆是文暄的
    const r = splitByItems(1300, items, [[], ['文暄']], ['代杰', '賢佑'], 0, '代杰', [{ 代杰: 2 }, null]);
    expect(r.split).toEqual({ 代杰: 700, 賢佑: 300, 文暄: 300 });
  });

  it('沒有 qty 的品項按份數：純比例', () => {
    const r = splitByItems(900, [{ name: 'A', amount: 900 }, { name: 'B', amount: 0.0001 }],
      [[], ['代杰']], ALL, 0, '代杰', [{ 賢佑: 1, 文暄: 2 }]);
    expect(r.split.賢佑).toBe(300);
    expect(r.split.文暄).toBe(600);
  });

  it('全是 0 份就退回 assignments／others，外税依比例攤', () => {
    const items = [{ name: '啤酒', amount: 1000, qty: 5 }];
    const r = splitByItems(1100, items, [['代杰']], ALL, 0, '代杰', [{ 賢佑: 0 }]);
    expect(r.split).toEqual({ 代杰: 1100 });
  });
});

describe('sanitizeReceiptItems', () => {
  it('數量只收 2～999 的整數', () => {
    expect(sanitizeReceiptItems([{ name: 'A', amount: 100, qty: 5 }, { name: 'B', amount: 200, qty: 1 }, { name: 'C', amount: 1, qty: 'x' }]))
      .toEqual([{ name: 'A', amount: 100, qty: 5 }, { name: 'B', amount: 200 }, { name: 'C', amount: 1 }]);
  });

  it('丟掉壞掉的品項、少於兩項就不給逐項分', () => {
    expect(sanitizeReceiptItems([{ name: 'A', amount: 100 }, { name: '', amount: 5 }, { name: 'B', amount: 'x' }])).toEqual([]);
    expect(sanitizeReceiptItems([{ name: 'A', amount: 100 }, { name: 'B', amount: '200' }])).toHaveLength(2);
    expect(sanitizeReceiptItems('nope')).toEqual([]);
  });
});

describe('網頁與機器人兩份實作一致（契約測試）', () => {
  function rng(seed: number) {
    let s = seed;
    return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  }
  it('500 組隨機輸入結果完全相同，且加總等於總額', () => {
    const r = rng(42);
    for (let k = 0; k < 500; k++) {
      const n = 1 + Math.floor(r() * 12);
      const precision = r() < 0.7 ? 0 : 2;
      const items = Array.from({ length: n }, (_, i) => ({ name: `i${i}`, amount: Math.round(r() * 3000) / (precision ? 100 : 1) }));
      const assignments = items.map(() => ALL.filter(() => r() < 0.3));
      const others = ALL.filter(() => r() < 0.8);
      const itemsTotal = items.reduce<number>((a, b) => a + b.amount, 0);
      const total = Math.round(itemsTotal * (0.85 + r() * 0.3) * (precision ? 100 : 1)) / (precision ? 100 : 1);
      const prefer = ALL[Math.floor(r() * 4)];
      const web = splitByItems(total, items, assignments, others, precision, prefer);
      const bot = botSplit(total, items, assignments, others, precision, prefer);
      expect(bot).toEqual(web);
      // 按份數分：隨機給 qty 與份數（可能沒分完）
      const qItems = items.map(it => (r() < 0.5 ? { ...it, qty: 2 + Math.floor(r() * 8) } : it));
      const units = qItems.map(it => (r() < 0.5 ? null : Object.fromEntries(ALL.filter(() => r() < 0.5)
        .map(m => [m, Math.floor(r() * ((it as { qty?: number }).qty ?? 4) / 2)]))));
      const webU = splitByItems(total, qItems, assignments, others, precision, prefer, units);
      const botU = botSplit(total, qItems, assignments, others, precision, prefer, units);
      expect(botU).toEqual(webU);
      if (Object.keys(webU.split).length > 0) expect(Math.round(sum(webU.split) * 100)).toBe(Math.round(total * 100));
      expect(bot).toEqual(web);
      if (Object.keys(web.split).length > 0) expect(Math.round(sum(web.split) * 100)).toBe(Math.round(total * 100));
    }
  });
});

describe('reconcileReceiptItems', () => {
  it('漏讀一行（2026-11-16 居酒屋，差 ¥300）補一列差額，不按比例攤', () => {
    const items = [{ name: 'A', amount: 14190 - 300 }, { name: 'B', amount: 300 }]
    const out = reconcileReceiptItems(items, 14490)
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({ name: UNREAD_ITEM_NAME, amount: 300 })
    expect(reconcileReceiptItems(out, 14490)).toBe(out)
    // 差額這一列沒點 → 跟其他沒指定的一起平分；A 是代杰的就不會多付
    const r = splitByItems(14490, out, [['代杰'], ['賢佑'], []], ['代杰', '賢佑'], 0, '代杰')
    expect(r.split).toEqual({ 代杰: 13890 + 150, 賢佑: 300 + 150 })
  })
  it('外税 10%／8% 與尾數差不補，交給比例攤', () => {
    const items = [{ name: 'A', amount: 1000 }, { name: 'B', amount: 1000 }]
    expect(reconcileReceiptItems(items, 2200)).toBe(items)
    expect(reconcileReceiptItems(items, 2160)).toBe(items)
    expect(reconcileReceiptItems(items, 2005)).toBe(items)
    expect(reconcileReceiptItems(items, 1800)).toBe(items)
  })
  it('0 元的品項不列', () => {
    expect(sanitizeReceiptItems([{ name: 'ロック', amount: 0 }, { name: 'A', amount: 1 }, { name: 'B', amount: 2 }]))
      .toEqual([{ name: 'A', amount: 1 }, { name: 'B', amount: 2 }])
  })
  it('兩份實作一致', () => {
    for (const total of [2200, 2300, 2005, 1800, 0]) {
      const items = [{ name: 'A', amount: 1000 }, { name: 'B', amount: 1000 }]
      expect(botReconcile(items, total)).toEqual(reconcileReceiptItems(items, total))
    }
  })
})

describe('reconcileReceiptItems：有收據小計時', () => {
  const pig = [ // 2026-11-16 麺屋猪一本店（內含稅 10%，合計 ¥9,900）
    { name: '出汁そば', amount: 3100 }, { name: '和牛そば', amount: 4700 }, { name: '麺大盛り', amount: 200 },
    { name: '焼売', amount: 1200 }, { name: '炙り帆立丼', amount: 700 },
  ]
  it('內含稅：品項已含稅，原樣不動；每人付的就是自己點的（稅已在價格裡）', () => {
    expect(reconcileReceiptItems(pig, 9900, 9900)).toBe(pig)
    const r = splitByItems(9900, pig, [['家蓉', '文暄'], ['代杰', '賢佑'], ['賢佑'], [], ['賢佑']], ALL, 0, '賢佑')
    expect(r.split).toEqual({ 代杰: 2650, 賢佑: 3550, 文暄: 1850, 家蓉: 1850 })
  })
  it('外税＋服務費（+21%）：不補差額列，稅與服務費依點的金額比例攤', () => {
    const items = [{ name: 'A', amount: 6000 }, { name: 'B', amount: 3000 }]
    expect(reconcileReceiptItems(items, 10890, 9000)).toBe(items)
    const r = splitByItems(10890, items, [['代杰'], ['賢佑']], [], 0, '代杰')
    expect(r.split).toEqual({ 代杰: 7260, 賢佑: 3630 })
  })
  it('外税但漏讀一行：差額只補「小計 − 品項」，稅照比例', () => {
    const items = [{ name: 'A', amount: 6000 }, { name: 'B', amount: 2700 }]
    const out = reconcileReceiptItems(items, 9900, 9000)
    expect(out[2]).toEqual({ name: UNREAD_ITEM_NAME, amount: 300 })
  })
  it('兩份實作一致（含小計）', () => {
    const items = [{ name: 'A', amount: 6000 }, { name: 'B', amount: 2700 }]
    for (const [t, st] of [[9900, 9000], [10890, 9000], [9900, undefined], [9900, 99999]] as const) {
      expect(botReconcile(items, t, st)).toEqual(reconcileReceiptItems(items, t, st))
    }
  })
})
