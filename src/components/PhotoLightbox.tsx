import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';

interface Props {
  /** Full URLs, in viewing order */
  photos: string[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  alt?: string;
  /** Shown under the photo (the album puts the expense and a 明細 button here) */
  footer?: React.ReactNode;
}

/**
 * 全螢幕看照片：左右滑或方向鍵換張、點照片放大、往下滑或按返回關閉。
 * 相簿與支出明細共用這一個。
 */
const PhotoLightbox: React.FC<Props> = ({ photos, index, onIndex, onClose, alt = '', footer }) => {
  const [zoomed, setZoomed] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const many = photos.length > 1;

  useBackClose(true, onClose);

  const go = useCallback((step: number) => {
    setZoomed(false);
    onIndex((index + step + photos.length) % photos.length);
  }, [index, photos.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && many) go(-1);
      else if (e.key === 'ArrowRight' && many) go(1);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [go, many, onClose]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (zoomed || e.touches.length !== 1) { touch.current = null; return; }
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && many) go(dx < 0 ? 1 : -1);
    else if (dy > 90 && dy > Math.abs(dx)) onClose();
  };

  const navBtn = 'absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex items-center justify-center w-11 h-11 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white';

  // Portaled to <body> so no ancestor's stacking context can put page content above it
  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black flex flex-col anim-fade" role="dialog" aria-modal="true" aria-label="照片">
      <div className="flex items-center gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-2 text-white">
        <span className="num text-sm text-white/70 px-1">{index + 1} / {photos.length}</span>
        <div className="flex-1" />
        <button
          onClick={() => setZoomed(z => !z)}
          aria-label={zoomed ? '縮小' : '放大'}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          {zoomed ? <ZoomOut size={19} /> : <ZoomIn size={19} />}
        </button>
        <button onClick={onClose} aria-label="關閉" className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <X size={20} />
        </button>
      </div>

      <div
        className={`relative flex-1 min-h-0 ${zoomed ? 'overflow-auto' : 'overflow-hidden flex items-center justify-center px-3'}`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={e => { if (e.target === e.currentTarget && !zoomed) onClose(); }}
      >
        {many && !zoomed && (
          <>
            <button aria-label="上一張" onClick={() => go(-1)} className={`${navBtn} left-3`}><ChevronLeft size={26} /></button>
            <button aria-label="下一張" onClick={() => go(1)} className={`${navBtn} right-3`}><ChevronRight size={26} /></button>
          </>
        )}
        <img
          key={photos[index]}
          src={photos[index]}
          alt={alt}
          onClick={() => setZoomed(z => !z)}
          className={zoomed
            ? 'max-w-none w-[200%] sm:w-auto cursor-zoom-out'
            : 'max-w-full max-h-full object-contain rounded-lg cursor-zoom-in select-none'}
        />
      </div>

      {footer
        ? <div className="px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] text-white">{footer}</div>
        : <div className="pb-[max(16px,env(safe-area-inset-bottom))]" />}
    </div>,
    document.body,
  );
};

export default PhotoLightbox;
