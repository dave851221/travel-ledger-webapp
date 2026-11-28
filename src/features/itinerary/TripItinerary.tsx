import React, { useCallback, useState } from 'react';
import { Palette } from 'lucide-react';
import { IS_PUBLIC } from '../../config/mode';
import type { Trip } from '../../types';
import { getItinerary, isPlan } from './registry';
import ItineraryView from './ItineraryView';
import ItinerarySettings from './ItinerarySettings';
import SheetItinerary, { type ShareView } from './SheetItinerary';
import { isStyleKey, isThemeKey, type StyleKey, type ThemeKey } from './themes';
import type { ItineraryPlan } from './types';

/**
 * The itinerary tab for a trip: a plan written in code (registry), the trip's own component,
 * or — in the public app — a Google Sheet the members link themselves (SheetItinerary).
 *
 * 開放版（David 2026-11-28）：這趟存的色系、呈現方式（trips.itinerary_color／itinerary_style）蓋過行程本身的預設；
 * 只有建立者、管理員看得到「行程設定」（色系、呈現方式、換試算表、取消連結）。
 * share：分享頁（沒登入、只能看）。
 */
const TripItinerary: React.FC<{
  trip: Trip; canManage: boolean; onChanged: () => void; share?: ShareView;
}> = ({ trip, canManage, onChanged, share }) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const entry = getItinerary(trip.id);
  const manage = IS_PUBLIC && canManage && !share && !trip.is_archived;

  const applyLook = useCallback((plan: ItineraryPlan): ItineraryPlan => ({
    ...plan,
    theme: isThemeKey(trip.itinerary_color) ? trip.itinerary_color : plan.theme,
    style: isStyleKey(trip.itinerary_style) ? trip.itinerary_style : plan.style,
  }), [trip.itinerary_color, trip.itinerary_style]);

  const basePlan = entry && isPlan(entry) ? entry : null;
  const currentTheme: ThemeKey = isThemeKey(trip.itinerary_color) ? trip.itinerary_color : basePlan?.theme ?? 'default';
  const currentStyle: StyleKey = isStyleKey(trip.itinerary_style) ? trip.itinerary_style : basePlan?.style ?? 'classic';

  const settingsButton = manage ? (
    <button
      type="button"
      onClick={() => setSettingsOpen(true)}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 h-9 text-sm text-ink-2 hover:text-ink hover:bg-sunk"
    >
      <Palette size={15} />行程設定
    </button>
  ) : null;

  const settings = manage && (
    <ItinerarySettings
      trip={trip}
      isOpen={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      onChanged={onChanged}
      theme={currentTheme}
      style={currentStyle}
      onChangeSheet={trip.itinerary_sheet ? () => setChanging(true) : undefined}
    />
  );

  if (entry) {
    if (!isPlan(entry)) {
      const Custom = entry.component;
      return <Custom />;
    }
    return (
      <div className="space-y-3">
        {settingsButton && <div className="flex justify-end">{settingsButton}</div>}
        <ItineraryView plan={applyLook(entry)} />
        {settings}
      </div>
    );
  }
  if (!IS_PUBLIC) return <p className="text-center text-sm text-muted py-20">這趟旅程還沒有行程頁</p>;
  return (
    <>
      <SheetItinerary
        trip={trip}
        canManage={manage}
        changing={changing}
        onCancelChange={() => setChanging(false)}
        onChanged={onChanged}
        applyLook={applyLook}
        actions={settingsButton}
        share={share}
      />
      {settings}
    </>
  );
};

export default TripItinerary;
