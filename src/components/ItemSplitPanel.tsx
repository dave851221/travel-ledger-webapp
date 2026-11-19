import React, { useMemo, useState } from 'react';
import { Check, Minus, Plus, ReceiptText } from 'lucide-react';
import type { Trip } from '../types';
import { ui } from './ui';
import { formatMoney } from '../utils/money';
import { getCurrencyPrecision } from '../utils/finance';
import { splitByItems, UNREAD_ITEM_NAME, type ItemUnits, type ReceiptItem } from '../utils/itemSplit';

/**
 * 🧾 逐項分：LINE 收據卡片按「逐項分」進來的第一步。
 *
 * 每個品項點一下是誰的（可以多選＝那幾個人平分），沒點的由下方「其他品項」的人平分。
 * 有數量的品項（×5）預設「按份數」：同一列用 − ＋ 調每個人拿幾份，不必拆成好幾列；
 * 沒分完的份數也由下方的人平分。任何品項都能在「平分／按份數」之間切換。
 * 每個人該付多少即時算給你看（稅、整單折扣依比例攤，加總一定等於總額），
 * 按「下一步」把結果帶進原本的編輯表單確認後存入 —— 存檔、通知機器人都走原本那條路。
 */
const ItemSplitPanel: React.FC<{
  trip: Trip;
  currency: string;
  total: number;
  items: ReceiptItem[];
  /** 草稿原本的分攤名單：沒指定的品項預設由他們平分 */
  initialOthers: string[];
  /** 付款人：尾差優先給他 */
  payer: string | null;
  onDone: (split: Record<string, number>, adjustment: string) => void;
  onSkip: () => void;
}> = ({ trip, currency, total, items, initialOthers, payer, onDone, onSkip }) => {
  const members = trip.members;
  const [owners, setOwners] = useState<string[][]>(() => items.map(() => []));
  // null＝平分模式；物件＝按份數模式（{ 成員: 份數 }）
  const [units, setUnits] = useState<(ItemUnits | null)[]>(() =>
    items.map(it => ((it.qty ?? 0) >= 2 ? {} : null)));
  const [others, setOthers] = useState<string[]>(() => {
    const valid = initialOthers.filter(m => members.includes(m));
    return valid.length > 0 ? valid : members;
  });

  const precision = getCurrencyPrecision(currency, trip.precision_config ?? {});
  const money = (v: number) => formatMoney(v, currency, trip.precision_config ?? {});

  const toggleOwner = (i: number, m: string) => setOwners(prev => prev.map((list, j) => {
    if (j !== i) return list;
    return list.includes(m) ? list.filter(x => x !== m) : members.filter(x => x === m || list.includes(x));
  }));
  const setAllOwners = (i: number) => setOwners(prev => prev.map((list, j) =>
    j !== i ? list : (list.length === members.length ? [] : [...members])));
  const toggleOther = (m: string) => setOthers(prev =>
    prev.includes(m) ? prev.filter(x => x !== m) : members.filter(x => x === m || prev.includes(x)));
  const setMode = (i: number, byUnits: boolean) => setUnits(prev => prev.map((u, j) =>
    j !== i ? u : (byUnits ? (u ?? {}) : null)));
  const bump = (i: number, m: string, delta: number) => setUnits(prev => prev.map((u, j) => {
    if (j !== i || !u) return u;
    const qty = items[i].qty ?? 0;
    const taken = Object.values(u).reduce((a, b) => a + b, 0);
    if (delta > 0 && qty >= 2 && taken >= qty) return u;
    const next = Math.max(0, (u[m] ?? 0) + delta);
    const copy = { ...u };
    if (next === 0) delete copy[m]; else copy[m] = next;
    return copy;
  }));

  const taken = (i: number) => Object.values(units[i] ?? {}).reduce((a, b) => a + b, 0);
  // 每一項還有沒有要交給「其他人」平分的部分：平分模式沒點人、按份數沒分完
  const needsOthers = items.map((it, i) => {
    if (units[i]) {
      const t = taken(i);
      return t === 0 || ((it.qty ?? 0) > t);
    }
    return owners[i].length === 0;
  });
  const pendingCount = needsOthers.filter(Boolean).length;
  const doneCount = items.length - pendingCount;
  // 有品項（或剩下的份數）沒人認領、平分名單又是空的 —— 那幾項的錢會沒人付，不能往下走
  const blocked = pendingCount > 0 && others.length === 0;

  const result = useMemo(
    () => splitByItems(total, items, owners.map((o, i) => (units[i] ? [] : o)), others, precision, payer, units),
    [total, items, owners, units, others, precision, payer],
  );
  const diff = Math.abs(result.itemsTotal - total);
  const showDiff = diff >= Math.max(1, total * 0.005);

  const chip = (on: boolean) =>
    `min-h-10 px-3.5 rounded-full text-sm border transition-colors active:scale-[.97] ${on ? ui.chipOn : ui.chipOff}`;

  return (
    <div className="min-h-dvh bg-canvas text-ink flex flex-col">
      <header className="px-4 pt-[max(14px,env(safe-area-inset-top))] pb-3 border-b border-line bg-surface">
        <div className="flex items-center gap-2">
          <ReceiptText size={20} className="text-ink-2" />
          <h1 className="text-lg font-bold">逐項分</h1>
          <span className="ml-auto num text-lg font-bold">{money(total)}</span>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <div className="flex-1 h-1.5 rounded-full bg-sunk overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }} />
          </div>
          <span className="text-xs text-muted num shrink-0">已指定 {doneCount}／{items.length}</span>
        </div>
        <p className="text-xs text-muted mt-1.5">點品項是誰的，點好幾個人＝他們平分；有數量的可以按份數分。沒指定的由最下面的人平分。</p>
      </header>

      <ul className="flex-1 px-3 sm:px-4 py-3 space-y-2.5">
        {items.map((item, i) => {
          const mine = owners[i];
          const u = units[i];
          const qty = item.qty ?? 0;
          const t = taken(i);
          const done = !needsOthers[i];
          return (
            <li key={i} className={`${ui.card} p-3 border-l-4 ${done ? 'border-l-primary' : 'border-l-line'}`}>
              <div className="flex items-start gap-2">
                <span className="flex-1 min-w-0 text-[15px] font-medium leading-snug break-words">{item.name}</span>
                {qty >= 2 && (
                  <span className="shrink-0 num text-xs font-bold px-2 py-0.5 rounded-full bg-sunk text-ink-2">×{qty}</span>
                )}
                <span className="num text-[15px] font-bold shrink-0">{money(item.amount)}</span>
              </div>

              <div className="flex items-center gap-1 mt-2">
                <div role="tablist" className="inline-flex p-0.5 rounded-lg bg-sunk text-xs">
                  <button
                    type="button" role="tab" aria-selected={!u}
                    onClick={() => setMode(i, false)}
                    className={`px-3 py-1.5 rounded-md transition-colors ${!u ? 'bg-surface text-ink font-medium shadow-sm' : 'text-muted'}`}
                  >平分</button>
                  <button
                    type="button" role="tab" aria-selected={!!u}
                    onClick={() => setMode(i, true)}
                    className={`px-3 py-1.5 rounded-md transition-colors ${u ? 'bg-surface text-ink font-medium shadow-sm' : 'text-muted'}`}
                  >按份數</button>
                </div>
                {!u && members.length > 2 && (
                  <button type="button" onClick={() => setAllOwners(i)} className="ml-auto text-xs text-ink-2 px-2 py-1.5">
                    {mine.length === members.length ? '清除' : '全部人'}
                  </button>
                )}
                {u && (
                  <span className={`ml-auto text-xs num ${qty >= 2 && t >= qty ? 'text-pos font-medium' : 'text-muted'}`}>
                    {qty >= 2 ? `已分 ${t}／${qty} 份` : `共 ${t} 份`}
                  </span>
                )}
              </div>

              {!u ? (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {members.map(m => {
                    const on = mine.includes(m);
                    return (
                      <button key={m} type="button" onClick={() => toggleOwner(i, m)} aria-pressed={on} className={chip(on)}>
                        {on && <Check size={13} className="inline -mt-0.5 mr-1" strokeWidth={3} />}{m}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-1.5 mt-2">
                  {members.map(m => {
                    const n = u[m] ?? 0;
                    const full = qty >= 2 && t >= qty;
                    return (
                      <div
                        key={m}
                        className={`flex items-center gap-1 rounded-xl border pl-3 pr-1 py-1 transition-colors ${n > 0 ? 'border-primary bg-primary/5' : 'border-line bg-surface'}`}
                      >
                        <span className={`flex-1 min-w-0 truncate text-sm ${n > 0 ? 'text-ink font-medium' : 'text-ink-2'}`}>{m}</span>
                        <button
                          type="button" aria-label={`${m} 少一份`} disabled={n === 0}
                          onClick={() => bump(i, m, -1)}
                          className="w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-lg text-ink-2 active:bg-sunk disabled:opacity-30"
                        ><Minus size={16} strokeWidth={2.5} /></button>
                        <span className="w-6 text-center num text-base font-bold">{n}</span>
                        <button
                          type="button" aria-label={`${m} 多一份`} disabled={full}
                          onClick={() => bump(i, m, 1)}
                          className="w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-lg bg-primary text-on-primary active:opacity-80 disabled:opacity-30"
                        ><Plus size={16} strokeWidth={2.5} /></button>
                      </div>
                    );
                  })}
                </div>
              )}

              {item.name === UNREAD_ITEM_NAME && (
                <p className="text-xs text-muted mt-2">讀到的品項加起來比總額少這麼多，可能有一行沒讀到。知道是誰的就點他。</p>
              )}
              {u && t === 0 && <p className="text-xs text-muted mt-2">還沒分 → 由下面的人平分</p>}
              {u && t > 0 && qty > t && <p className="text-xs text-muted mt-2">剩 {qty - t} 份由下面的人平分</p>}
              {!u && mine.length === 0 && <p className="text-xs text-muted mt-2">還沒點 → 由下面的人平分</p>}
            </li>
          );
        })}

        <li className={`${ui.card} p-3`}>
          <p className="text-sm font-medium">沒指定的由誰平分{pendingCount > 0 ? `（${pendingCount} 項）` : ''}</p>
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {members.map(m => {
              const on = others.includes(m);
              return (
                <button key={m} type="button" onClick={() => toggleOther(m)} aria-pressed={on} className={chip(on)}>
                  {on && <Check size={13} className="inline -mt-0.5 mr-1" strokeWidth={3} />}{m}
                </button>
              );
            })}
          </div>
        </li>
      </ul>

      <footer className="sticky bottom-0 bg-surface border-t border-line px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,0.06)]">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {members.filter(m => result.split[m] !== undefined).map(m => (
            <div key={m} className="flex items-baseline justify-between text-sm">
              <span className="text-ink-2 truncate">{m}</span>
              <span className="num font-bold">{money(result.split[m])}</span>
            </div>
          ))}
        </div>
        {showDiff && (
          <p className="text-xs text-muted mt-2">
            品項合計 {money(result.itemsTotal)}，跟總額差 {money(Math.round((total - result.itemsTotal) * 100) / 100)}（稅、服務費或折扣），已依每個人點的金額比例攤進去。
          </p>
        )}
        {blocked && <p className="text-xs text-neg mt-2">還有品項沒人指定，請在「由誰平分」至少選一個人。</p>}
        <div className="flex gap-2 mt-3">
          <button type="button" onClick={onSkip} className={`${ui.btnSecondary} flex-1 py-3`}>直接編輯</button>
          <button
            type="button"
            disabled={blocked}
            onClick={() => onDone(result.split, result.adjustment)}
            className={`${ui.btnPrimary} flex-[2] py-3 text-base`}
          >
            下一步：確認
          </button>
        </div>
      </footer>
    </div>
  );
};

export default ItemSplitPanel;
