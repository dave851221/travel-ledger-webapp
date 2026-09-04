import { describe, it, expect } from 'vitest';
import {
  calculateDistribution as webDistribution,
  calculateMemberBalances as webBalances,
  getRate as webRate,
  sumByCurrency as webSum,
} from './finance';
import { calculateSettlements as webSettlements } from './settlement';
import {
  calculateDistribution as botDistribution,
  calculateMemberBalances as botBalances,
  calculateSettlements as botSettlements,
  getRate as botRate,
  sumByCurrency as botSum,
} from '../../supabase/functions/_shared/finance';

/**
 * 契約測試 —— 這是整個測試套件裡最重要的一支。
 *
 * 財務演算法有兩份實作：前端（src/utils/）與 LINE Bot Edge Function
 * （supabase/functions/_shared/）。兩者無法直接共用同一個檔案，因為前端走
 * npm 的 decimal.js、Edge Function 走 esm.sh 的 URL import。
 *
 * 過去這兩份只靠人工同步，改一邊忘了另一邊不會有任何徵兆 —— 直到有人發現
 * 網頁和機器人算出不同的分帳金額為止。這支測試用大量隨機輸入強制比對，
 * 讓漂移在 CI 就爆掉。
 */

// 固定種子的偽隨機，確保失敗案例可以重現
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const MEMBER_POOL = ['代杰', 'Amy', 'Bob', '小明', '花子', 'D'];

describe('calculateDistribution：前端與 Edge Function 必須完全一致', () => {
  it('5000 組隨機輸入的結果逐一相同', () => {
    const rng = makeRng(20260902);
    const mismatches: string[] = [];

    for (let n = 0; n < 5000; n++) {
      const memberCount = 1 + Math.floor(rng() * MEMBER_POOL.length);
      const members = MEMBER_POOL.slice(0, memberCount);

      // 含小數、負數與極大值
      const total = Math.round((rng() * 200000 - 20000) * 100) / 100;
      const precision = [0, 1, 2, 3][Math.floor(rng() * 4)];

      // 隨機鎖定部分成員
      const locked: Record<string, number> = {};
      members.forEach((m) => {
        if (rng() < 0.25) locked[m] = Math.round(rng() * 5000 * 100) / 100;
      });

      // 調整成員：有時給名單內的、有時給不存在的、有時給 null
      const pick = rng();
      const adjustment = pick < 0.6
        ? members[Math.floor(rng() * members.length)]
        : pick < 0.8
          ? '不存在的人'
          : null;

      const web = webDistribution(total, members, locked, adjustment, precision);
      const bot = botDistribution(total, members, locked, adjustment, precision);

      if (JSON.stringify(web) !== JSON.stringify(bot)) {
        mismatches.push(
          `case #${n}: total=${total} members=${JSON.stringify(members)} ` +
          `locked=${JSON.stringify(locked)} adj=${adjustment} precision=${precision}\n` +
          `  web=${JSON.stringify(web)}\n  bot=${JSON.stringify(bot)}`,
        );
        if (mismatches.length >= 3) break;
      }
    }

    expect(mismatches.join('\n')).toBe('');
  });

  it('邊界案例也一致', () => {
    const cases: Parameters<typeof webDistribution>[] = [
      [0, [], {}, null, 2],
      [0, ['A'], {}, null, 0],
      [100, ['A', 'B', 'C'], {}, null, 0],
      [100, ['A', 'B'], { A: 30, B: 30 }, 'B', 0],
      [100, ['A', 'B'], { A: 200 }, null, 0],
      [0.3, ['A', 'B', 'C'], {}, null, 2],
      [-100, ['A', 'B', 'C'], {}, 'C', 0],
      [1e9 + 1, ['A', 'B', 'C'], {}, null, 0],
    ];
    for (const args of cases) {
      expect(botDistribution(...args)).toEqual(webDistribution(...args));
    }
  });
});

describe('calculateSettlements：前端與 Edge Function 必須完全一致', () => {
  it('2000 組隨機結餘表的結果逐一相同', () => {
    const rng = makeRng(851221);
    const mismatches: string[] = [];

    for (let n = 0; n < 2000; n++) {
      const memberCount = 2 + Math.floor(rng() * (MEMBER_POOL.length - 1));
      const balances: Record<string, number> = {};
      MEMBER_POOL.slice(0, memberCount).forEach((m) => {
        balances[m] = Math.round((rng() * 20000 - 10000) * 100) / 100;
      });

      const web = webSettlements(balances);
      const bot = botSettlements(balances);

      if (JSON.stringify(web) !== JSON.stringify(bot)) {
        mismatches.push(
          `case #${n}: ${JSON.stringify(balances)}\n` +
          `  web=${JSON.stringify(web)}\n  bot=${JSON.stringify(bot)}`,
        );
        if (mismatches.length >= 3) break;
      }
    }

    expect(mismatches.join('\n')).toBe('');
  });

  it('邊界案例也一致', () => {
    const cases: Record<string, number>[] = [
      {},
      { A: 0, B: 0 },
      { A: -0.01, B: 0.01 },
      { A: -0.02, B: 0.02 },
      { A: -100, B: 60 },
      { A: -50, B: -50, C: 100 },
    ];
    for (const b of cases) {
      expect(botSettlements(b)).toEqual(webSettlements(b));
    }
  });
});

describe('餘額彙總與匯率換算：前端與 Edge Function 必須完全一致（M14）', () => {
  const CURRENCY_POOL = ['TWD', 'JPY', 'USD', 'KRW'];

  it('2000 組隨機支出的餘額彙總逐一相同', () => {
    const rng = makeRng(20260905);
    const mismatches: string[] = [];

    for (let n = 0; n < 2000; n++) {
      const memberCount = 2 + Math.floor(rng() * (MEMBER_POOL.length - 1));
      const members = MEMBER_POOL.slice(0, memberCount);
      const baseCurrency = CURRENCY_POOL[Math.floor(rng() * CURRENCY_POOL.length)];

      // 匯率表刻意做得很壞：有時漏掉主幣別、有時 rates[base] 不是 1、
      // 有時整個幣別沒設匯率 —— 這正是舊「已知風險 5」會爆開的地方。
      const rates: Record<string, number> = {};
      CURRENCY_POOL.forEach((c) => {
        if (rng() < 0.7) rates[c] = Math.round(rng() * 300) / 100;
      });
      if (rng() < 0.3) rates[baseCurrency] = Math.round((0.5 + rng()) * 100) / 100;

      const rows = [];
      const rowCount = Math.floor(rng() * 8);
      for (let r = 0; r < rowCount; r++) {
        const currency = CURRENCY_POOL[Math.floor(rng() * CURRENCY_POOL.length)];
        const payer_data: Record<string, number> = {};
        const split_data: Record<string, number> = {};
        members.forEach((m) => {
          if (rng() < 0.4) payer_data[m] = Math.round(rng() * 500000) / 100;
          if (rng() < 0.6) split_data[m] = Math.round(rng() * 500000) / 100;
        });
        // 偶爾混進已被移除的成員，兩邊都該一致地忽略他
        if (rng() < 0.15) split_data['已離開的人'] = 999;
        rows.push({ currency, payer_data, split_data });
      }

      const web = webBalances(rows, members, rates, baseCurrency);
      const bot = botBalances(rows, members, rates, baseCurrency);

      if (JSON.stringify(web) !== JSON.stringify(bot)) {
        mismatches.push(
          `case #${n}: base=${baseCurrency} rates=${JSON.stringify(rates)}\n` +
          `  rows=${JSON.stringify(rows)}\n` +
          `  web=${JSON.stringify(web)}\n  bot=${JSON.stringify(bot)}`,
        );
        if (mismatches.length >= 3) break;
      }
    }

    expect(mismatches.join('\n')).toBe('');
  });

  it('主幣別一律以 1 換算，rates 裡寫什麼都不算數', () => {
    // 這就是舊「已知風險 5」：Edge Function 用 1、前端用 rates[base]=2，兩邊差一倍
    const rates = { TWD: 2, JPY: 0.22 };
    expect(webRate('TWD', rates, 'TWD')).toBe(1);
    expect(botRate('TWD', rates, 'TWD')).toBe(1);
    expect(webRate('JPY', rates, 'TWD')).toBe(0.22);
    expect(botRate('JPY', rates, 'TWD')).toBe(0.22);
  });

  it('沒設匯率的幣別退回 1，並被回報出來；主幣別不算漏設', () => {
    const rows = [
      { currency: 'USD', payer_data: { A: 100 }, split_data: { A: 50, B: 50 } },
      { currency: 'TWD', payer_data: { B: 300 }, split_data: { A: 150, B: 150 } },
    ];
    for (const fn of [webBalances, botBalances]) {
      const res = fn(rows, ['A', 'B'], { JPY: 0.22 }, 'TWD');
      // TWD 是主幣別，即使不在 rates 裡也不該被當成「漏設匯率」（情境 D9）
      expect(res.missingRateCurrencies).toEqual(['USD']);
      expect(res.grandTotal).toEqual({ A: -100, B: 100 });
    }
  });

  it('金額用 Decimal 累加，不會出現浮點尾數', () => {
    const rows = [
      { currency: 'USD', payer_data: { A: 0.1 }, split_data: { A: 0.1 } },
      { currency: 'USD', payer_data: { A: 0.2 }, split_data: { B: 0.2 } },
    ];
    for (const fn of [webBalances, botBalances]) {
      const res = fn(rows, ['A', 'B'], { USD: 1 }, 'USD');
      expect(res.grandTotal.A).toBe(0.2);
      expect(res.grandTotal.B).toBe(-0.2);
    }
  });

  it('邊界案例也一致', () => {
    const cases: Parameters<typeof webBalances>[] = [
      [[], [], {}, 'TWD'],
      [[], ['A'], {}, 'TWD'],
      [[{ currency: '', payer_data: { A: 1 }, split_data: {} }], ['A'], {}, 'TWD'],
      [[{ currency: 'JPY' }], ['A'], { JPY: 0.22 }, 'TWD'],
      [[{ currency: 'JPY', payer_data: null, split_data: null }], ['A'], {}, 'TWD'],
      // rates 為 null／undefined 時不該爆掉
      [[{ currency: 'JPY', payer_data: { A: 10 }, split_data: { A: 10 } }], ['A'], null, 'TWD'],
    ];
    for (const args of cases) {
      expect(botBalances(...args)).toEqual(webBalances(...args));
    }
  });
});

describe('sumByCurrency：前端與 Edge Function 必須完全一致（M14）', () => {
  it('隨機批次的加總結果相同', () => {
    const rng = makeRng(913);
    const stringify = (m: Record<string, { toString(): string }>) =>
      JSON.stringify(Object.fromEntries(Object.keys(m).sort().map(k => [k, m[k].toString()])));

    for (let n = 0; n < 500; n++) {
      const rows = [];
      const count = Math.floor(rng() * 10);
      for (let r = 0; r < count; r++) {
        rows.push({
          amount: Math.round(rng() * 1000000) / 100,
          currency: ['TWD', 'JPY', 'USD'][Math.floor(rng() * 3)],
        });
      }
      expect(stringify(botSum(rows))).toBe(stringify(webSum(rows)));
    }
  });

  it('0.1 + 0.2 不會變成 0.30000000000000004', () => {
    const rows = [{ amount: 0.1, currency: 'USD' }, { amount: 0.2, currency: 'USD' }];
    expect(webSum(rows).USD.toString()).toBe('0.3');
    expect(botSum(rows).USD.toString()).toBe('0.3');
  });
});
