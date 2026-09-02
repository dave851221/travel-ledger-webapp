import React from 'react';
import Modal from './Modal';

type Tone = 'danger' | 'primary' | 'success';

const CONFIRM_BUTTON_CLASS: Record<Tone, string> = {
  danger: 'bg-rose-500 hover:bg-rose-600 shadow-rose-500/20',
  primary: 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/20',
  success: 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20',
};

const SOFT_ICON_CLASS: Record<Tone, string> = {
  danger: 'bg-rose-50 dark:bg-rose-900/20 text-rose-600',
  primary: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600',
  success: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600',
};

const SOLID_ICON_CLASS: Record<Tone, string> = {
  danger: 'bg-rose-600 text-white shadow-xl shadow-rose-500/30',
  primary: 'bg-blue-600 text-white shadow-xl shadow-blue-500/30',
  success: 'bg-emerald-600 text-white shadow-xl shadow-emerald-500/30',
};

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Modal 標題列 */
  title: string;
  /** 圓形圖示，通常是一個 lucide icon */
  icon: React.ReactNode;
  /** 主要提問，粗體大字 */
  heading?: React.ReactNode;
  /** 補充說明 */
  description?: React.ReactNode;
  /** 額外內容，插在說明與按鈕之間 */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 決定確認鍵與圖示的配色 */
  tone?: Tone;
  /** 圖示要不要用實心強調（用於破壞性更強的動作） */
  solidIcon?: boolean;
  /** 確認鍵左側的圖示 */
  confirmIcon?: React.ReactNode;
  disabled?: boolean;
}

/**
 * 統一的確認對話框。
 *
 * 專案禁止原生 confirm()，所有需要使用者點頭的破壞性動作都走這裡，
 * 通知訊息則走 useToast。
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  icon,
  heading,
  description,
  children,
  confirmLabel = '確認',
  cancelLabel = '取消',
  tone = 'danger',
  solidIcon = false,
  confirmIcon,
  disabled = false,
}) => (
  <Modal isOpen={isOpen} onClose={onClose} title={title}>
    <div className="py-6 text-center space-y-6">
      <div
        className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto ${
          solidIcon ? SOLID_ICON_CLASS[tone] : `${SOFT_ICON_CLASS[tone]} shadow-inner`
        }`}
      >
        {icon}
      </div>

      {(heading || description) && (
        <div className="space-y-2">
          {heading && (
            <p className="text-xl font-black text-slate-900 dark:text-white">{heading}</p>
          )}
          {description}
        </div>
      )}

      {children}

      <div className="flex gap-4 pt-4">
        <button
          onClick={onClose}
          className="flex-1 px-6 py-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 font-black hover:bg-slate-200 transition-all"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          disabled={disabled}
          className={`flex-1 px-6 py-4 rounded-2xl text-white font-black shadow-xl transition-all flex items-center justify-center gap-2 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:shadow-none ${CONFIRM_BUTTON_CLASS[tone]}`}
        >
          {confirmIcon}
          {confirmLabel}
        </button>
      </div>
    </div>
  </Modal>
);

export default ConfirmDialog;
