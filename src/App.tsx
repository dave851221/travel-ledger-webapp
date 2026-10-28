import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Home from './pages/Home';
import TripPortal from './pages/TripPortal';
import Dashboard from './pages/Dashboard';
import LiffEdit from './pages/LiffEdit';
import LiffPreference from './pages/LiffPreference';
import { WifiOff, Wifi, RefreshCw } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';

function App() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showOnlineToast, setShowOnlineToast] = useState(false);

  // PWA 更新邏輯
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

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
        {/* PWA Update Notification */}
        {needRefresh && (
          <div className="fixed top-[max(16px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[150] w-[calc(100vw-32px)] max-w-sm bg-navy text-navy-fg py-3 pl-4 pr-3 rounded-xl shadow-2xl flex items-center gap-3 anim-sheet">
            <RefreshCw size={18} className="text-accent shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold">有新版本</p>
              <p className="text-xs text-navy-sub">重新整理後就會換成最新版</p>
            </div>
            <button onClick={() => updateServiceWorker(true)} className="shrink-0 bg-accent text-on-accent px-3 py-1.5 rounded-lg text-xs font-bold">立即更新</button>
          </div>
        )}

        {/* Offline Notification Bar */}
        {isOffline && (
          <div className="fixed top-0 left-0 right-0 z-[100] bg-navy text-navy-fg pt-[max(8px,env(safe-area-inset-top))] pb-2 px-4 flex items-center justify-center gap-2 text-xs">
            <WifiOff size={14} className="text-accent" />
            目前離線，只能查看已載入的資料
          </div>
        )}

        {/* Back Online Toast */}
        {showOnlineToast && (
          <div className="fixed top-[max(16px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[100] bg-navy text-navy-fg py-2.5 px-4 rounded-xl shadow-xl flex items-center gap-2 text-sm anim-sheet">
            <Wifi size={16} className="text-pos" />
            已恢復連線
          </div>
        )}

        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/trip/:id" element={<TripPortal />} />
          <Route path="/trip/:id/dashboard" element={<Dashboard />} />
          <Route path="/liff/edit" element={<LiffEdit />} />
          <Route path="/liff/preference" element={<LiffPreference />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
