import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { loadLeaflet } from './loadLeaflet';

export interface RouteMapDay {
  /** "D3 · 11/16" */
  label: string;
  title: string;
  route: [number, number][];
}

interface Props {
  days: RouteMapDay[];
  /** Day to open on */
  initialIndex?: number;
  color: string;
}

const DRAW_MS = 900;

/** Unique stops in visiting order; a return to an earlier point (back to the hotel) isn't renumbered. */
const stopsOf = (route: [number, number][]) => {
  const seen: [number, number][] = [];
  route.forEach(p => {
    if (!seen.some(q => q[0] === p[0] && q[1] === p[1])) seen.push(p);
  });
  return seen;
};

/**
 * 路線小地圖：一次只畫一天。切換日期時地圖飛到那天的範圍，路線一筆畫出來，
 * 停靠點標上順序。以前九天的線疊在同一張圖上，擠成一團看不出誰是誰。
 * 只有使用者點開時才會掛載，Leaflet 也是那時候才下載。
 */
const RouteMap: React.FC<Props> = ({ days, initialIndex = 0, color }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LeafletLayerGroup | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const withRoute = days.map((d, i) => ({ ...d, index: i })).filter(d => d.route.length > 0);
  const [pos, setPos] = useState(() => Math.max(0, withRoute.findIndex(d => d.index === initialIndex)));
  const current = withRoute[pos];

  // 建圖只做一次
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then(L => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        mapRef.current = L.map(containerRef.current, { scrollWheelZoom: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(mapRef.current);
        layerRef.current = L.layerGroup().addTo(mapRef.current);
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => {
      cancelled = true;
      // 一定要銷毀，否則再打開時 Leaflet 會抱怨容器已被初始化
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // 換一天就重畫：飛過去，再把路線一筆畫出來
  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (status !== 'ready' || !L || !map || !layer || !current) return;
    layer.clearLayers();

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bounds = L.latLngBounds(current.route);

    // 等地圖到位才畫線：飛行途中縮放一直在變，太早量出來的路徑長度會對不上
    let drawn = false;
    const draw = () => {
      if (drawn) return;
      drawn = true;
      const line = L.polyline(current.route, { color, weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' });
      layer.addLayer(line);
      const path = line.getElement() as SVGPathElement | undefined;
      if (path && !reduceMotion) {
        const length = path.getTotalLength();
        path.style.strokeDasharray = `${length}`;
        path.style.strokeDashoffset = `${length}`;
        path.getBoundingClientRect();
        path.style.transition = `stroke-dashoffset ${DRAW_MS}ms ease-in-out`;
        path.style.strokeDashoffset = '0';
        // 畫完就拿掉，之後使用者縮放時 Leaflet 重算路徑才不會被舊的虛線長度截斷
        path.addEventListener('transitionend', () => {
          path.style.strokeDasharray = '';
          path.style.strokeDashoffset = '';
          path.style.transition = '';
        }, { once: true });
      }
      stopsOf(current.route).forEach((p, i) => {
        const icon = L.divIcon({
          className: '',
          html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;background:${color};color:#fff;font:700 11px/1 Manrope,system-ui,sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)">${i + 1}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        layer.addLayer(L.marker(p, { icon, keyboard: false }));
      });
    };

    map.once('moveend', draw);
    // 視野沒變時不一定會有 moveend，保底在飛行時間之後畫
    const fallback = window.setTimeout(draw, reduceMotion ? 50 : 900);
    if (reduceMotion) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13 });
    else map.flyToBounds(bounds, { padding: [28, 28], maxZoom: 13, duration: 0.7 });

    return () => {
      window.clearTimeout(fallback);
      map.off('moveend', draw);
    };
  }, [status, current, color]);

  if (withRoute.length === 0) return null;
  const go = (step: number) => setPos(p => (p + step + withRoute.length) % withRoute.length);

  return (
    <div className="space-y-2">
      <div className="relative h-56 sm:h-72 rounded-xl overflow-hidden border border-line bg-sunk isolate">
        <div ref={containerRef} className="absolute inset-0" />
        {status !== 'ready' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted gap-2">
            {status === 'loading' ? <><Loader2 size={16} className="animate-spin" />載入地圖中…</> : '地圖載入失敗，請確認網路連線'}
          </div>
        )}
      </div>
      {current && (
        <div className="flex items-center gap-2">
          <button onClick={() => go(-1)} aria-label="前一天" className="w-9 h-9 shrink-0 rounded-xl bg-surface border border-line text-ink-2 hover:text-ink flex items-center justify-center">
            <ChevronLeft size={18} />
          </button>
          <p className="flex-1 min-w-0 text-center text-[13px] leading-tight" aria-live="polite">
            <span className="num font-bold text-[var(--t-accent)]">{current.label}</span>
            <span className="block truncate text-ink-2">{current.title}</span>
          </p>
          <button onClick={() => go(1)} aria-label="後一天" className="w-9 h-9 shrink-0 rounded-xl bg-surface border border-line text-ink-2 hover:text-ink flex items-center justify-center">
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
};

export default RouteMap;
