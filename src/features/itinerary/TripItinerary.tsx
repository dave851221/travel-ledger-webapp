import React from 'react';
import { IS_PUBLIC } from '../../config/mode';
import type { Trip } from '../../types';
import { getItinerary, isPlan } from './registry';
import ItineraryView from './ItineraryView';
import SheetItinerary from './SheetItinerary';

/**
 * The itinerary tab for a trip: a plan written in code (registry), the trip's own component,
 * or — in the public app — a Google Sheet the members link themselves (SheetItinerary).
 */
const TripItinerary: React.FC<{ trip: Trip; readOnly: boolean; onChanged: () => void }> = ({ trip, readOnly, onChanged }) => {
  const entry = getItinerary(trip.id);
  if (entry) {
    if (isPlan(entry)) return <ItineraryView plan={entry} />;
    const Custom = entry.component;
    return <Custom />;
  }
  if (IS_PUBLIC) return <SheetItinerary trip={trip} readOnly={readOnly} onChanged={onChanged} />;
  return <p className="text-center text-sm text-muted py-20">這趟旅程還沒有行程頁</p>;
};

export default TripItinerary;
