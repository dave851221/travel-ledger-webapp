import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { loadLeaflet } from './loadLeaflet';

interface Props {
  /** One polyline per day, in order */
  routes: [number, number][][];
  /** Index of the day to emphasise; the others are drawn faintly */
  activeIndex?: number;
  color: string;
}

/**
 * 全趟路線的小地圖：靜態折線加上每天的起點，沒有動畫。
 * 只有使用者點開時才會掛載，Leaflet 也是那時候才下載。
 */
const RouteMap: React.FC<Props> = ({ routes, activeIndex = -1, color }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then(L => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const map = L.map(containerRef.current, { scrollWheelZoom: false });
        mapRef.current = map;
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(map);

        const all: [number, number][] = [];
        routes.forEach((route, i) => {
          if (route.length === 0) return;
          all.push(...route);
          const on = activeIndex === -1 || i === activeIndex;
          L.polyline(route, { color, weight: on ? 4 : 3, opacity: on ? 0.85 : 0.3, dashArray: on ? undefined : '6, 8' }).addTo(map);
          L.circleMarker(route[0], { radius: on ? 6 : 4, color: '#ffffff', weight: 2, fillColor: color, fillOpacity: on ? 1 : 0.5 })
            .bindTooltip(`Day ${i + 1}`)
            .addTo(map);
        });
        if (all.length > 0) map.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 12 });
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });

    return () => {
      cancelled = true;
      // 一定要銷毀，否則再打開時 Leaflet 會抱怨容器已被初始化
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [routes, activeIndex, color]);

  return (
    <div className="relative h-56 sm:h-72 rounded-xl overflow-hidden border border-line bg-sunk isolate">
      <div ref={containerRef} className="absolute inset-0" />
      {status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted gap-2">
          {status === 'loading' ? <><Loader2 size={16} className="animate-spin" />載入地圖中…</> : '地圖載入失敗，請確認網路連線'}
        </div>
      )}
    </div>
  );
};

export default RouteMap;
