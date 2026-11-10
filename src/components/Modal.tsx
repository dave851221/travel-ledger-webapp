import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useSheetDrag } from './useSheetDrag';
import { useBackClose } from '../hooks/useBackClose';
import { ui } from './ui';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
  /**
   * 表單有還沒存的內容。點背景、按 Esc、按返回鍵這三種「很容易不小心」的關法會先問一聲；
   * 右上角的 ✕、往下拉、表單自己的取消鍵都是明確的動作，照舊直接關。
   */
  dirty?: boolean;
  /**
   * 這個彈窗就是整個頁面（LINE 裡的 LIFF 編輯頁），背後沒有東西可以回去。
   * 往下拉、點背景、Esc、返回鍵都不關它 —— 以前往下一拉表單就滑出畫面，
   * 但頁面關不掉（沒有 LIFF ID 時 closeWindow 無效），只剩一片空白。只留右上角的 ✕。
   */
  standalone?: boolean;
}

/**
 * 共用彈窗。手機上是從底部滑出的面板（拇指搆得到關閉與送出），按住把手或標題列往下拉可以收起；
 * sm 以上是置中的對話框。內容過長時只捲內容區，標題列固定。
 */
const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, maxWidth = 'sm:max-w-md', dirty = false, standalone = false }) => {
  // 這裡多半是表單：只從把手與標題列往下拉才收起，免得往上捲回頂端時一不小心整張表單被關掉
  const { sheetRef, handleRef, scrollRef } = useSheetDrag(onClose, { fromContent: false, enabled: isOpen && !standalone });
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Each time the modal opens it starts without the question showing
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    setConfirmingDiscard(false);
  }

  const requestClose = () => {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  };

  useBackClose(isOpen, requestClose, !standalone);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || standalone) return;
      // Esc on the question means "keep editing"
      if (confirmingDiscard) setConfirmingDiscard(false);
      else if (dirty) setConfirmingDiscard(true);
      else onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose, dirty, confirmingDiscard, standalone]);

  if (!isOpen) return null;

  // 舊的呼叫端傳的是 'max-w-2xl' 這種寫法；手機上一律滿版，所以補上 sm: 前綴
  const width = maxWidth.startsWith('sm:') ? maxWidth : `sm:${maxWidth}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-scrim anim-fade"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !standalone) requestClose(); }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative bg-surface text-ink w-full ${width} max-h-[92dvh] sm:max-h-[88dvh] flex flex-col rounded-t-3xl sm:rounded-2xl shadow-2xl anim-sheet`}
      >
        <div ref={handleRef} className="shrink-0">
          {/* The grab handle promises "pull me down"; a standalone sheet has nowhere to go */}
          <div className="sm:hidden pt-2.5 flex justify-center" aria-hidden>
            <span className={`w-9 h-1 rounded-full ${standalone ? 'bg-transparent' : 'bg-line'}`} />
          </div>
          <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-3 sm:pt-4 border-b border-line">
            <h3 className="text-lg font-bold text-ink truncate">{title}</h3>
            <button
              onClick={onClose}
              aria-label="關閉"
              className="p-1.5 -mr-1.5 rounded-lg text-muted hover:text-ink hover:bg-sunk transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div ref={scrollRef} className="px-5 py-5 overflow-y-auto overscroll-contain pb-[max(20px,env(safe-area-inset-bottom))]">
          {children}
        </div>

        {confirmingDiscard && (
          <div
            className="absolute inset-0 z-20 flex items-end sm:items-center justify-center rounded-t-3xl sm:rounded-2xl bg-scrim anim-fade"
            data-no-sheet-drag
            onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmingDiscard(false); }}
          >
            <div role="alertdialog" aria-label="要放棄還沒儲存的內容嗎？" className="w-full sm:max-w-xs bg-surface rounded-t-3xl sm:rounded-2xl shadow-2xl px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] sm:pb-5 space-y-4 anim-sheet">
              <div>
                <p className="text-base font-bold text-ink">要放棄還沒儲存的內容嗎？</p>
                <p className="text-sm text-ink-2 mt-1">關掉之後，剛剛填的內容不會保留。</p>
              </div>
              <div className="flex gap-2.5">
                <button onClick={onClose} className={`${ui.btnSecondary} flex-1 py-3`}>放棄</button>
                <button autoFocus onClick={() => setConfirmingDiscard(false)} className={`${ui.btnPrimary} flex-1 py-3`}>繼續編輯</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
