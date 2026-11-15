import { describe, it, expect } from 'vitest';
import { splitByItems, sanitizeReceiptItems } from './itemSplit';
import { splitByItems as botSplit } from '../../supabase/functions/_shared/itemSplit';

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

describe('sanitizeReceiptItems', () => {
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
      if (Object.keys(web.split).length > 0) expect(Math.round(sum(web.split) * 100)).toBe(Math.round(total * 100));
    }
  });
});
