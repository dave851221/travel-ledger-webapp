import React, { useMemo, useState } from 'react';
import { Zap, Plus, Loader2, Settings2 } from 'lucide-react';
import { supabase } from '../api/supabase';
import type { Trip } from '../types';
import { buildQuickAddDraft, parseQuickAddInput } from '../utils/quickAdd';
import { formatAmount } from '../utils/finance';

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
  const currency = trip.default_currency || trip.base_currency;
  const category = trip.default_category || trip.categories[0] || '其他';

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
      showToast(`已記一筆：${draft.description} ${formatAmount(draft.amount, draft.currency, trip.precision_config)}`);
      onSaved();
    } catch (err) {
      showToast('記帳失敗: ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-2xl bg-white dark:bg-slate-900 border-2 border-slate-100 dark:border-slate-800 focus-within:border-blue-500 transition-colors shadow-sm px-3 py-2">
        <Zap size={16} className="text-blue-500 shrink-0" />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
          }}
          placeholder="拉麵 3000"
          className="flex-1 min-w-0 bg-transparent outline-none font-bold text-sm py-1.5"
          aria-label="快速記帳"
        />

        {parsed && (
          <button
            type="button"
            onClick={() => onOpenFullForm({ description: parsed.description, amount: String(parsed.amount) })}
            title="改用完整表單編輯細節"
            className="p-2 rounded-xl text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all shrink-0"
          >
            <Settings2 size={16} />
          </button>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!parsed || saving}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 text-white font-black text-xs transition-all"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} strokeWidth={3} />}
          記一筆
        </button>
      </div>

      {/* 讓使用者在按下去之前就知道會存成什麼。
          手機寬度有限，所以只列必要資訊並讓它自然換行。 */}
      {parsed && (
        <p className="text-[10px] font-bold text-slate-400 px-2 leading-relaxed">
          {parsed.description || category} ·{' '}
          {formatAmount(parsed.amount, currency, trip.precision_config)} {currency} · {category} ·{' '}
          {(trip.default_payer?.length ? trip.default_payer.join('、') : currentUser || trip.members[0])}付
          {trip.default_split_members?.length ? `・${trip.default_split_members.length} 人分攤` : '・全員均分'}
        </p>
      )}
    </div>
  );
};

export default QuickAddBar;
