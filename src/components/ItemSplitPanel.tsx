import React, { useMemo, useState } from 'react';
import { Check, ReceiptText } from 'lucide-react';
import type { Trip } from '../types';
import { ui } from './ui';
import { formatMoney } from '../utils/money';
import { getCurrencyPrecision } from '../utils/finance';
import { splitByItems, type ReceiptItem } from '../utils/itemSplit';

/**
 * 🧾 逐項分：LINE 收據卡片按「逐項分」進來的第一步。
 *
 * 每個品項點一下是誰的（可以多選＝那幾個人平分），沒點的由下方「其他品項」的人平分。
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
  const toggleOther = (m: string) => setOthers(prev =>
    prev.includes(m) ? prev.filter(x => x !== m) : members.filter(x => x === m || prev.includes(x)));

  const unassignedCount = owners.filter(o => o.length === 0).length;
  // 有品項沒人認領、平分名單又是空的 —— 那幾項的錢會沒人付，不能往下走
  const blocked = unassignedCount > 0 && others.length === 0;

  const result = useMemo(
    () => splitByItems(total, items, owners, others, precision, payer),
    [total, items, owners, others, precision, payer],
  );
  const diff = Math.abs(result.itemsTotal - total);
  const showDiff = diff >= Math.max(1, total * 0.005);

  return (
    <div className="min-h-dvh bg-canvas text-ink flex flex-col">
      <header className="px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-line bg-surface">
        <div className="flex items-center gap-2">
          <ReceiptText size={20} className="text-ink-2" />
          <h1 className="text-lg font-bold">逐項分</h1>
          <span className="ml-auto num text-base font-bold">{money(total)}</span>
        </div>
        <p className="text-xs text-muted mt-1">點每個品項是誰的，可以點好幾個人（就是他們平分）。沒點的由最下面的人平分。</p>
      </header>

      <ul className="flex-1 px-4 py-3 space-y-2.5">
        {items.map((item, i) => {
          const mine = owners[i];
          return (
            <li key={i} className={`${ui.card} p-3`}>
              <div className="flex items-baseline gap-3">
                <span className="flex-1 min-w-0 text-sm font-medium break-words">{item.name}</span>
                <span className="num text-sm font-bold shrink-0">{money(item.amount)}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {members.map(m => {
                  const on = mine.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggleOwner(i, m)}
                      aria-pressed={on}
                      className={`min-h-9 px-3.5 rounded-full text-sm border transition-colors ${on ? ui.chipOn : ui.chipOff}`}
                    >
                      {on && <Check size={13} className="inline -mt-0.5 mr-1" strokeWidth={3} />}{m}
                    </button>
                  );
                })}
              </div>
              {mine.length === 0 && <p className="text-xs text-muted mt-2">還沒點 → 由下面的人平分</p>}
            </li>
          );
        })}

        <li className={`${ui.card} p-3`}>
          <p className="text-sm font-medium">沒點的品項由誰平分{unassignedCount > 0 ? `（${unassignedCount} 項）` : ''}</p>
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {members.map(m => {
              const on = others.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleOther(m)}
                  aria-pressed={on}
                  className={`min-h-9 px-3.5 rounded-full text-sm border transition-colors ${on ? ui.chipOn : ui.chipOff}`}
                >
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
              <span className="text-ink-2">{m}</span>
              <span className="num font-bold">{money(result.split[m])}</span>
            </div>
          ))}
        </div>
        {showDiff && (
          <p className="text-xs text-muted mt-2">
            品項合計 {money(result.itemsTotal)}，跟總額差 {money(Math.round((total - result.itemsTotal) * 100) / 100)}（稅或折扣），已依比例攤進每個人。
          </p>
        )}
        {blocked && <p className="text-xs text-neg mt-2">還有品項沒人點，請在「由誰平分」至少選一個人。</p>}
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
