import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Delete, Check } from 'lucide-react';
import { appendKey, evaluateExpression, formatCalcResult, hasOperation } from '../utils/calc';
import { formatMoney } from '../utils/money';

interface AmountCalculatorProps {
  /** Current amount in the form, used as the starting value */
  initial: string;
  currency: string;
  precisionConfig: Record<string, number>;
  decimals: number;
  /** Called with the rounded result when the user taps 帶入 */
  onApply: (value: string) => void;
  onClose: () => void;
}

type KeyDef = { label: React.ReactNode; key: string; tone?: 'op' | 'fn' | 'eq'; aria?: string };

const KEYS: KeyDef[] = [
  { label: 'C', key: 'clear', tone: 'fn', aria: '清除' },
  { label: '( )', key: 'paren', tone: 'fn', aria: '括號' },
  { label: <Delete size={20} />, key: 'back', tone: 'fn', aria: '退格' },
  { label: '÷', key: '÷', tone: 'op', aria: '除' },
  { label: '7', key: '7' }, { label: '8', key: '8' }, { label: '9', key: '9' },
  { label: '×', key: '×', tone: 'op', aria: '乘' },
  { label: '4', key: '4' }, { label: '5', key: '5' }, { label: '6', key: '6' },
  { label: '−', key: '−', tone: 'op', aria: '減' },
  { label: '1', key: '1' }, { label: '2', key: '2' }, { label: '3', key: '3' },
  { label: '+', key: '+', tone: 'op', aria: '加' },
  { label: '00', key: '00' }, { label: '0', key: '0' }, { label: '.', key: '.', aria: '小數點' },
  { label: '=', key: 'eq', tone: 'eq', aria: '等於' },
];

const toneClass: Record<string, string> = {
  num: 'bg-surface text-ink border border-line hover:bg-sunk',
  fn: 'bg-line/60 text-ink-2 hover:text-ink',
  op: 'bg-accent/15 text-accent hover:bg-accent/25 text-2xl',
  eq: 'bg-primary text-on-primary hover:opacity-90 text-2xl',
};

/**
 * Inline four-function calculator under the amount field. Built from buttons
 * (never an <input>) so the phone's own keyboard stays down while tapping.
 * A physical keyboard works too once the panel has focus.
 */
const AmountCalculator: React.FC<AmountCalculatorProps> = ({ initial, currency, precisionConfig, decimals, onApply, onClose }) => {
  const [expr, setExpr] = useState(() => {
    const v = evaluateExpression(initial);
    return v && v.greaterThan(0) ? v.toFixed() : '';
  });
  const [flash, setFlash] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Dismiss the phone keyboard the amount field may have raised, then take focus for hardware keys
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    panelRef.current?.focus({ preventScroll: true });
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const result = useMemo(() => evaluateExpression(expr), [expr]);
  const rounded = result ? formatCalcResult(result, decimals) : null;
  const canApply = rounded !== null && Number(rounded) > 0;
  const invalid = expr !== '' && result === null && !/[+−×÷(]$/.test(expr);

  const press = (key: string) => {
    if (navigator.vibrate) {
      try { navigator.vibrate(8); } catch { /* not allowed in some WebViews */ }
    }
    if (key === 'eq') {
      if (!result) return;
      setFlash(true);
      window.setTimeout(() => setFlash(false), 180);
      setExpr(result.toDecimalPlaces(Math.max(decimals, 6)).toFixed());
      return;
    }
    setExpr(prev => {
      switch (key) {
        case 'clear': return '';
        case 'back': return prev.slice(0, -1);
        case 'paren': {
          const open = (prev.match(/\(/g) ?? []).length - (prev.match(/\)/g) ?? []).length;
          const last = prev[prev.length - 1] ?? '';
          return open > 0 && /[0-9.)]/.test(last) ? appendKey(prev, ')') : appendKey(prev, '(');
        }
        default: return appendKey(prev, key);
      }
    });
  };

  const apply = () => {
    if (!canApply || rounded === null) return;
    onApply(rounded);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const map: Record<string, string> = {
      '*': '×', x: '×', X: '×', '/': '÷', '-': '−', '+': '+', '.': '.', ',': '.',
      '(': '(', ')': ')', Backspace: 'back', Delete: 'clear', '=': 'eq',
    };
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (hasOperation(expr)) press('eq'); else apply(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    const k = map[e.key];
    if (!k) return;
    e.preventDefault();
    if (k === '(' || k === ')') setExpr(prev => appendKey(prev, k));
    else press(k);
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="計算機"
      className="rounded-2xl bg-sunk/60 border border-line p-3 outline-none anim-calc select-none"
    >
      <div className="rounded-xl bg-surface border border-line px-3.5 py-2.5 mb-3 text-right min-h-[74px] flex flex-col justify-end">
        <div className={`num text-sm break-all leading-snug ${invalid ? 'text-neg' : 'text-muted'}`} aria-live="polite">
          {expr ? expr : <span className="opacity-70">輸入算式，例如 1200×3+500</span>}
        </div>
        <div className={`num text-3xl font-extrabold leading-tight truncate transition-transform ${flash ? 'scale-[1.04]' : ''} ${canApply ? 'text-ink' : 'text-muted'}`}>
          {invalid ? '算式不完整' : rounded !== null ? formatMoney(Number(rounded), currency, precisionConfig) : formatMoney(0, currency, precisionConfig)}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {KEYS.map(k => (
          <button
            key={k.key}
            type="button"
            aria-label={k.aria}
            onClick={() => press(k.key)}
            className={`num h-12 sm:h-11 rounded-xl text-xl font-bold flex items-center justify-center transition active:scale-95 touch-manipulation ${toneClass[k.tone ?? 'num']}`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2 mt-3">
        <button type="button" onClick={onClose} className="flex-1 inline-flex items-center justify-center rounded-xl bg-surface border border-line text-ink-2 font-medium h-12 sm:h-11 text-sm transition active:scale-[.98] hover:bg-sunk touch-manipulation">
          收起
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={!canApply}
          className="flex-[2] inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent text-on-accent font-bold h-12 sm:h-11 text-sm transition hover:brightness-105 active:scale-[.98] disabled:opacity-40 disabled:active:scale-100 touch-manipulation min-w-0"
        >
          <Check size={16} className="shrink-0" />
          <span className="truncate">帶入金額{canApply && rounded !== null ? ` ${formatMoney(Number(rounded), currency, precisionConfig)}` : ''}</span>
        </button>
      </div>
    </div>
  );
};

export default AmountCalculator;
