// Minimal Leaflet types covering only what the itinerary trip components use.
// Leaflet is loaded via CDN <script> in index.html, so window.L is the entry point.
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

  interface LeafletMarker extends LeafletLayer {
    setLatLng(latlng: LatLngTuple): LeafletMarker;
    addTo(map: LeafletMap): LeafletMarker;
  }

  type LeafletIcon = object;

  interface LeafletMap {
    setView(latlng: LatLngTuple, zoom: number): LeafletMap;
    flyToBounds(bounds: LeafletBounds, opts?: { padding?: [number, number]; duration?: number; maxZoom?: number }): LeafletMap;
    removeLayer(layer: LeafletLayer): LeafletMap;
    remove(): void;
  }

  interface LeafletAPI {
    map(el: HTMLElement): LeafletMap;
    tileLayer(url: string, opts?: { attribution?: string }): LeafletLayer;
    polyline(latlngs: LatLngTuple[], opts?: { color?: string; weight?: number; opacity?: number; dashArray?: string }): LeafletPolyline;
    marker(latlng: LatLngTuple, opts?: { icon?: LeafletIcon }): LeafletMarker;
    divIcon(opts: { className?: string; html?: string; iconSize?: [number, number]; iconAnchor?: [number, number] }): LeafletIcon;
  }

  interface Window {
    L?: LeafletAPI;
  }
}

export {};
