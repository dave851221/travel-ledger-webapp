import React from 'react';
import { getItinerary, isPlan } from './registry';
import ItineraryView from './ItineraryView';

/** The itinerary tab for a trip: a shared view for plans, or the trip's own component. */
const TripItinerary: React.FC<{ tripId: string }> = ({ tripId }) => {
  const entry = getItinerary(tripId);
  if (!entry) return <p className="text-center text-sm text-muted py-20">這趟旅程還沒有行程頁</p>;
  if (isPlan(entry)) return <ItineraryView plan={entry} />;
  const Custom = entry.component;
  return <Custom />;
};

export default TripItinerary;
