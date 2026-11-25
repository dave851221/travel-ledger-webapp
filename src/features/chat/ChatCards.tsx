import React, { useState } from 'react';
import {
  Check, ChevronDown, ChevronUp, CornerUpLeft, ListChecks, Loader2, Pencil, Trash2, Undo2, UserRound, X,
} from 'lucide-react';
import type { Expense, Trip } from '../../types';
import { ui } from '../../components/ui';
import { formatMoney } from '../../utils/money';
import { getCurrencyPrecision } from '../../utils/finance';
import { getCategoryVisual } from '../../utils/category';
import { photoUrl } from '../../utils/storage';
import MemberAvatar from '../dashboard/MemberAvatar';
import { canGoSolo, canSave, canSplitByItems, changeAmount, toggleMember } from './draftOps';
import type { ChatItem, DraftExpense, DraftItem, SummarySection } from './types';

/** 網址變成可以點的連結，其餘照原樣（保留換行） */
export const RichText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(https?:\/\/[^\s<>「」（）()]+)/g);
  return (
    <>
      {parts.map((p, i) => (/^https?:\/\//.test(p)
        ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-info underline break-all">{p}</a>
        : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  );
};

const ReplyButton: React.FC<{ onReply?: () => void }> = ({ onReply }) => onReply ? (
  <button
    onClick={onReply}
    className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-ink px-1.5 py-1 rounded-md hover:bg-sunk transition-colors"
    title="針對這張卡片回覆"
  >
    <CornerUpLeft size={13} />回覆
  </button>
) : null;

const StatusPill: React.FC<{ tone: 'pos' | 'muted' | 'neg'; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 ${
    tone === 'pos' ? 'bg-pos/10 text-pos' : tone === 'neg' ? 'bg-neg/10 text-neg' : 'bg-sunk text-muted'
  }`}>{children}</span>
);

// ── 記帳草稿卡 ───────────────────────────────

interface DraftCardProps {
  item: DraftItem;
  trip: Trip;
  me: string | null;
  busy: boolean;
  readOnly: boolean;
  onChange: (exp: DraftExpense) => void;
  onSave: () => void;
  onSolo: () => void;
  onCancel: () => void;
  onUndo: () => void;
  onFullForm: () => void;
  onItems: () => void;
  onCurrency: (currency: string) => void;
  onReply?: () => void;
  onOpenPhoto: (path: string) => void;
}

/** 一排成員，點一下加入／移出。付款人與分攤各一排 */
const MemberChips: React.FC<{
  trip: Trip;
  map: Record<string, number>;
  currency: string;
  disabled: boolean;
  onToggle: (m: string) => void;
}> = ({ trip, map, currency, disabled, onToggle }) => (
  <div className="flex flex-wrap gap-1.5">
    {trip.members.map(m => {
      const on = m in map;
      return (
        <button
          key={m}
          disabled={disabled}
          onClick={() => onToggle(m)}
          className={`inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-1 text-xs transition-colors ${
            on ? 'border-ink-2 bg-sunk text-ink' : 'border-line text-muted hover:text-ink'
          } disabled:opacity-60`}
          aria-pressed={on}
        >
          <MemberAvatar name={m} size={20} />
          <span className="font-medium">{m}</span>
          {on && <span className="num text-ink-2">{formatMoney(map[m], currency, trip.precision_config)}</span>}
        </button>
      );
    })}
  </div>
);

export const DraftCard: React.FC<DraftCardProps> = ({
  item, trip, me, busy, readOnly, onChange, onSave, onSolo, onCancel, onUndo, onFullForm, onItems, onCurrency, onReply, onOpenPhoto,
}) => {
  const exp = item.draft.exp;
  const pending = item.status === 'pending';
  const [showDetail, setShowDetail] = useState(false);
  const [amountText, setAmountText] = useState<string | null>(null);
  const visual = getCategoryVisual(exp.cat, trip.categories);
  const CatIcon = visual.icon;
  const precision = getCurrencyPrecision(exp.c, trip.precision_config);
  const payers = Object.keys(exp.p);
  const splits = Object.keys(exp.s);
  const evenSplit = splits.length > 0 && new Set(Object.values(exp.s)).size <= 2;
  const editable = pending && !busy && !readOnly && !item.currencies;

  const commitAmount = () => {
    if (amountText === null) return;
    const n = parseFloat(amountText);
    if (Number.isFinite(n) && n !== exp.a) onChange(changeAmount(exp, trip, n));
    setAmountText(null);
  };

  const photo = item.draft.photoIds[0];

  return (
    <div className={`${ui.card} overflow-hidden w-full max-w-[400px] ${pending ? '' : 'opacity-[.92]'}`}>
      <div className="px-4 pt-3 pb-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 min-w-0">
            {/* 照片在上面「傳出的照片」已經看得到，這裡只放小縮圖，點了放大 */}
            {photo && (
              <button onClick={() => onOpenPhoto(photo)} className="shrink-0 w-9 h-9 rounded-lg overflow-hidden bg-sunk border border-line" aria-label="看收據照片">
                <img src={photoUrl(photo)} alt="收據" className="w-full h-full object-cover" loading="lazy" />
              </button>
            )}
            <span className="text-xs font-bold text-accent">{item.title}</span>
          </span>
          {item.status === 'saved' && <StatusPill tone="pos"><Check size={12} />已存入</StatusPill>}
          {item.status === 'undone' && <StatusPill tone="muted"><Undo2 size={12} />已撤銷</StatusPill>}
          {item.status === 'cancelled' && <StatusPill tone="muted"><X size={12} />已取消</StatusPill>}
          {item.status === 'replaced' && <StatusPill tone="muted">已更新，看下面的新卡片</StatusPill>}
        </div>

        {/* 品名與金額：草稿可以直接改 */}
        {editable ? (
          <textarea
            rows={1}
            className="w-full resize-none bg-transparent text-lg font-bold leading-snug text-ink outline-none border-b border-transparent focus:border-line placeholder:text-muted"
            style={{ fieldSizing: 'content' } as React.CSSProperties}
            value={exp.d}
            placeholder={item.unidentified ? '這是什麼？' : '品名'}
            onChange={e => onChange({ ...exp, d: e.target.value.replace(/\n/g, ' ') })}
            aria-label="品名"
          />
        ) : (
          <p className="text-lg font-bold text-ink break-words">{exp.d || '（未命名）'}</p>
        )}
        <div className="flex items-center gap-2">
          {editable ? (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <span className="text-sm text-muted shrink-0">{exp.c}</span>
              <input
                type="number"
                inputMode="decimal"
                step={precision > 0 ? 1 / 10 ** precision : 1}
                className={`num text-2xl font-extrabold bg-transparent outline-none w-full border-b ${Number(exp.a) > 0 ? 'border-transparent' : 'border-warn'} focus:border-line`}
                value={amountText ?? (Number(exp.a) > 0 ? String(exp.a) : '')}
                placeholder="填金額"
                onChange={e => setAmountText(e.target.value)}
                onBlur={commitAmount}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                aria-label="金額"
              />
            </div>
          ) : (
            <p className="num text-2xl font-extrabold flex-1">{formatMoney(Number(exp.a) || 0, exp.c, trip.precision_config)}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-2">
          {editable ? (
            <>
              <input
                type="date"
                className="num bg-sunk rounded-lg px-2 py-1 text-xs outline-none"
                value={exp.dt}
                onChange={e => onChange({ ...exp, dt: e.target.value })}
                aria-label="日期"
              />
              <select
                className="bg-sunk rounded-lg px-2 py-1 text-xs outline-none"
                value={exp.cat}
                onChange={e => onChange({ ...exp, cat: e.target.value })}
                aria-label="分類"
              >
                {[...new Set([...trip.categories, exp.cat].filter(Boolean))].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </>
          ) : (
            <>
              <span className="num">{exp.dt}</span>
              <span className="inline-flex items-center gap-1"><CatIcon size={13} style={{ color: visual.color }} />{exp.cat}</span>
            </>
          )}
        </div>

        {/* 誰付、怎麼分：一行摘要，點開可以直接點選成員 */}
        <button
          onClick={() => setShowDetail(v => !v)}
          className="w-full flex items-center justify-between gap-2 rounded-xl bg-sunk px-3 py-2 text-left text-xs"
          aria-expanded={showDetail}
        >
          <span className="min-w-0 text-ink-2">
            <span className="text-muted">付款</span> <b className="text-ink">{payers.join('、') || '未指定'}</b>
            <span className="text-muted mx-1.5">·</span>
            <span className="text-muted">分攤</span>{' '}
            <b className="text-ink">{splits.length === trip.members.length && evenSplit ? '全員均分' : splits.join('、') || '未指定'}</b>
          </span>
          {showDetail ? <ChevronUp size={15} className="shrink-0 text-muted" /> : <ChevronDown size={15} className="shrink-0 text-muted" />}
        </button>
        {showDetail && (
          <div className="space-y-2.5">
            <div>
              <p className={ui.label}>誰付錢{editable && <span className="text-muted font-normal">（點一下加入或移出，金額自動均分）</span>}</p>
              <MemberChips trip={trip} map={exp.p} currency={exp.c} disabled={!editable} onToggle={m => onChange(toggleMember(exp, trip, 'p', m))} />
            </div>
            <div>
              <p className={ui.label}>怎麼分</p>
              <MemberChips trip={trip} map={exp.s} currency={exp.c} disabled={!editable} onToggle={m => onChange(toggleMember(exp, trip, 's', m))} />
            </div>
            {editable && <p className={ui.hint}>要讓每個人分不同金額，按「完整表單」。</p>}
          </div>
        )}

        {item.resultText && (
          <p className="whitespace-pre-wrap text-xs text-ink-2 bg-sunk rounded-xl px-3 py-2">{item.resultText}</p>
        )}

        {/* 收據的幣別這趟沒有匯率：先選一個 */}
        {pending && item.currencies && !readOnly && (
          <div className="space-y-1.5">
            <p className="text-xs text-warn">選一個幣別就能存（金額不會換算）：</p>
            <div className="flex flex-wrap gap-1.5">
              {item.currencies.map(c => (
                <button key={c} onClick={() => onCurrency(c)} className={`${ui.chip} ${ui.chipOff}`}>以 {c} 記</button>
              ))}
            </div>
          </div>
        )}

        {pending && !readOnly && !item.currencies && (
          <div className="space-y-2 pt-0.5">
            <button onClick={onSave} disabled={busy || !canSave(exp)} className={`${ui.btnPrimary} w-full py-2.5`}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} strokeWidth={2.6} />}
              {Number(exp.a) > 0 ? '確認存入' : '先填金額'}
            </button>
            <div className="flex flex-wrap gap-1.5">
              {canGoSolo(exp, trip, me) && (
                <button onClick={onSolo} disabled={busy} className={`${ui.btnSecondary} px-3 py-1.5 text-xs`}><UserRound size={14} />只算我</button>
              )}
              {canSplitByItems(item.draft, trip) && (
                <button onClick={onItems} disabled={busy} className={`${ui.btnSecondary} px-3 py-1.5 text-xs`}><ListChecks size={14} />逐項分</button>
              )}
              <button onClick={onFullForm} disabled={busy} className={`${ui.btnSecondary} px-3 py-1.5 text-xs`}><Pencil size={14} />完整表單</button>
              <button onClick={onCancel} disabled={busy} className={`${ui.btnSecondary} px-3 py-1.5 text-xs`}><X size={14} />取消</button>
            </div>
          </div>
        )}
        {pending && item.currencies && !readOnly && (
          <button onClick={onCancel} disabled={busy} className={`${ui.btnSecondary} px-3 py-1.5 text-xs`}><X size={14} />取消</button>
        )}

        <div className="flex items-center justify-between">
          {item.status === 'saved' && item.expenseId && !readOnly ? (
            <button onClick={onUndo} disabled={busy} className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink px-1.5 py-1 rounded-md hover:bg-sunk">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}撤銷
            </button>
          ) : <span />}
          {(pending || item.status === 'saved') && <ReplyButton onReply={onReply} />}
        </div>
      </div>
    </div>
  );
};

// ── 修改預覽、確認刪除 ───────────────────────────────

export const UpdateCard: React.FC<{
  item: Extract<ChatItem, { kind: 'update' }>;
  busy: boolean;
  readOnly: boolean;
  onApply: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onReply?: () => void;
}> = ({ item, busy, readOnly, onApply, onEdit, onCancel, onReply }) => (
  <div className={`${ui.card} w-full max-w-[400px] px-4 py-3 space-y-3`}>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-bold text-warn">✏️ 修改預覽</span>
      {item.status === 'done' && <StatusPill tone="pos"><Check size={12} />已修改</StatusPill>}
      {item.status === 'cancelled' && <StatusPill tone="muted"><X size={12} />已取消</StatusPill>}
    </div>
    <div>
      <p className="text-base font-bold break-words">{item.existing.description}</p>
      <p className="text-xs text-muted num">{item.existing.date} · 原本 {item.existing.amount} {item.existing.currency}</p>
    </div>
    <div className="space-y-2">
      {item.changes.map(c => (
        <div key={c.field} className="text-sm">
          <p className="text-[11px] text-muted">{c.label}</p>
          <p className="break-words"><span className="text-muted line-through">{c.before}</span> <span className="text-muted">→</span> <b>{c.after}</b></p>
        </div>
      ))}
    </div>
    {item.resultText && <p className="whitespace-pre-wrap text-xs text-ink-2 bg-sunk rounded-xl px-3 py-2">{item.resultText}</p>}
    {item.status === 'pending' && !readOnly && (
      <div className="flex flex-wrap gap-1.5">
        <button onClick={onApply} disabled={busy} className={`${ui.btnPrimary} flex-1 py-2`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} strokeWidth={2.6} />}確認修改
        </button>
        <button onClick={onEdit} disabled={busy} className={`${ui.btnSecondary} px-3 py-2 text-xs`}><Pencil size={14} />再調整</button>
        <button onClick={onCancel} disabled={busy} className={`${ui.btnSecondary} px-3 py-2 text-xs`}><X size={14} />取消</button>
      </div>
    )}
    <div className="flex justify-end"><ReplyButton onReply={onReply} /></div>
  </div>
);

export const DeleteCard: React.FC<{
  item: Extract<ChatItem, { kind: 'delete' }>;
  trip: Trip;
  busy: boolean;
  readOnly: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ item, busy, readOnly, onConfirm, onCancel }) => (
  <div className={`${ui.card} w-full max-w-[400px] px-4 py-3 space-y-3`}>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-bold text-neg">🗑 確認刪除？</span>
      {item.status === 'done' && <StatusPill tone="muted"><Trash2 size={12} />已刪除</StatusPill>}
      {item.status === 'cancelled' && <StatusPill tone="muted"><X size={12} />已取消</StatusPill>}
    </div>
    <div>
      <p className="text-base font-bold break-words">{item.existing.description}</p>
      <p className="text-xs text-muted num">{item.existing.date} · {item.existing.category} · {item.existing.amount} {item.existing.currency}</p>
    </div>
    {item.resultText && <p className="whitespace-pre-wrap text-xs text-ink-2 bg-sunk rounded-xl px-3 py-2">{item.resultText}</p>}
    {item.status === 'pending' && !readOnly && (
      <div className="flex gap-1.5">
        <button onClick={onConfirm} disabled={busy} className={`${ui.btnDanger} flex-1 py-2`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}確認刪除
        </button>
        <button onClick={onCancel} disabled={busy} className={`${ui.btnSecondary} px-4 py-2`}>取消</button>
      </div>
    )}
    {item.status === 'pending' && <p className={ui.hint}>刪除後 24 小時內可以到垃圾桶還原。</p>}
  </div>
);

// ── 快捷查詢的結果 ───────────────────────────────

export const SummaryCardView: React.FC<{
  title: string;
  subtitle?: string;
  sections: SummarySection[];
  totals: string[];
  notes?: string[];
}> = ({ title, subtitle, sections, totals, notes }) => (
  <div className={`${ui.card} w-full max-w-[400px] px-4 py-3 space-y-2.5`}>
    <div>
      <p className="text-base font-bold">{title}</p>
      {subtitle && <p className="text-xs text-muted num">{subtitle}</p>}
    </div>
    {sections.map((s, i) => (
      <div key={i} className="space-y-1">
        {s.heading && <p className="text-[11px] font-bold text-muted num pt-1">{s.heading}</p>}
        {s.rows.map((r, j) => (
          <div key={j} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0">
              <span className="break-words">{r.label}</span>
              {r.sub && <span className="block text-[11px] text-muted break-words">{r.sub}</span>}
            </span>
            <span className="num font-bold shrink-0">{r.value}</span>
          </div>
        ))}
      </div>
    ))}
    {totals.length > 0 && <div className="border-t border-line pt-2 text-sm font-bold num">{totals.join('\n')}</div>}
    {notes?.map((n, i) => <p key={i} className={ui.hint}>{n}</p>)}
  </div>
);

// ── 挑一筆已存的支出（「編輯支出」「刪除支出」，或模型沒說清楚要改哪一筆） ─────

export const PickExistingCard: React.FC<{
  text: string;
  trip: Trip;
  expenses: Expense[];
  readOnly: boolean;
  onEdit: (e: Expense) => void;
  onDelete: (e: Expense) => void;
}> = ({ text, trip, expenses, readOnly, onEdit, onDelete }) => {
  const recent = expenses
    .filter(e => !e.is_settlement && !e.deleted_at && !e.pending_sync)
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
  return (
    <div className={`${ui.card} w-full max-w-[400px] px-4 py-3 space-y-2`}>
      <p className="text-sm whitespace-pre-wrap">{text}</p>
      {recent.length === 0 && <p className={ui.hint}>還沒有任何支出。</p>}
      {recent.map(e => (
        <div key={e.id} className="flex items-center gap-2 border-t border-line pt-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm truncate">{e.description}</p>
            <p className="text-[11px] text-muted num">{e.date} · {formatMoney(e.amount, e.currency, trip.precision_config)}</p>
          </div>
          {!readOnly && (
            <>
              <button onClick={() => onEdit(e)} className={ui.iconBtn} aria-label={`編輯 ${e.description}`}><Pencil size={16} /></button>
              <button onClick={() => onDelete(e)} className={ui.iconBtn} aria-label={`刪除 ${e.description}`}><Trash2 size={16} /></button>
            </>
          )}
        </div>
      ))}
    </div>
  );
};
