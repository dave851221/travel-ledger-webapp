import React, { useState, useEffect, useMemo, useRef } from 'react';
import { PlusCircle, Plane, Calendar, Users, Lock, Unlock, Loader2, AlertCircle, ChevronRight, ChevronDown, Tag, FolderOpen, Archive } from 'lucide-react';
import { supabase } from '../api/supabase';
import type { Trip } from '../types';
import Modal from '../components/Modal';
import { useNavigate, useLocation } from 'react-router-dom';

const UNCATEGORIZED = '未分類';
const TRIPS_PER_GROUP = 3;

const categorySlug = (name: string) => `cat-${encodeURIComponent(name)}`;

const TripCard: React.FC<{ trip: Trip; onClick: () => void }> = ({ trip, onClick }) => (
  <div
    onClick={onClick}
    className="group relative bg-white dark:bg-slate-900 p-5 rounded-xl shadow-[0_2px_8px_-2px_rgba(0,0,0,0.05)] hover:shadow-[0_12px_24px_-8px_rgba(0,0,0,0.1)] hover:-translate-y-1 transition-all duration-300 cursor-pointer border border-slate-100 dark:border-slate-800 flex flex-col h-full overflow-hidden"
  >
    <div className="flex justify-between items-center mb-4">
      <div className="text-left">
        <span className="block text-[9px] font-bold text-slate-300 dark:text-slate-600 uppercase tracking-widest mb-0.5">Currencies</span>
        <span className="inline-block text-[9px] font-bold text-blue-600 bg-blue-50 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-0.5 rounded uppercase">
          {Object.keys(trip.rates || {}).join(' / ')}
        </span>
      </div>
      {trip.is_archived && (
        <div className="flex items-center gap-1 text-[9px] font-bold text-slate-400 bg-slate-50 dark:bg-slate-800 px-2 py-0.5 rounded">
          <Lock size={10} /> 封存
        </div>
      )}
    </div>

    <h3 className="text-lg font-bold text-slate-800 dark:text-white leading-tight group-hover:text-blue-600 transition-colors mb-6 flex-grow">
      {trip.name}
    </h3>

    <div className="pt-4 border-t border-slate-50 dark:border-slate-800/50 flex items-center justify-between">
      <div className="flex items-center gap-4 text-[11px] text-slate-400 dark:text-slate-500 font-semibold">
        <div className="flex items-center gap-1.5">
          <Users size={14} />
          <span>{trip.members.length} 人</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Calendar size={14} />
          <span>{new Date(trip.created_at).toLocaleDateString()}</span>
        </div>
      </div>
      <div className="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 group-hover:bg-blue-600 group-hover:text-white transition-all">
        <ChevronRight size={16} />
      </div>
    </div>
  </div>
);

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState(false);
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});

  const [newTrip, setNewTrip] = useState({
    name: '',
    members: '',
    access_code: '',
    base_currency: 'TWD',
    category: ''
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchTrips();
    document.title = '代杰的旅遊小本本';
  }, []);

  const fetchTrips = async () => {
    if (!supabase) return;
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('trips')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTrips(data || []);
    } catch (err) {
      console.error('Error fetching trips:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // 已封存的旅程收進頁面底部的摺疊區塊，不參與分類分組，
  // 避免首頁隨著旅程累積而越來越長。
  const activeTrips = useMemo(() => trips.filter(t => !t.is_archived), [trips]);
  const archivedTrips = useMemo(() => trips.filter(t => t.is_archived), [trips]);

  const groupedTrips = useMemo(() => {
    const buckets = new Map<string, Trip[]>();
    activeTrips.forEach(t => {
      const key = (t.category && t.category.trim()) || UNCATEGORIZED;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(t);
    });
    const named: { category: string; trips: Trip[] }[] = [];
    let uncategorized: { category: string; trips: Trip[] } | null = null;
    buckets.forEach((groupTrips, category) => {
      const entry = { category, trips: groupTrips };
      if (category === UNCATEGORIZED) uncategorized = entry;
      else named.push(entry);
    });
    // Order named groups by newest trip in the group (desc), uncategorized always last.
    named.sort((a, b) => {
      const aLatest = Math.max(...a.trips.map(t => new Date(t.created_at).getTime()));
      const bLatest = Math.max(...b.trips.map(t => new Date(t.created_at).getTime()));
      return bLatest - aLatest;
    });
    return uncategorized ? [...named, uncategorized] : named;
  }, [activeTrips]);

  const knownCategories = useMemo(() => {
    const set = new Set<string>();
    trips.forEach(t => { if (t.category && t.category.trim()) set.add(t.category.trim()); });
    return Array.from(set).sort();
  }, [trips]);

  // Expand a section and scroll to it when arriving with #cat-<name> hash (e.g. from a trip page).
  useEffect(() => {
    if (loading || !location.hash) return;
    const decoded = decodeURIComponent(location.hash.replace('#', ''));
    if (!decoded.startsWith('cat-')) return;
    const target = decoded.slice(4);
    setExpandedGroups(prev => ({ ...prev, [target]: true }));
    // Defer scroll until expanded markup is committed.
    requestAnimationFrame(() => {
      const el = groupRefs.current[target];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [loading, location.hash, groupedTrips]);

  const handleCreateTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    // access_code 為選填：留空代表此旅程不需要密碼
    if (!newTrip.name || !newTrip.members || !supabase) return;

    try {
      setSubmitting(true);
      const membersArray = newTrip.members.split(',').map(m => m.trim()).filter(Boolean);
      
      const { data, error } = await supabase
        .from('trips')
        .insert([{
          name: newTrip.name,
          members: membersArray,
          access_code: newTrip.access_code.trim() || null,
          base_currency: newTrip.base_currency,
          category: newTrip.category.trim() || null,
          categories: ['餐飲', '交通', '住宿', '購物', '景點', '其他'],
          rates: { [newTrip.base_currency]: 1 },
          precision_config: { [newTrip.base_currency]: newTrip.base_currency === 'TWD' ? 0 : 2 }
        }])
        .select();

      if (error) throw error;

      setTrips([data[0], ...trips]);
      setIsModalOpen(false);
      setNewTrip({ name: '', members: '', access_code: '', base_currency: 'TWD', category: '' });
    } catch (err) {
      alert('建立失敗: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] dark:bg-slate-950 transition-colors duration-500 overflow-x-hidden">
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-[5%] -left-[5%] w-[45%] h-[45%] rounded-full bg-blue-100/40 dark:bg-blue-900/10 blur-[100px]" />
        <div className="absolute top-[25%] -right-[5%] w-[35%] h-[35%] rounded-full bg-indigo-50/40 dark:bg-indigo-900/10 blur-[100px]" />
      </div>

      {/* Main Container */}
      <main className="relative z-10 w-full px-6 sm:px-12 md:px-16 lg:px-24 py-12 md:py-16">
        <div className="max-w-5xl mx-auto">
          
          {/* Header Section */}
          <header className="flex flex-col md:flex-row md:items-end justify-between gap-8 mb-16 md:mb-20">
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="bg-blue-600 p-3 rounded-xl shadow-lg shadow-blue-500/30">
                  <Plane className="text-white" size={20} />
                </div>
                <span className="text-blue-600 font-bold tracking-[0.2em] text-[10px] uppercase">代杰的旅遊紀錄</span>
              </div>
              
              <div className="space-y-3">
                <h1 className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight leading-tight">
                  紀錄每一個<br className="hidden sm:block" />精彩旅遊
                </h1>
                <p className="text-slate-500 dark:text-slate-400 text-sm md:text-base font-medium max-w-sm leading-relaxed">
                  輕鬆管理旅程支出，精確計算每一分花費。
                </p>
              </div>
            </div>
            
            <button 
              onClick={() => setIsModalOpen(true)}
              className="group flex items-center justify-center gap-2 bg-slate-900 dark:bg-blue-600 hover:bg-blue-600 dark:hover:bg-blue-700 text-white font-bold px-6 py-4 rounded-xl transition-all shadow-lg active:scale-95 self-start"
            >
              <PlusCircle size={18} className="group-hover:rotate-90 transition-transform duration-300" />
              <span className="text-sm md:text-base">開啟新旅程</span>
            </button>
          </header>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/50 p-5 rounded-2xl flex items-center gap-4 text-red-700 dark:text-red-400 mb-10 animate-in fade-in slide-in-from-top-4">
              <AlertCircle size={20} className="shrink-0" />
              <div className="text-xs md:text-sm font-bold">發生錯誤：{error}</div>
            </div>
          )}

          {/* Trips List */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-white/50 dark:bg-slate-800/50 animate-pulse rounded-xl h-48 border border-slate-100 dark:border-slate-800" />
              ))}
            </div>
          ) : trips.length === 0 ? (
            <div className="bg-white/40 dark:bg-slate-900/40 backdrop-blur-sm p-12 md:p-20 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800 flex flex-col items-center justify-center text-center group transition-all duration-500">
              <div className="bg-white dark:bg-slate-800 p-8 rounded-full mb-6 shadow-sm">
                <Plane className="text-slate-200 dark:text-slate-600" size={40} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-2">準備好開始新的旅程了嗎？</h3>
              <p className="text-slate-400 dark:text-slate-500 max-w-xs mx-auto text-sm font-medium">
                點擊「開啟新旅程」按鈕，建立您的第一本旅遊記帳本。
              </p>
            </div>
          ) : (
            <div className="space-y-14 md:space-y-16">
              {groupedTrips.map(({ category, trips: groupTrips }) => {
                const isExpanded = !!expandedGroups[category];
                const visibleTrips = isExpanded ? groupTrips : groupTrips.slice(0, TRIPS_PER_GROUP);
                const hiddenCount = groupTrips.length - visibleTrips.length;
                return (
                  <section
                    key={category}
                    id={categorySlug(category)}
                    ref={el => { groupRefs.current[category] = el; }}
                    className="scroll-mt-24"
                  >
                    <div className="flex items-end justify-between mb-6 px-1">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${category === UNCATEGORIZED ? 'bg-slate-100 text-slate-400 dark:bg-slate-800' : 'bg-blue-50 text-blue-600 dark:bg-blue-900/20'}`}>
                          {category === UNCATEGORIZED ? <FolderOpen size={16} /> : <Tag size={16} />}
                        </div>
                        <div>
                          <h2 className="text-lg md:text-xl font-black text-slate-800 dark:text-white">{category}</h2>
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{groupTrips.length} trips</span>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {visibleTrips.map(trip => (
                        <TripCard key={trip.id} trip={trip} onClick={() => navigate(`/trip/${trip.id}`)} />
                      ))}
                    </div>
                    {groupTrips.length > TRIPS_PER_GROUP && (
                      <div className="mt-5 flex justify-center">
                        <button
                          onClick={() => setExpandedGroups(prev => ({ ...prev, [category]: !isExpanded }))}
                          className="text-xs font-black text-blue-600 hover:text-blue-700 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-blue-300 px-5 py-2.5 rounded-full transition-all shadow-sm tracking-widest uppercase"
                        >
                          {isExpanded ? '收合' : `看全部 ${hiddenCount} 個`}
                        </button>
                      </div>
                    )}
                  </section>
                );
              })}

              {archivedTrips.length > 0 && (
                <section id="archived" className="scroll-mt-24">
                  <button
                    onClick={() => setShowArchived(v => !v)}
                    className="w-full flex items-center gap-3 px-1 py-2 group"
                  >
                    <div className="p-2 rounded-lg bg-slate-100 text-slate-400 dark:bg-slate-800">
                      <Archive size={16} />
                    </div>
                    <div className="text-left">
                      <h2 className="text-lg md:text-xl font-black text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200 transition-colors">
                        已封存
                      </h2>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        {archivedTrips.length} trips
                      </span>
                    </div>
                    <ChevronDown
                      size={20}
                      className={`ml-auto text-slate-400 transition-transform duration-300 ${showArchived ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {showArchived && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-6 animate-in fade-in slide-in-from-top-2 duration-300">
                      {archivedTrips.map(trip => (
                        <TripCard key={trip.id} trip={trip} onClick={() => navigate(`/trip/${trip.id}`)} />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </main>

      {/* 新增旅程 Modal */}
      <Modal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        title="開啟新的冒險"
      >
        <form onSubmit={handleCreateTrip} className="space-y-6 py-2 px-1">
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
              旅程名稱
            </label>
            <input
              required
              type="text"
              placeholder="例如：2024 東京賞櫻之旅"
              className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 dark:text-white outline-none transition-all font-bold text-sm shadow-sm"
              value={newTrip.name}
              onChange={e => setNewTrip({ ...newTrip, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
              參與人員 <span className="text-[9px] font-normal opacity-60 ml-2">(以半形逗號隔開)</span>
            </label>
            <input
              required
              type="text"
              placeholder="例如：小明, 小華, 大強"
              className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 dark:text-white outline-none transition-all font-bold text-sm shadow-sm"
              value={newTrip.members}
              onChange={e => setNewTrip({ ...newTrip, members: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
              旅程分類 <span className="text-[9px] font-normal opacity-60 ml-2">(選填，可自由輸入)</span>
            </label>
            <input
              type="text"
              list="home-trip-categories"
              placeholder="例如：家族、朋友、情侶、出差"
              className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 dark:text-white outline-none transition-all font-bold text-sm shadow-sm"
              value={newTrip.category}
              onChange={e => setNewTrip({ ...newTrip, category: e.target.value })}
            />
            <datalist id="home-trip-categories">
              {knownCategories.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
                主幣別
              </label>
              <select
                className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 dark:text-white outline-none transition-all font-bold text-sm appearance-none shadow-sm"
                value={newTrip.base_currency}
                onChange={e => setNewTrip({ ...newTrip, base_currency: e.target.value })}
              >
                <option value="TWD">TWD (新台幣)</option>
                <option value="JPY">JPY (日圓)</option>
                <option value="USD">USD (美金)</option>
                <option value="EUR">EUR (歐元)</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
                訪問密碼 <span className="text-[9px] font-normal opacity-60 ml-2">(選填)</span>
              </label>
              <div className="relative">
                {newTrip.access_code.trim()
                  ? <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                  : <Unlock className="absolute left-4 top-1/2 -translate-y-1/2 text-emerald-500" size={14} />}
                <input
                  type="password"
                  maxLength={6}
                  placeholder="留空 = 免密碼"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 dark:text-white outline-none transition-all font-bold text-sm shadow-sm"
                  value={newTrip.access_code}
                  onChange={e => setNewTrip({ ...newTrip, access_code: e.target.value })}
                />
              </div>
            </div>
          </div>
          <p className="text-[10px] text-slate-400 font-medium px-1 -mt-2">
            {newTrip.access_code.trim()
              ? '進入此旅程時需要輸入密碼。'
              : '未設定密碼：任何拿到連結的人都可以直接進入此旅程，LINE Bot 綁定時也免驗證。'}
          </p>
          <button
            disabled={submitting}
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-bold py-4 rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 mt-4 active:scale-95"
          >
            {submitting ? <Loader2 className="animate-spin" size={20} /> : <PlusCircle size={20} />}
            <span className="text-base">{submitting ? '同步中...' : '開始冒險之旅'}</span>
          </button>
        </form>
      </Modal>
    </div>
  );
};

export default Home;
