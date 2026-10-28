import React from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import type { ToastState } from '../hooks/useToast';

/** 搭配 useToast 使用的提示條。toast 為 null 時不渲染。 */
const Toast: React.FC<{ toast: ToastState | null }> = ({ toast }) => {
  if (!toast) return null;
  return (
    <div
      role="status"
      className="fixed top-[max(16px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[100] w-max max-w-[calc(100vw-32px)] anim-sheet"
    >
      <div className="pl-3 pr-4 py-2.5 rounded-xl shadow-xl bg-navy text-navy-fg flex items-center gap-2.5 text-sm font-medium">
        <span
          className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
            toast.type === 'success' ? 'bg-pos text-white' : 'bg-neg text-white'
          }`}
        >
          {toast.type === 'success' ? <Check size={14} strokeWidth={3} /> : <AlertTriangle size={14} strokeWidth={2.5} />}
        </span>
        <span className="min-w-0">{toast.message}</span>
      </div>
    </div>
  );
};

export default Toast;
