const LEAFLET_VERSION = '1.9.4';
const CSS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const JS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';

let pending: Promise<LeafletAPI> | null = null;

/**
 * Loads Leaflet from the CDN the first time a map is opened.
 * It used to be a blocking <script> in index.html, which every page paid for
 * even though only the itinerary map uses it.
 */
export const loadLeaflet = (): Promise<LeafletAPI> => {
  if (window.L) return Promise.resolve(window.L);
  if (pending) return pending;

  pending = new Promise<LeafletAPI>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    link.integrity = CSS_SRI;
    link.crossOrigin = '';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = JS_URL;
    script.integrity = JS_SRI;
    script.crossOrigin = '';
    script.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet did not initialise')));
    script.onerror = () => { pending = null; reject(new Error('Failed to load Leaflet')); };
    document.head.appendChild(script);
  });
  return pending;
};
