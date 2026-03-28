import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Home from './pages/Home';
import TripPortal from './pages/TripPortal';
import Dashboard from './pages/Dashboard';
import { WifiOff, Wifi, RefreshCw } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';

function App() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showOnlineToast, setShowOnlineToast] = useState(false);

  // PWA 更新邏輯
  const {
    needRefresh: [needRefresh, _setNeedRefresh],
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
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[150] bg-blue-600 text-white py-3 px-6 rounded-2xl shadow-2xl flex items-center gap-4 animate-in fade-in zoom-in duration-300 border border-white/20">
            <RefreshCw size={20} className="animate-spin-slow" />
            <div className="flex flex-col">
              <span className="text-sm font-black">發現新版本內容！</span>
              <span className="text-[10px] opacity-80 font-bold">點擊按鈕立即切換至最新版</span>
            </div>
            <button onClick={() => updateServiceWorker(true)} className="bg-white text-blue-600 px-4 py-1.5 rounded-xl text-xs font-black hover:bg-blue-50 transition-colors shadow-sm">立即更新</button>
          </div>
        )}

        {/* Offline Notification Bar */}
        {isOffline && (
          <div className="fixed top-0 left-0 right-0 z-[100] bg-slate-900 text-white py-2 px-4 flex items-center justify-center gap-3 animate-in slide-in-from-top duration-300">
            <WifiOff size={16} className="text-amber-400" />
            <span className="text-xs font-black tracking-widest uppercase">您目前處於離線模式 - 僅能查看快取資料</span>
          </div>
        )}

        {/* Back Online Toast */}
        {showOnlineToast && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-emerald-600 text-white py-3 px-6 rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in zoom-in duration-300">
            <Wifi size={20} />
            <span className="text-sm font-black">網路已恢復連線！</span>
          </div>
        )}

        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/trip/:id" element={<TripPortal />} />
          <Route path="/trip/:id/dashboard" element={<Dashboard />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
