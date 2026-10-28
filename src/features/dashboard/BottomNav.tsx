import React from 'react';
import { Plus } from 'lucide-react';
import type { TabDef, TabType } from './tabs';

interface Props {
  tabs: TabDef[];
  active: TabType;
  onChange: (tab: TabType) => void;
  /** Omit to hide the add button (archived trips are read-only) */
  onAdd?: () => void;
}

/**
 * 手機底部導覽（分離式）：分頁收在浮起的膠囊裡，新增按鈕獨立在右側。
 * 沒有行程頁時膠囊只剩三格，新增按鈕的位置不變。
 */
const BottomNav: React.FC<Props> = ({ tabs, active, onChange, onAdd }) => (
  <nav
    className="md:hidden fixed z-40 left-0 right-0 bottom-0 flex items-center gap-2.5 pointer-events-none"
    style={{
      paddingLeft: 'max(12px, env(safe-area-inset-left))',
      paddingRight: 'max(12px, env(safe-area-inset-right))',
      paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
    }}
    aria-label="主要分頁"
  >
    <div
      className="pointer-events-auto flex-1 grid grid-flow-col auto-cols-fr bg-surface/95 backdrop-blur border border-line rounded-[24px] p-[5px]"
      style={{ boxShadow: '0 12px 28px -14px var(--app-shadow)' }}
    >
      {tabs.map(({ key, label, icon: Icon }) => {
        const on = key === active;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            aria-current={on ? 'page' : undefined}
            className={`flex flex-col items-center gap-0.5 rounded-[19px] pt-1.5 pb-1 text-[10.5px] transition-colors ${
              on ? 'bg-accent/20 text-ink font-bold' : 'text-muted'
            }`}
          >
            <Icon size={21} strokeWidth={on ? 2.2 : 1.8} />
            {label}
          </button>
        );
      })}
    </div>
    {onAdd && (
      <button
        onClick={onAdd}
        aria-label="新增支出"
        className="pointer-events-auto shrink-0 w-[60px] h-[60px] rounded-full bg-accent text-on-accent flex items-center justify-center active:scale-95 transition-transform"
        style={{ boxShadow: '0 12px 24px -10px var(--app-shadow)' }}
      >
        <Plus size={26} strokeWidth={2.4} />
      </button>
    )}
  </nav>
);

export default BottomNav;
