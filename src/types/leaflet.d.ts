// Minimal Leaflet types covering only what the itinerary route map uses.
// Leaflet is loaded from the CDN on demand (src/features/itinerary/loadLeaflet.ts),
// so window.L is the entry point once it has loaded.
declare global {
  type LatLngTuple = [number, number];

  interface LeafletLayer {
    addTo(map: LeafletMap): LeafletLayer;
  }

  type LeafletBounds = object;

  interface LeafletPolyline extends LeafletLayer {
    getBounds(): LeafletBounds;
    addTo(map: LeafletMap): LeafletPolyline;
  }

  interface LeafletCircleMarker extends LeafletLayer {
    bindTooltip(text: string): LeafletCircleMarker;
    addTo(map: LeafletMap): LeafletCircleMarker;
  }

  interface LeafletMap {
    setView(latlng: LatLngTuple, zoom: number): LeafletMap;
    fitBounds(bounds: LeafletBounds, opts?: { padding?: [number, number]; maxZoom?: number }): LeafletMap;
    removeLayer(layer: LeafletLayer): LeafletMap;
    remove(): void;
  }

  interface LeafletAPI {
    map(el: HTMLElement, opts?: { scrollWheelZoom?: boolean }): LeafletMap;
    tileLayer(url: string, opts?: { attribution?: string }): LeafletLayer;
    polyline(latlngs: LatLngTuple[], opts?: { color?: string; weight?: number; opacity?: number; dashArray?: string }): LeafletPolyline;
    circleMarker(latlng: LatLngTuple, opts?: { radius?: number; color?: string; weight?: number; fillColor?: string; fillOpacity?: number }): LeafletCircleMarker;
    latLngBounds(latlngs: LatLngTuple[]): LeafletBounds;
  }

  interface Window {
    L?: LeafletAPI;
  }
}

export {};
