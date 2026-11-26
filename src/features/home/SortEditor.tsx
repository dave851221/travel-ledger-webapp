import React, { useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, ListOrdered } from 'lucide-react';
import type { Trip } from '../../types';
import { moveItem, UNCATEGORIZED, type TripGroup } from './homeLayout';
import { useDragSort } from './useDragSort';
import { ArchivedBadge, TripStamp } from './TripCards';

/**
 * 首頁的「排序」模式：分組可以拖曳或用上下箭頭調整，點「旅程順序」展開該組再調整組內的旅程。
 * 只改畫面上的草稿，按「完成」才由首頁存一次。
 */

const arrowBtn = 'inline-flex items-center justify-center w-9 h-9 rounded-xl text-ink-2 hover:text-ink hover:bg-sunk transition-colors disabled:opacity-25 disabled:hover:bg-transparent';
const handleCls = 'shrink-0 inline-flex items-center justify-center w-9 h-11 -ml-1 rounded-lg text-muted hover:text-ink cursor-grab active:cursor-grabbing select-none';

const MoveButtons: React.FC<{ index: number; count: number; label: string; onMove: (to: number) => void }> = ({ index, count, label, onMove }) => (
  <div className="shrink-0 flex items-center">
    <button type="button" className={arrowBtn} disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={`把「${label}」往上移`}>
      <ChevronUp size={18} />
    </button>
    <button type="button" className={arrowBtn} disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={`把「${label}」往下移`}>
      <ChevronDown size={18} />
    </button>
  </div>
);

const TripSortList: React.FC<{ trips: Trip[]; onChange: (trips: Trip[]) => void }> = ({ trips, onChange }) => {
  const move = (from: number, to: number) => onChange(moveItem(trips, from, to));
  const { containerRef, dragging, handleProps } = useDragSort(trips.map(t => t.id), move);
  return (
    <div ref={containerRef} className="border-t border-line divide-y divide-line bg-sunk/50">
      {trips.map((trip, i) => (
        <div
          key={trip.id}
          data-sort-key={trip.id}
          className={`flex items-center gap-2.5 pl-3 pr-1.5 py-1.5 transition-shadow ${
            dragging === trip.id ? 'relative z-10 bg-surface shadow-lg ring-2 ring-accent rounded-xl' : ''
          }`}
        >
          <span className={handleCls} aria-hidden {...handleProps(trip.id)}><GripVertical size={18} /></span>
          <TripStamp trip={trip} />
          <p className={`min-w-0 flex-1 text-sm font-medium truncate ${trip.is_archived ? 'text-ink-2' : 'text-ink'}`}>{trip.name}</p>
          {trip.is_archived && <span className="hidden sm:inline-flex"><ArchivedBadge /></span>}
          <MoveButtons index={i} count={trips.length} label={trip.name} onMove={to => move(i, to)} />
        </div>
      ))}
    </div>
  );
};

const SortEditor: React.FC<{ groups: TripGroup[]; onChange: (groups: TripGroup[]) => void }> = ({ groups, onChange }) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const move = (from: number, to: number) => onChange(moveItem(groups, from, to));
  const { containerRef, dragging, handleProps } = useDragSort(groups.map(g => g.category), move);
  const setTrips = (category: string, trips: Trip[]) =>
    onChange(groups.map(g => (g.category === category ? { ...g, trips } : g)));

  return (
    <div ref={containerRef} className="space-y-2.5">
      {groups.map((g, i) => {
        const isOpen = !!open[g.category] && dragging !== g.category;
        return (
          <section
            key={g.category}
            data-sort-key={g.category}
            className={`bg-surface border rounded-2xl overflow-hidden transition-shadow ${
              dragging === g.category ? 'relative z-10 border-accent shadow-xl ring-2 ring-accent' : 'border-line'
            }`}
          >
            <div className="flex items-center gap-1.5 pl-3 pr-1.5 py-1.5">
              <span className={handleCls} aria-hidden {...handleProps(g.category)}><GripVertical size={18} /></span>
              <div className="min-w-0 flex-1">
                <h3 className={`text-[15px] font-bold truncate ${g.category === UNCATEGORIZED ? 'text-ink-2' : 'text-ink'}`}>{g.category}</h3>
                <p className="text-xs text-muted num">{g.trips.length} 趟</p>
              </div>
              {g.trips.length > 1 && (
                <button
                  type="button"
                  onClick={() => setOpen(prev => ({ ...prev, [g.category]: !prev[g.category] }))}
                  aria-expanded={isOpen}
                  className={`shrink-0 inline-flex items-center gap-1 h-9 px-2.5 rounded-xl text-xs font-medium transition-colors ${
                    isOpen ? 'bg-primary text-on-primary' : 'text-ink-2 hover:text-ink hover:bg-sunk'
                  }`}
                >
                  <ListOrdered size={15} /><span className="hidden min-[400px]:inline">旅程順序</span>
                </button>
              )}
              <MoveButtons index={i} count={groups.length} label={g.category} onMove={to => move(i, to)} />
            </div>
            {isOpen && <TripSortList trips={g.trips} onChange={trips => setTrips(g.category, trips)} />}
          </section>
        );
      })}
    </div>
  );
};

export default SortEditor;
