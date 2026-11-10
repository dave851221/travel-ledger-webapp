import React from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import type { ToastState } from '../hooks/useToast';

/**
 * 搭配 useToast 使用的提示條。toast 為 null 時不渲染。
 * 點一下就收起來；帶 action 時右側多一顆按鈕（例如刪除後的「還原」）。
 * `--app-top-offset` 是離線提示條的高度（App.tsx），有它時往下讓開。
 */
const Toast: React.FC<{ toast: ToastState | null; onDismiss?: () => void }> = ({ toast, onDismiss }) => {
  if (!toast) return null;
  const { action } = toast;
  return (
    <div
      role="status"
      className="fixed left-1/2 -translate-x-1/2 z-[100] w-max max-w-[calc(100vw-32px)] anim-sheet"
      style={{ top: 'calc(max(16px, env(safe-area-inset-top)) + var(--app-top-offset, 0px))' }}
    >
      <div
        onClick={onDismiss}
        className="pl-3 pr-4 py-2.5 rounded-xl shadow-xl bg-navy text-navy-fg flex items-center gap-2.5 text-sm font-medium"
      >
        <span
          className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
            toast.type === 'success' ? 'bg-pos text-white' : 'bg-neg text-white'
          }`}
        >
          {toast.type === 'success' ? <Check size={14} strokeWidth={3} /> : <AlertTriangle size={14} strokeWidth={2.5} />}
        </span>
        <span className="min-w-0">{toast.message}</span>
        {action && (
          <button
            onClick={(e) => { e.stopPropagation(); action.onClick(); onDismiss?.(); }}
            className="shrink-0 -my-1 -mr-1.5 px-2.5 py-1.5 rounded-lg text-accent font-bold hover:bg-white/10 transition-colors"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
};

export default Toast;
