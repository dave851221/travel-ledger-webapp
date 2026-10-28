import React from 'react';
import { Ticket } from 'lucide-react';

/** The app logo: an amber ticket on a navy tile. Matches public/favicon.svg. */
const BrandMark: React.FC<{ size?: number; inverted?: boolean }> = ({ size = 34, inverted = false }) => (
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

export default BrandMark;
