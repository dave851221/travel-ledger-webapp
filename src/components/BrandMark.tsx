import React from 'react';
import { Ticket } from 'lucide-react';
import { IS_PUBLIC } from '../config/mode';
import { CatFace } from './TravelCat';

/**
 * The app logo on a navy tile: an amber ticket (legacy 旅遊小本本, matches public/favicon.svg),
 * or 旅行喵喵's face in the public build (matches public/cat-favicon.svg).
 */
const BrandMark: React.FC<{ size?: number; inverted?: boolean }> = ({ size = 34, inverted = false }) => (
  <span
    className={`inline-flex items-center justify-center rounded-[10px] shrink-0 ${
      inverted ? (IS_PUBLIC ? 'bg-white' : 'bg-accent text-[#14213d]') : 'bg-navy text-accent'
    }`}
    style={{ width: size, height: size }}
    aria-hidden
  >
    {IS_PUBLIC
      ? <CatFace size={Math.round(size * 0.86)} />
      : <Ticket size={Math.round(size * 0.56)} strokeWidth={2} />}
  </span>
);

export default BrandMark;
