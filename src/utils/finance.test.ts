import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { calculateDistribution, formatAmount, getCurrencyPrecision } from './finance';

describe('calculateDistribution', () => {
  it('整除時每人拿到相同金額', () => {
    expect(calculateDistribution(300, ['A', 'B', 'C'], {}, null, 0))
      .toEqual({ A: 100, B: 100, C: 100 });
  });

  it('除不盡時餘數歸給 adjustmentMember', () => {
    // 100 / 3 = 33.33…，ROUND_DOWN 後每人 33，餘 1 給 B
    const r = calculateDistribution(100, ['A', 'B', 'C'], {}, 'B', 0);
    expect(r).toEqual({ A: 33, B: 34, C: 33 });
    expect(r.A + r.B + r.C).toBe(100);
  });

  it('adjustmentMember 不在名單中時，餘數歸給第一位', () => {
    const r = calculateDistribution(100, ['A', 'B', 'C'], {}, '路人', 0);
    expect(r).toEqual({ A: 34, B: 33, C: 33 });
  });

  it('adjustmentMember 為 null 時，餘數歸給第一位', () => {
    expect(calculateDistribution(100, ['A', 'B', 'C'], {}, null, 0))
      .toEqual({ A: 34, B: 33, C: 33 });
  });

  it('鎖定的成員金額不變，其餘均分剩下的金額', () => {
    // A 鎖定 50，剩 50 由 B、C 均分
    const r = calculateDistribution(100, ['A', 'B', 'C'], { A: 50 }, null, 0);
    expect(r).toEqual({ A: 50, B: 25, C: 25 });
  });

  it('鎖定成員後仍除不盡時，餘數歸給未鎖定的 adjustmentMember', () => {
    // A 鎖定 40，剩 60 由 B、C、D 均分 = 20 各
    const r = calculateDistribution(101, ['A', 'B', 'C', 'D'], { A: 40 }, 'C', 0);
    expect(r.A).toBe(40);
    expect(r.B + r.C + r.D).toBe(61);
    expect(r.C).toBeGreaterThan(r.B); // C 承擔餘數
  });

  it('全部成員都鎖定且加總不等於總額時，差額強制加給調整成員', () => {
    const r = calculateDistribution(100, ['A', 'B'], { A: 30, B: 30 }, 'B', 0);
    expect(r).toEqual({ A: 30, B: 70 });
  });

  it('全部成員都鎖定且加總正好等於總額時，維持原樣', () => {
    expect(calculateDistribution(100, ['A', 'B'], { A: 30, B: 70 }, null, 0))
      .toEqual({ A: 30, B: 70 });
  });

  it('成員清單為空時回傳空物件', () => {
    expect(calculateDistribution(100, [], {}, null, 0)).toEqual({});
  });

  it('總額為 0 時每人皆為 0', () => {
    expect(calculateDistribution(0, ['A', 'B'], {}, null, 0)).toEqual({ A: 0, B: 0 });
  });

  it('precision 2 時保留兩位小數且總和精確', () => {
    const r = calculateDistribution(10, ['A', 'B', 'C'], {}, 'A', 2);
    expect(r).toEqual({ A: 3.34, B: 3.33, C: 3.33 });
    expect(r.A + r.B + r.C).toBeCloseTo(10, 10);
  });

  it('避開浮點數誤差：0.1 + 0.2 的情境', () => {
    const r = calculateDistribution(0.3, ['A', 'B', 'C'], {}, null, 2);
    expect(r).toEqual({ A: 0.1, B: 0.1, C: 0.1 });
  });

  it('單一成員拿到全額', () => {
    expect(calculateDistribution(999, ['A'], {}, null, 0)).toEqual({ A: 999 });
  });

  it('負數總額（退款情境）也能正確分配', () => {
    const r = calculateDistribution(-100, ['A', 'B', 'C'], {}, 'A', 0);
    expect(r.A + r.B + r.C).toBe(-100);
  });
});

describe('formatAmount', () => {
  it('使用旅程的 precision_config', () => {
    expect(formatAmount(1234.5, 'USD', { USD: 2 })).toBe('1234.50');
    expect(formatAmount(1234.5, 'JPY', { JPY: 0 })).toBe('1235');
  });

  it('precision_config 沒有該幣別時，退回內建預設（TWD/JPY/KRW 為 0 位）', () => {
    expect(formatAmount(1234.5, 'TWD', {})).toBe('1235');
    expect(formatAmount(1234.5, 'JPY', {})).toBe('1235');
    expect(formatAmount(1234.5, 'KRW', {})).toBe('1235');
  });

  it('完全未知的幣別退回 2 位小數', () => {
    expect(formatAmount(1234.5, 'XYZ', {})).toBe('1234.50');
  });

  it('旅程設定優先於內建預設', () => {
    expect(formatAmount(1234.5, 'TWD', { TWD: 2 })).toBe('1234.50');
  });
});

describe('getCurrencyPrecision', () => {
  it('旅程設定優先', () => {
    expect(getCurrencyPrecision('TWD', { TWD: 2 })).toBe(2);
    expect(getCurrencyPrecision('USD', { USD: 0 })).toBe(0);
  });

  it('沒設定時，TWD/JPY/KRW 為 0 位', () => {
    expect(getCurrencyPrecision('TWD')).toBe(0);
    expect(getCurrencyPrecision('JPY')).toBe(0);
    expect(getCurrencyPrecision('KRW')).toBe(0);
  });

  it('其餘幣別為 2 位', () => {
    expect(getCurrencyPrecision('USD')).toBe(2);
    expect(getCurrencyPrecision('EUR')).toBe(2);
    expect(getCurrencyPrecision('XYZ')).toBe(2);
  });

  it('與 formatAmount 一致（避免兩處各自寫 fallback）', () => {
    for (const cur of ['TWD', 'JPY', 'KRW', 'USD', 'XYZ']) {
      const decimals = formatAmount(1.23456, cur).split('.')[1]?.length ?? 0;
      expect(decimals).toBe(getCurrencyPrecision(cur));
    }
  });
});

describe('calculateDistribution 的總和不變量', () => {
  // 固定種子的偽隨機，失敗案例才能重現
  const makeRng = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  };

  const MEMBERS = ['代杰', 'Amy', 'Bob', '小明', '花子', 'D', 'E'];

  it('只要成員清單非空，Σ(分攤) 就精確等於總額 —— 5000 組隨機輸入', () => {
    const rng = makeRng(20260904);
    const failures: string[] = [];

    for (let n = 0; n < 5000; n++) {
      const members = MEMBERS.slice(0, 1 + Math.floor(rng() * MEMBERS.length));
      // 含小數、負數（退款）與極大值
      const total = Math.round((rng() * 500000 - 50000) * 100) / 100;
      const precision = [0, 1, 2, 3][Math.floor(rng() * 4)];

      const locked: Record<string, number> = {};
      members.forEach((m) => {
        // 有時鎖定的金額刻意超過總額，測試極端情況
        if (rng() < 0.3) locked[m] = Math.round(rng() * 80000 * 100) / 100;
      });

      const pick = rng();
      const adjustment = pick < 0.6
        ? members[Math.floor(rng() * members.length)]
        : pick < 0.8 ? '不存在的人' : null;

      const result = calculateDistribution(total, members, locked, adjustment, precision);

      // 用 Decimal 加總，否則浮點誤差會讓這個測試自己說謊
      const sum = Object.values(result).reduce(
        (acc, v) => acc.plus(new Decimal(v)),
        new Decimal(0),
      );

      if (!sum.equals(new Decimal(total))) {
        failures.push(
          `case #${n}: total=${total} precision=${precision} ` +
          `members=${JSON.stringify(members)} locked=${JSON.stringify(locked)} adj=${adjustment}\n` +
          `  Σ=${sum.toString()} 差額=${sum.minus(total).toString()}`,
        );
        if (failures.length >= 3) break;
      }
    }

    expect(failures.join('\n')).toBe('');
  });

  // 前提：總額本身已經符合該幣別的精度。
  // 這是實務上成立的 —— 兩條記帳路徑都會先 toDecimalPlaces(precision) 才分配。
  // 若總額的小數位比精度多（例如 precision=0 但總額 100.55），
  // 餘數承擔者必然會拿到超出精度的數字，否則總和就不可能精確相等；
  // 總和相等是更重要的保證，所以那是刻意的取捨而非缺陷。
  it('總額符合幣別精度時，每個人分到的金額也都符合', () => {
    const rng = makeRng(861205);
    for (let n = 0; n < 2000; n++) {
      const members = MEMBERS.slice(0, 2 + Math.floor(rng() * 5));
      const precision = [0, 2][Math.floor(rng() * 2)];
      const total = new Decimal(rng() * 100000).toDecimalPlaces(precision).toNumber();
      const result = calculateDistribution(total, members, {}, members[0], precision);

      for (const [member, value] of Object.entries(result)) {
        const decimals = new Decimal(value).decimalPlaces();
        expect(
          decimals <= precision,
          `${member} 得到 ${value}（${decimals} 位小數），但 precision=${precision}`,
        ).toBe(true);
      }
    }
  });

  it('成員清單為空是唯一的例外：回傳空物件，總和為 0', () => {
    expect(calculateDistribution(12345, [], {}, null, 2)).toEqual({});
  });
});
