import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { useSheetDrag } from './useSheetDrag';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

/**
 * 共用彈窗。手機上是從底部滑出的面板（拇指搆得到關閉與送出），按住把手或標題列往下拉可以收起；
 * sm 以上是置中的對話框。內容過長時只捲內容區，標題列固定。
 */
const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, maxWidth = 'sm:max-w-md' }) => {
  // 這裡多半是表單：只從把手與標題列往下拉才收起，免得往上捲回頂端時一不小心整張表單被關掉
  const { sheetRef, handleRef, scrollRef } = useSheetDrag(onClose, { fromContent: false, enabled: isOpen });

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // 舊的呼叫端傳的是 'max-w-2xl' 這種寫法；手機上一律滿版，所以補上 sm: 前綴
  const width = maxWidth.startsWith('sm:') ? maxWidth : `sm:${maxWidth}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-scrim anim-fade"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-surface text-ink w-full ${width} max-h-[92dvh] sm:max-h-[88dvh] flex flex-col rounded-t-3xl sm:rounded-2xl shadow-2xl anim-sheet`}
      >
        <div ref={handleRef} className="shrink-0">
          <div className="sm:hidden pt-2.5 flex justify-center" aria-hidden>
            <span className="w-9 h-1 rounded-full bg-line" />
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
      </div>
    </div>
  );
};

export default Modal;
