import React, { useState } from 'react';
import { ART, type ArtSlot } from '../config/art';
import { IS_PUBLIC } from '../config/mode';

/**
 * 旅行喵喵的插圖（src/config/art.ts）。只有開放版顯示；圖還沒放進 public/art/ 時載入失敗，就什麼都不畫。
 * 寬度由呼叫端給，高度照圖片比例。fallback：舊版或圖還沒有時改畫這個（原本的圖示）。
 */
const MascotArt: React.FC<{ slot: ArtSlot; width: number; className?: string; round?: boolean; fallback?: React.ReactNode }> = ({
  slot, width, className = '', round = false, fallback = null,
}) => {
  const [failed, setFailed] = useState(false);
  if (!IS_PUBLIC || failed) return <>{fallback}</>;
  return (
    <img
      src={`${import.meta.env.BASE_URL}${ART[slot]}`}
      alt=""
      aria-hidden
      width={width}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`${round ? 'rounded-full' : ''} ${className}`}
      style={{ width, height: 'auto' }}
    />
  );
};

export default MascotArt;
