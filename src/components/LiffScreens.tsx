import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { ui } from './ui';

/** Full-screen states shared by the LINE in-app pages (LIFF). */

export const LiffLoading: React.FC<{ message: string }> = ({ message }) => (
  <div className="min-h-dvh bg-canvas text-ink-2 flex flex-col items-center justify-center gap-3 p-6">
    <Loader2 className="animate-spin text-ink" size={28} />
    <p className="text-sm">{message}</p>
  </div>
);

export const LiffError: React.FC<{ message: string }> = ({ message }) => (
  <div className="min-h-dvh bg-canvas text-ink flex flex-col items-center justify-center p-8 text-center">
    <span className="w-14 h-14 rounded-2xl bg-neg/10 text-neg flex items-center justify-center mb-4"><AlertTriangle size={26} /></span>
    <h2 className="text-lg font-bold">載入失敗</h2>
    <p className="text-sm text-ink-2 mt-1.5 max-w-xs">{message}</p>
    <button onClick={() => window.location.reload()} className={`${ui.btnPrimary} mt-6 px-8 py-3`}>重試</button>
  </div>
);

export const LiffSuccess: React.FC<{
  title: string;
  detail?: string;
  canClose: boolean;
  onClose: () => void;
  closedHint: string;
}> = ({ title, detail, canClose, onClose, closedHint }) => (
  <div className="min-h-dvh bg-canvas text-ink flex flex-col items-center justify-center p-8 text-center">
    <span className="w-16 h-16 rounded-2xl bg-pos/10 text-pos flex items-center justify-center mb-5"><CheckCircle2 size={32} /></span>
    <h2 className="text-xl font-bold">{title}</h2>
    {detail && <p className="text-sm text-ink-2 mt-1.5">{detail}</p>}
    {canClose ? (
      <button onClick={onClose} className="mt-8 w-full max-w-xs rounded-xl bg-[#06c755] text-white font-bold py-3.5 hover:brightness-95 transition">返回 LINE</button>
    ) : (
      <p className="mt-6 text-sm text-muted">{closedHint}</p>
    )}
  </div>
);
