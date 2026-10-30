import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect, lazy, Suspense } from 'react';
import Home from './pages/Home';
import TripPortal from './pages/TripPortal';
import { WifiOff, Wifi, Loader2 } from 'lucide-react';

// 首頁與通行碼頁以外都等用到才下載：Dashboard 帶著行程資料與表單，
// LIFF 頁只有從 LINE 進來才會開。手機第一次打開首頁不必先載這些。
const Dashboard = lazy(() => import('./pages/Dashboard'));
const LiffEdit = lazy(() => import('./pages/LiffEdit'));
const LiffPreference = lazy(() => import('./pages/LiffPreference'));

const PageLoading = () => (
  <div className="min-h-screen bg-canvas flex items-center justify-center">
    <Loader2 className="animate-spin text-ink" size={28} />
  </div>
);
import { useRegisterSW } from 'virtual:pwa-register/react';

function App() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showOnlineToast, setShowOnlineToast] = useState(false);

  // PWA 更新：新版本裝好就自動換上並重新整理（vite.config.ts 的 registerType: 'autoUpdate'）。
  // 從主畫面開啟的 PWA 可能好幾天都不重新載入，瀏覽器就不會去檢查新版本 ——
  // 回到前景與每小時各主動檢查一次。
  useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => { if (navigator.onLine) registration.update().catch(() => {}); };
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      setShowOnlineToast(true);
      setTimeout(() => setShowOnlineToast(false), 3000);
    };
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <Router>
      <div className="relative min-h-screen">
        {/* Offline Notification Bar */}
        {isOffline && (
          <div className="fixed top-0 left-0 right-0 z-[100] bg-navy text-navy-fg pt-[max(8px,env(safe-area-inset-top))] pb-2 px-4 flex items-center justify-center gap-2 text-xs">
            <WifiOff size={14} className="text-accent" />
            目前離線：新增的支出會先存在手機，恢復連線後自動上傳
          </div>
        )}

        {/* Back Online Toast */}
        {showOnlineToast && (
          <div className="fixed top-[max(16px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[100] bg-navy text-navy-fg py-2.5 px-4 rounded-xl shadow-xl flex items-center gap-2 text-sm anim-sheet">
            <Wifi size={16} className="text-pos" />
            已恢復連線
          </div>
        )}

        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/trip/:id" element={<TripPortal />} />
            <Route path="/trip/:id/dashboard" element={<Dashboard />} />
            <Route path="/liff/edit" element={<LiffEdit />} />
            <Route path="/liff/preference" element={<LiffPreference />} />
          </Routes>
        </Suspense>
      </div>
    </Router>
  );
}

export default App;
