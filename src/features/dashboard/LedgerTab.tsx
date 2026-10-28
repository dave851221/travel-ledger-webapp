import React, { useMemo, useState } from 'react';
import { ChevronDown, RotateCcw, Search, X } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import QuickAddBar from '../../components/QuickAddBar';
import { ui } from '../../components/ui';
import { formatMoney } from '../../utils/money';
import ExpenseRow from './ExpenseRow';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

interface Props {
  trip: Trip;
  expenses: Expense[];
  currentUser: string | null;
  trashCount: number;
  onOpenExpense: (exp: Expense) => void;
  onEditExpense: (exp: Expense) => void;
  onDeleteExpense: (exp: Expense) => void;
  onQuickSaved: () => void;
  onOpenQuickInForm: (prefill: { description: string; amount: string }) => void;
  onOpenTrash: () => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  /** Rendered above the quick-add bar (the balance ticket on narrow screens) */
  summary?: React.ReactNode;
}

const LedgerTab: React.FC<Props> = ({
  trip, expenses, currentUser, trashCount,
  onOpenExpense, onEditExpense, onDeleteExpense, onQuickSaved, onOpenQuickInForm, onOpenTrash, showToast, summary,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [collapsedDates, setCollapsedDates] = useState<Record<string, boolean>>({});
  const readOnly = trip.is_archived;

  // 結清紀錄不放在帳目裡，只在結清分頁顯示
  const filteredExpenses = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return expenses.filter(e => {
      if (e.is_settlement) return false;
      const matchesSearch = !q || (
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        Object.keys(e.payer_data).some(p => p.toLowerCase().includes(q))
      );
      const matchesCategory = selectedCategories.length === 0 || selectedCategories.includes(e.category);
      return matchesSearch && matchesCategory;
    });
  }, [expenses, searchQuery, selectedCategories]);

  const groupedExpenses = useMemo(() => {
    const groups: Record<string, { expenses: Expense[]; totals: Record<string, number> }> = {};
    filteredExpenses.forEach(exp => {
      if (!groups[exp.date]) groups[exp.date] = { expenses: [], totals: {} };
      groups[exp.date].expenses.push(exp);
      groups[exp.date].totals[exp.currency] = (groups[exp.date].totals[exp.currency] || 0) + exp.amount;
    });
    return Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(date => {
      // 補上時間讓它以本地時區解析；`new Date('YYYY-MM-DD')` 是 UTC 午夜，
      // 在 UTC 以西的時區（例如美國）會顯示成前一天的星期
      const d = new Date(`${date}T00:00:00`);
      return { date, md: `${d.getMonth() + 1}/${d.getDate()}`, weekday: WEEKDAYS[d.getDay()], ...groups[date] };
    });
  }, [filteredExpenses]);

  const toggleCategory = (cat: string) =>
    setSelectedCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);

  const filtering = searchQuery.trim() !== '' || selectedCategories.length > 0;
  const hasAny = expenses.some(e => !e.is_settlement);

  return (
    <div className="space-y-3">
      {summary}

      {!readOnly && (
        <QuickAddBar
          trip={trip}
          currentUser={currentUser}
          onSaved={onQuickSaved}
          onOpenFullForm={onOpenQuickInForm}
          showToast={showToast}
        />
      )}

      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto no-scrollbar -ml-4 pl-4 pr-1 md:ml-0 md:pl-0 md:flex-wrap" role="group" aria-label="依分類篩選">
          <button
            onClick={() => setSelectedCategories([])}
            className={`${ui.chip} ${selectedCategories.length === 0 ? ui.chipOn : ui.chipOff}`}
            aria-pressed={selectedCategories.length === 0}
          >
            全部
          </button>
          {trip.categories.map(cat => {
            const on = selectedCategories.includes(cat);
            return (
              <button key={cat} onClick={() => toggleCategory(cat)} aria-pressed={on} className={`${ui.chip} ${on ? ui.chipOn : ui.chipOff}`}>
                {cat}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setSearchOpen(v => !v)}
          aria-label="搜尋"
          aria-expanded={searchOpen}
          className={`md:hidden shrink-0 ${ui.iconBtn} ${searchOpen || searchQuery ? 'bg-surface border border-line text-ink' : ''}`}
        >
          <Search size={18} />
        </button>
        <div className="hidden md:block relative w-56 shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={15} />
          <input
            type="search"
            aria-label="搜尋項目、分類、付款人"
            placeholder="搜尋項目、成員"
            className={`${ui.input} pl-9 py-2`}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {searchOpen && (
        <div className="md:hidden relative anim-fade">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={15} />
          <input
            type="search"
            autoFocus
            aria-label="搜尋項目、分類、付款人"
            placeholder="搜尋項目、分類、付款人"
            className={`${ui.input} pl-9 pr-9`}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} aria-label="清除搜尋" className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted">
              <X size={15} />
            </button>
          )}
        </div>
      )}

      <div className="hidden lg:grid grid-cols-[30px_minmax(0,1fr)_88px_92px_112px_100px] gap-x-3 px-4 pt-1 text-[11.5px] text-muted">
        <span /><span>項目</span><span>付款</span><span>分攤</span><span className="text-right">金額</span><span className="text-right">我的份額</span>
      </div>

      <div className="space-y-3 lg:space-y-0 lg:bg-surface lg:border lg:border-line lg:rounded-2xl lg:overflow-hidden">
        {groupedExpenses.map(({ date, md, weekday, expenses: dayExpenses, totals }) => {
          const collapsed = !!collapsedDates[date];
          return (
            <section key={date} aria-label={`${md} 的支出`} className="lg:[&:first-child>button]:border-t-0">
              <button
                onClick={() => setCollapsedDates(prev => ({ ...prev, [date]: !prev[date] }))}
                aria-expanded={!collapsed}
                className="w-full flex items-baseline gap-2 px-1 pb-1.5 lg:px-4 lg:py-2 lg:bg-sunk lg:border-y lg:border-line text-xs text-muted text-left"
              >
                <ChevronDown size={14} className={`self-center shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                <b className="num text-[13px] text-ink font-bold">{md} 週{weekday}</b>
                <span>{dayExpenses.length} 筆</span>
                <span className="ml-auto num font-semibold text-ink-2 text-right">
                  {Object.entries(totals).map(([cur, amt]) => formatMoney(amt, cur, trip.precision_config)).join(' · ')}
                </span>
              </button>
              {!collapsed && (
                <div className="bg-surface border border-line rounded-2xl overflow-hidden divide-y divide-line lg:bg-transparent lg:border-0 lg:rounded-none">
                  {dayExpenses.map(exp => (
                    <ExpenseRow
                      key={exp.id}
                      exp={exp}
                      trip={trip}
                      currentUser={currentUser}
                      onOpen={onOpenExpense}
                      onEdit={readOnly ? undefined : onEditExpense}
                      onDelete={readOnly ? undefined : onDeleteExpense}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {groupedExpenses.length === 0 && (
          <div className="bg-surface border border-line rounded-2xl lg:border-0 px-6 py-12 text-center">
            <p className="text-sm font-medium text-ink">{filtering ? '沒有符合條件的支出' : hasAny ? '沒有支出' : '還沒有任何支出'}</p>
            <p className="text-xs text-muted mt-1">
              {filtering ? '換個關鍵字或分類試試看。' : readOnly ? '這趟旅程已封存。' : '在上面輸入「拉麵 3000」，或按 ＋ 新增一筆。'}
            </p>
          </div>
        )}
      </div>

      {trashCount > 0 && (
        <button onClick={onOpenTrash} className="mx-auto flex items-center gap-1.5 text-xs text-muted hover:text-ink transition-colors py-2">
          <RotateCcw size={12} />垃圾桶裡有 {trashCount} 筆可以還原
        </button>
      )}
    </div>
  );
};

export default LedgerTab;
