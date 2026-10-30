import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from './Modal';

type Tone = 'danger' | 'primary' | 'success';

const CONFIRM_BUTTON_CLASS: Record<Tone, string> = {
  danger: 'bg-neg text-white hover:opacity-90',
  primary: 'bg-primary text-on-primary hover:opacity-90',
  success: 'bg-pos text-white hover:opacity-90',
};

const SOFT_ICON_CLASS: Record<Tone, string> = {
  danger: 'bg-neg/10 text-neg',
  primary: 'bg-accent/15 text-ink',
  success: 'bg-pos/10 text-pos',
};

const SOLID_ICON_CLASS: Record<Tone, string> = {
  danger: 'bg-neg text-white',
  primary: 'bg-primary text-on-primary',
  success: 'bg-pos text-white',
};

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 回傳 Promise 時，執行期間確認鍵會停用，避免連點寫入兩次 */
  onConfirm: () => void | Promise<void>;
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
}) => {
  // 確認動作多半是寫入資料庫（記錄結清、刪除）。手機上網路一慢，
  // 使用者以為沒按到又按一次，就會多出一筆一模一樣的結清紀錄。
  const [busy, setBusy] = useState(false);
  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="pt-2 text-center space-y-5">
        <div
          className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto [&_svg]:w-7 [&_svg]:h-7 ${
            solidIcon ? SOLID_ICON_CLASS[tone] : SOFT_ICON_CLASS[tone]
          }`}
        >
          {icon}
        </div>

        {(heading || description) && (
          <div className="space-y-1.5 text-sm text-ink-2">
            {heading && <p className="text-lg font-bold text-ink">{heading}</p>}
            {description}
          </div>
        )}

        {children}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 px-5 py-3.5 rounded-xl bg-sunk border border-line text-ink-2 font-bold hover:text-ink transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={handleConfirm}
            disabled={disabled || busy}
            className={`flex-1 px-5 py-3.5 rounded-xl font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-40 ${CONFIRM_BUTTON_CLASS[tone]}`}
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : confirmIcon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ConfirmDialog;
