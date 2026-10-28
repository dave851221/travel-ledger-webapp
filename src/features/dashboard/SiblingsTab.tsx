import React from 'react';
import { ChevronRight, Lock, Settings, Tag, Users } from 'lucide-react';
import type { Trip } from '../../types';
import { ui } from '../../components/ui';

interface Props {
  trip: Trip;
  siblings: Trip[];
  onOpenTrip: (id: string) => void;
  onOpenCategory: () => void;
  onOpenSettings: () => void;
}

const SiblingsTab: React.FC<Props> = ({ trip, siblings, onOpenTrip, onOpenCategory, onOpenSettings }) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold">其他旅程</h2>
        {trip.category && <p className="text-xs text-muted mt-0.5">分類「{trip.category}」</p>}
      </div>
      {trip.category && (
        <button onClick={onOpenCategory} className="text-xs text-ink-2 hover:text-ink inline-flex items-center gap-0.5">
          在首頁查看<ChevronRight size={13} />
        </button>
      )}
    </div>

    {!trip.category ? (
      <div className="bg-surface border border-line rounded-2xl px-6 py-12 text-center">
        <span className="inline-flex w-11 h-11 rounded-2xl bg-sunk text-muted items-center justify-center mb-3"><Tag size={20} /></span>
        <p className="text-sm font-medium">這趟旅程還沒有分類</p>
        <p className="text-xs text-muted mt-1 mb-5 max-w-xs mx-auto">替旅程加上分類（例如家族、朋友、出差），這裡就會列出同一類的旅程。</p>
        <button onClick={onOpenSettings} className={ui.btnPrimary}><Settings size={15} />前往設定</button>
      </div>
    ) : siblings.length === 0 ? (
      <div className="bg-surface border border-line rounded-2xl px-6 py-12 text-center">
        <p className="text-sm font-medium">「{trip.category}」目前只有這一趟旅程</p>
        <p className="text-xs text-muted mt-1">之後建立同分類的旅程，就會出現在這裡。</p>
      </div>
    ) : (
      <ul className="bg-surface border border-line rounded-2xl divide-y divide-line overflow-hidden md:max-w-2xl">
        {siblings.map(s => (
          <li key={s.id}>
            <button onClick={() => onOpenTrip(s.id)} className="w-full text-left flex items-center gap-3 px-4 py-3.5 hover:bg-sunk transition-colors">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium truncate">{s.name}</p>
                <p className="text-xs text-muted mt-0.5 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1"><Users size={12} />{s.members.length} 人</span>
                  <span className="num">{Object.keys(s.rates || {}).join(' · ')}</span>
                </p>
              </div>
              {s.is_archived ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-ink-2 bg-sunk border border-line rounded-md px-2 py-0.5"><Lock size={10} />已封存</span>
              ) : <ChevronRight size={18} className="text-muted shrink-0" />}
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>
);

export default SiblingsTab;
