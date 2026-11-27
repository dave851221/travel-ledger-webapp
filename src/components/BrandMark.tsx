import React from 'react';
import { Ticket } from 'lucide-react';
import { IS_PUBLIC } from '../config/mode';
import { ART } from '../config/art';

/**
 * The app logo. Legacy 旅遊小本本: an amber ticket on a navy tile (matches public/favicon.svg).
 * Public 旅行小本本: 旅行喵喵's round avatar (public/art/avatar.png, art by another AI — see docs/ART_PLAN.md).
 */
const BrandMark: React.FC<{ size?: number; inverted?: boolean }> = ({ size = 34, inverted = false }) => {
  if (IS_PUBLIC) {
    return (
      <img src={`${import.meta.env.BASE_URL}${ART.avatar}`} alt="" aria-hidden width={size} height={size}
        className="rounded-full shrink-0 bg-surface" style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[10px] shrink-0 ${
        inverted ? 'bg-accent text-[#14213d]' : 'bg-navy text-accent'
      }`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Ticket size={Math.round(size * 0.56)} strokeWidth={2} />
    </span>
  );
};

export default BrandMark;
