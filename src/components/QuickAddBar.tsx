import React, { useMemo, useState } from 'react';
import { Zap, Plus, Loader2, Settings2 } from 'lucide-react';
import { supabase } from '../api/supabase';
import type { Trip } from '../types';
import { buildQuickAddDraft, parseQuickAddInput } from '../utils/quickAdd';
import { formatMoney } from '../utils/money';
import { isSubmitEnter } from '../utils/keyboard';

interface QuickAddBarProps {
  trip: Trip;
  currentUser: string | null;
  /** 存檔成功後呼叫，讓外層重新抓資料 */
  onSaved: () => void;
  /** 使用者想改細節時，把已解析的內容帶進完整的支出表單 */
  onOpenFullForm: (prefill: { description: string; amount: string }) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

/**
 * 一行輸入的快速記帳。
 *
 * 打「拉麵 3000」按 Enter 就存檔，套用旅程的預設幣別、分類、付款人與分攤，
 * 完全不用開 modal。需要調整細節時再按旁邊的按鈕轉到完整表單。
 */
const QuickAddBar: React.FC<QuickAddBarProps> = ({
  trip,
  currentUser,
  onSaved,
  onOpenFullForm,
  showToast,
}) => {
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  const parsed = useMemo(() => parseQuickAddInput(input), [input]);
  // 預覽直接用實際要存入的草稿，才不會顯示已被移除的預設付款人或舊幣別
  const preview = useMemo(
    () => (parsed ? buildQuickAddDraft(input, trip, currentUser) : null),
    [parsed, input, trip, currentUser],
  );

  const submit = async () => {
    if (saving) return;
    const draft = buildQuickAddDraft(input, trip, currentUser);
    if (!draft) {
      showToast('請輸入金額，例如「拉麵 3000」', 'error');
      return;
    }
    if (!supabase) {
      showToast('尚未連線到資料庫，請稍後再試', 'error');
      return;
    }

    try {
      setSaving(true);
      const { error } = await supabase.from('expenses').insert([{
        trip_id: trip.id,
        date: draft.date,
        category: draft.category,
        description: draft.description,
        amount: draft.amount,
        currency: draft.currency,
        payer_data: draft.payer_data,
        split_data: draft.split_data,
        adjustment_member: draft.adjustment_member,
        photo_urls: [],
        is_settlement: false,
      }]);
      if (error) throw error;

      setInput('');
      showToast(`已記一筆：${draft.description} ${formatMoney(draft.amount, draft.currency, trip.precision_config)}`);
      onSaved();
    } catch (err) {
      showToast('記帳失敗：' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 rounded-xl bg-surface border border-line focus-within:border-ink-2 focus-within:ring-4 focus-within:ring-accent/20 transition pl-3 pr-1.5 py-1.5">
        <Zap size={16} className="text-accent shrink-0" />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (isSubmitEnter(e)) { e.preventDefault(); submit(); }
          }}
          placeholder="快速記帳：拉麵 3000"
          className="flex-1 min-w-0 bg-transparent outline-none text-base sm:text-sm text-ink placeholder:text-muted py-1"
          aria-label="快速記帳"
        />

        {parsed && (
          <button
            type="button"
            onClick={() => onOpenFullForm({ description: parsed.description, amount: String(parsed.amount) })}
            title="改用完整表單編輯細節"
            aria-label="改用完整表單編輯細節"
            className="p-2 rounded-lg text-muted hover:text-ink hover:bg-sunk transition-colors shrink-0"
          >
            <Settings2 size={16} />
          </button>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!parsed || saving}
          className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-on-primary font-bold text-xs transition disabled:bg-sunk disabled:text-muted disabled:border disabled:border-line"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} strokeWidth={2.8} />}
          記一筆
        </button>
      </div>

      {/* 讓使用者在按下去之前就知道會存成什麼。
          手機寬度有限，所以只列必要資訊並讓它自然換行。 */}
      {preview && (
        <p className="text-[11px] text-muted px-1 leading-relaxed">
          {preview.description} ·{' '}
          <span className="num">{formatMoney(preview.amount, preview.currency, trip.precision_config)}</span> · {preview.category} ·{' '}
          {Object.keys(preview.payer_data).join('、')} 付
          {Object.keys(preview.split_data).length === trip.members.length
            ? ' · 全員均分'
            : ` · ${Object.keys(preview.split_data).length} 人分攤`}
        </p>
      )}
    </div>
  );
};

export default QuickAddBar;
