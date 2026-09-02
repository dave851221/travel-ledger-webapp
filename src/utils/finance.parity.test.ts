import { describe, it, expect } from 'vitest';
import { calculateDistribution as webDistribution } from './finance';
import { calculateSettlements as webSettlements } from './settlement';
import {
  calculateDistribution as botDistribution,
  calculateSettlements as botSettlements,
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
