import React from 'react';
import Nagoya2026 from './trips/Nagoya2026';
import Osaka2025 from './trips/Osaka2025';
import TaichungEscape2026 from './trips/TaichungEscape2026';

/**
 * Itinerary Registry
 * 
 * To add an itinerary for a specific trip:
 * 1. Create a component in src/features/itinerary/trips/
 * 2. Import it here
 * 3. Add the trip ID and component to the ITINERARY_COMPONENTS map
 */

export const ITINERARY_COMPONENTS: Record<string, React.FC> = {
  '2377dcbd-856a-45b3-bb31-eb79b092ca3d': Nagoya2026,
  'ef04ab47-1fa7-4503-99d2-0b084bebe59f': Osaka2025,
  'd7374216-327b-4377-a968-a57bdb1548ea': TaichungEscape2026,
};

/**
 * Checks if a trip has a dedicated itinerary page
 */
export const hasItinerary = (tripId: string): boolean => {
  return !!ITINERARY_COMPONENTS[tripId];
};

/**
 * Gets the itinerary component for a trip
 */
export const getItineraryComponent = (tripId: string): React.FC | null => {
  return ITINERARY_COMPONENTS[tripId] || null;
};
