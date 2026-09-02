import React, { useEffect, useRef } from 'react';

export interface TripMapProps {
  /** 每一天對應的路線座標，key 要和 DaySelector 的 day.key 一致 */
  routes: Record<string, LatLngTuple[]>;
  /** 目前顯示哪一天的路線 */
  activeDay: string;
  /** 初始中心點 */
  center: LatLngTuple;
  /** 初始縮放層級，預設 9 */
  zoom?: number;
  /** 路線顏色，預設藍色 */
  color?: string;
  /**
   * 每一天要用哪個交通工具圖示（會沿著路線移動的那個）。
   * 可以給固定字串，或依 day 決定，例如 `(day) => day === 'day1' ? '🚄' : '🚗'`。
   */
  vehicleIcon?: string | ((day: string) => string);
  /** 地圖高度的 Tailwind class，預設 `h-40 sm:h-96` */
  heightClass?: string;
}

const ANIMATION_MS_PER_LEG = 1000;

/**
 * 行程頁用的 Leaflet 地圖（選用元件）。
 *
 * 用不到地圖的行程頁完全不需要 import 這個檔案。
 *
 * Leaflet 是從 index.html 以 CDN <script> 載入的，不在 package.json 裡，
 * 所以入口是 `window.L`；還沒載完時這個元件只會顯示一塊空白容器。
 *
 * 封裝的重點是**清理**：離開時務必 `map.remove()`，
 * 否則切換分頁再回來會遇到「Map container is already initialized」。
 */
const TripMap: React.FC<TripMapProps> = ({
  routes,
  activeDay,
  center,
  zoom = 9,
  color = '#0d6efd',
  vehicleIcon = '🚗',
  heightClass = 'h-40 sm:h-96',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const polylineRef = useRef<LeafletPolyline | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const animationRef = useRef<number | null>(null);

  // 最新的 props 放進 ref，讓建圖的 effect 只跑一次
  const latest = useRef({ routes, color, vehicleIcon });
  latest.current = { routes, color, vehicleIcon };

  // 沿著路線把圖示一段一段移動過去
  const animate = (route: LatLngTuple[], index: number) => {
    if (index >= route.length - 1 || !markerRef.current) return;
    const [startLat, startLng] = route[index];
    const [endLat, endLng] = route[index + 1];
    let startTime: number | null = null;

    const step = (time: number) => {
      if (startTime === null) startTime = time;
      const progress = (time - startTime) / ANIMATION_MS_PER_LEG;
      if (progress > 1) {
        animate(route, index + 1);
        return;
      }
      if (markerRef.current) {
        markerRef.current.setLatLng([
          startLat + (endLat - startLat) * progress,
          startLng + (endLng - startLng) * progress,
        ]);
        animationRef.current = requestAnimationFrame(step);
      }
    };
    animationRef.current = requestAnimationFrame(step);
  };

  const drawDay = (day: string) => {
    const L = window.L;
    if (!L || !mapRef.current) return;
    const route = latest.current.routes[day];
    if (!route || route.length === 0) return;

    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    if (polylineRef.current) mapRef.current.removeLayer(polylineRef.current);
    if (markerRef.current) mapRef.current.removeLayer(markerRef.current);

    polylineRef.current = L.polyline(route, {
      color: latest.current.color,
      weight: 4,
      opacity: 0.7,
      dashArray: '10, 10',
    }).addTo(mapRef.current);

    mapRef.current.flyToBounds(polylineRef.current.getBounds(), {
      padding: [30, 30],
      duration: 1.5,
      maxZoom: 13,
    });

    const iconProp = latest.current.vehicleIcon;
    const emoji = typeof iconProp === 'function' ? iconProp(day) : iconProp;
    const icon = L.divIcon({
      className: 'trip-map-vehicle',
      html: `<div style="font-size: 24px; text-align: center;">${emoji}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    markerRef.current = L.marker(route[0], { icon }).addTo(mapRef.current);
    animate(route, 0);
  };

  // 建圖只做一次
  useEffect(() => {
    const L = window.L;
    if (!L || !containerRef.current || mapRef.current) return;

    mapRef.current = L.map(containerRef.current).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(mapRef.current);

    drawDay(activeDay);

    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      // 一定要銷毀，否則回到這個分頁時 Leaflet 會抱怨容器已被初始化
      mapRef.current?.remove();
      mapRef.current = null;
      polylineRef.current = null;
      markerRef.current = null;
    };
    // 只在掛載時建圖；換日子由下面那個 effect 處理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 換日子就重畫路線
  useEffect(() => {
    if (mapRef.current) drawDay(activeDay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDay]);

  return (
    <div
      ref={containerRef}
      className={`w-full ${heightClass} rounded-2xl border border-slate-200 dark:border-slate-800 shadow-inner z-0`}
    />
  );
};

export default TripMap;
