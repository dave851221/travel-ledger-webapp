import React, { useState } from 'react';
import { Check, ChevronDown, ChevronLeft, Compass, Ellipsis, House, Images, Lock, Plus, Settings, Trash2, UserRound } from 'lucide-react';
import type { Trip } from '../../types';
import BrandMark from '../../components/BrandMark';
import { ui } from '../../components/ui';
import Dropdown, { MenuDivider, MenuItem, MenuLabel } from './Dropdown';
import MemberAvatar from './MemberAvatar';
import type { TabDef, TabType } from './tabs';
import { TAB_ALBUM, TAB_RECYCLE, TAB_SIBLINGS } from './tabs';

interface IdentityProps {
  trip: Trip;
  currentUser: string | null;
  onPick: (name: string) => void;
}

const IdentityItems: React.FC<IdentityProps & { close: () => void }> = ({ trip, currentUser, onPick, close }) => (
  <>
    <MenuLabel>誰是「我」？會用來顯示你的帳</MenuLabel>
    {trip.members.map(m => (
      <MenuItem
        key={m}
        icon={<MemberAvatar name={m} size={24} isMe={m === currentUser} />}
        onClick={() => { onPick(m); close(); }}
        active={m === currentUser}
        trailing={m === currentUser ? <Check size={16} className="text-pos" /> : undefined}
      >
        {m}
      </MenuItem>
    ))}
  </>
);

interface ChromeProps extends IdentityProps {
  tabs: TabDef[];
  active: TabType;
  onChange: (tab: TabType) => void;
  trashCount: number;
  onBack: () => void;
  onOpenSettings: () => void;
}

/** 手機頂列：返回、旅程名稱、我是誰、⋯ 選單（設定、其他旅程、垃圾桶）。 */
export const MobileTopBar: React.FC<ChromeProps> = ({
  trip, currentUser, onPick, onChange, trashCount, onBack, onOpenSettings,
}) => {
  const [whoOpen, setWhoOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <header
      className="md:hidden sticky top-0 z-30 bg-canvas/90 backdrop-blur"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center gap-1.5 px-2.5 h-14">
        <button onClick={onBack} aria-label="所有旅程" className={ui.iconBtn}><ChevronLeft size={21} /></button>
        <div className="flex-1 min-w-0 leading-tight">
          <p className="text-[11px] text-muted truncate flex items-center gap-1">
            {trip.is_archived && <Lock size={10} />}
            {[trip.category?.trim(), `${trip.members.length} 人`, trip.is_archived ? '已封存' : null].filter(Boolean).join(' · ')}
          </p>
          <h1 className="text-base font-bold truncate">{trip.name}</h1>
        </div>
        <Dropdown
          open={whoOpen}
          onClose={() => setWhoOpen(false)}
          anchor={
            <button onClick={() => setWhoOpen(v => !v)} aria-label="選擇我是誰" className="w-9 h-9 flex items-center justify-center">
              {currentUser ? <MemberAvatar name={currentUser} size={30} isMe /> : (
                <span className="w-[30px] h-[30px] rounded-full border border-dashed border-ink-2 text-ink-2 flex items-center justify-center"><UserRound size={16} /></span>
              )}
            </button>
          }
        >
          <IdentityItems trip={trip} currentUser={currentUser} onPick={onPick} close={() => setWhoOpen(false)} />
        </Dropdown>
        <Dropdown
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          anchor={<button onClick={() => setMoreOpen(v => !v)} aria-label="更多" className={ui.iconBtn}><Ellipsis size={21} /></button>}
        >
          <MenuItem icon={<Settings size={17} />} onClick={() => { setMoreOpen(false); onOpenSettings(); }}>旅程設定</MenuItem>
          <MenuItem icon={<Images size={17} />} onClick={() => { setMoreOpen(false); onChange(TAB_ALBUM.key); }}>相簿</MenuItem>
          <MenuItem icon={<Compass size={17} />} onClick={() => { setMoreOpen(false); onChange(TAB_SIBLINGS.key); }}>其他旅程</MenuItem>
          <MenuItem
            icon={<Trash2 size={17} />}
            onClick={() => { setMoreOpen(false); onChange(TAB_RECYCLE.key); }}
            trailing={trashCount > 0 ? <span className="num text-xs text-muted">{trashCount}</span> : undefined}
          >
            垃圾桶
          </MenuItem>
          <MenuDivider />
          <MenuItem icon={<House size={17} />} onClick={() => { setMoreOpen(false); onBack(); }}>所有旅程</MenuItem>
        </Dropdown>
      </div>
    </header>
  );
};

/** 電腦版左側欄：品牌、目前旅程、分頁、垃圾桶與設定。 */
export const SideNav: React.FC<ChromeProps> = ({
  trip, tabs, active, onChange, trashCount, onBack, onOpenSettings,
}) => {
  const items = [...tabs, TAB_ALBUM, TAB_SIBLINGS];
  const navBtn = (on: boolean) =>
    `w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors ${
      on ? 'bg-accent/15 text-accent font-bold' : 'text-[#c9d0de] hover:bg-white/5 hover:text-white'
    }`;
  return (
    <aside className="hidden md:flex flex-col gap-1 w-[232px] shrink-0 bg-side text-[#c9d0de] px-3.5 py-5 sticky top-0 h-dvh">
      <button onClick={onBack} className="flex items-center gap-2.5 px-1.5 pb-4 text-white font-bold text-base text-left">
        <BrandMark inverted />旅遊小本本
      </button>
      <button onClick={onBack} className="text-left rounded-xl bg-white/[.07] hover:bg-white/10 px-3 py-2.5 mb-3 transition-colors" title="回到所有旅程">
        <span className="block text-[11px] text-[#8f9ab2]">目前旅程</span>
        <span className="flex items-center gap-1.5 text-white text-sm font-bold">
          <span className="truncate flex-1">{trip.name}</span>
          <ChevronDown size={15} className="shrink-0 -rotate-90" />
        </span>
      </button>
      <nav className="flex flex-col gap-0.5" aria-label="主要分頁">
        {items.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => onChange(key)} className={navBtn(key === active)} aria-current={key === active ? 'page' : undefined}>
            <Icon size={18} />{label}
          </button>
        ))}
      </nav>
      <div className="flex-1" />
      <button onClick={() => onChange(TAB_RECYCLE.key)} className={navBtn(active === 'recycle')}>
        <Trash2 size={18} />垃圾桶
        {trashCount > 0 && <span className="ml-auto num text-[11px] font-bold bg-white/10 rounded-md px-1.5">{trashCount}</span>}
      </button>
      <button onClick={onOpenSettings} className={navBtn(false)}><Settings size={18} />旅程設定</button>
    </aside>
  );
};

/** 電腦版內容區的標題列：旅程名稱、成員、我是誰、新增支出。 */
export const DesktopHeader: React.FC<IdentityProps & { onAdd?: () => void; onCategory?: () => void }> = ({
  trip, currentUser, onPick, onAdd, onCategory,
}) => {
  const [whoOpen, setWhoOpen] = useState(false);
  return (
    <header className="hidden md:flex items-end gap-x-4 gap-y-3 flex-wrap">
      <div className="min-w-[260px] flex-1">
        <p className="text-xs text-muted flex items-center gap-1.5">
          {trip.category?.trim() ? (
            <button onClick={onCategory} className="hover:text-ink transition-colors" title="查看同分類的旅程">{trip.category}</button>
          ) : '旅程'}
          {trip.is_archived && <span className="inline-flex items-center gap-1 text-warn"><Lock size={11} />已封存，只能查看</span>}
        </p>
        <h1 className="text-2xl font-bold leading-tight mt-0.5 text-balance">{trip.name}</h1>
      </div>
      <div className="flex -space-x-1.5" aria-label={`成員：${trip.members.join('、')}`}>
        {trip.members.slice(0, 6).map(m => <MemberAvatar key={m} name={m} size={28} isMe={m === currentUser} ring />)}
        {trip.members.length > 6 && <span className="w-7 h-7 rounded-full bg-sunk ring-2 ring-canvas text-[11px] text-ink-2 flex items-center justify-center num">+{trip.members.length - 6}</span>}
      </div>
      <Dropdown
        open={whoOpen}
        onClose={() => setWhoOpen(false)}
        anchor={
          <button onClick={() => setWhoOpen(v => !v)} className={`${ui.btnSecondary} py-2`}>
            {currentUser ? <>我是 <b>{currentUser}</b></> : '選擇我是誰'}<ChevronDown size={15} />
          </button>
        }
      >
        <IdentityItems trip={trip} currentUser={currentUser} onPick={onPick} close={() => setWhoOpen(false)} />
      </Dropdown>
      {onAdd && (
        <button onClick={onAdd} className={`${ui.btnPrimary} py-2`}><Plus size={16} strokeWidth={2.6} />新增支出</button>
      )}
    </header>
  );
};
