import React, { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The trigger; the panel is positioned under it */
  anchor: React.ReactNode;
  align?: 'left' | 'right';
  width?: string;
  children: React.ReactNode;
}

/** Small popover menu anchored to its trigger. Closes on outside click and Escape. */
const Dropdown: React.FC<Props> = ({ open, onClose, anchor, align = 'right', width = 'w-56', children }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} className="relative">
      {anchor}
      {open && (
        <div
          role="menu"
          className={`absolute z-50 top-[calc(100%+6px)] ${align === 'right' ? 'right-0' : 'left-0'} ${width} bg-surface text-ink border border-line rounded-xl py-1.5 anim-fade`}
          style={{ boxShadow: '0 16px 36px -12px var(--app-shadow)' }}
        >
          {children}
        </div>
      )}
    </div>
  );
};

export const MenuLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-3.5 pt-1.5 pb-1 text-[11px] text-muted">{children}</p>
);

export const MenuItem: React.FC<{
  icon?: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  active?: boolean;
  danger?: boolean;
}> = ({ icon, onClick, children, trailing, active, danger }) => (
  <button
    role="menuitem"
    onClick={onClick}
    className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-left transition-colors hover:bg-sunk ${
      danger ? 'text-neg' : active ? 'text-ink font-bold' : 'text-ink'
    }`}
  >
    {icon && <span className="text-ink-2 shrink-0 flex">{icon}</span>}
    <span className="flex-1 min-w-0 truncate">{children}</span>
    {trailing}
  </button>
);

export const MenuDivider = () => <div className="my-1.5 h-px bg-line" />;

export default Dropdown;
