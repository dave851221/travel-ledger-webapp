import React from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import type { ToastState } from '../hooks/useToast';

/** 搭配 useToast 使用的提示條。toast 為 null 時不渲染。 */
const Toast: React.FC<{ toast: ToastState | null }> = ({ toast }) => {
  if (!toast) return null;
  return (
    <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-4 duration-300">
      <div
        className={`px-6 py-3 rounded-full shadow-2xl border flex items-center gap-3 font-black text-sm ${
          toast.type === 'success'
            ? 'bg-emerald-500 text-white border-emerald-400'
            : 'bg-rose-500 text-white border-rose-400'
        }`}
      >
        {toast.type === 'success'
          ? <Check size={18} strokeWidth={3} />
          : <AlertTriangle size={18} strokeWidth={3} />}
        {toast.message}
      </div>
    </div>
  );
};

export default Toast;
