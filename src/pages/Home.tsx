import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Users, Lock, Unlock, Loader2, AlertCircle, ChevronRight, ChevronDown, Plane } from 'lucide-react';
import { supabase } from '../api/supabase';
import type { Trip } from '../types';
import Modal from '../components/Modal';
import BrandMark from '../components/BrandMark';
import { ui } from '../components/ui';
import { useNavigate, useLocation } from 'react-router-dom';

const UNCATEGORIZED = '未分類';
const TRIPS_PER_GROUP = 3;
const APP_NAME = '旅遊小本本';

const categorySlug = (name: string) => `cat-${encodeURIComponent(name)}`;

const currencyList = (trip: Trip) => Object.keys(trip.rates || {}).join(' · ');

const formatCreated = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

/** 最近一趟進行中的旅程，做成登機證樣式放在最上面 */
const FeaturedTrip: React.FC<{ trip: Trip; onClick: () => void }> = ({ trip, onClick }) => (
  <button
    onClick={onClick}
    className="group w-full text-left bg-navy text-navy-fg rounded-2xl overflow-hidden transition-transform active:scale-[.99] focus-visible:outline-2 focus-visible:outline-accent"
  >
    <div className="px-5 pt-5 pb-4 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-navy-sub">{trip.category?.trim() || '最近的旅程'}</p>
        <h2 className="text-xl sm:text-2xl font-bold leading-snug mt-1 text-balance">{trip.name}</h2>
      </div>
      <span className="shrink-0 w-10 h-10 rounded-xl bg-accent text-on-accent flex items-center justify-center transition-transform group-hover:translate-x-0.5">
        <ChevronRight size={20} strokeWidth={2.4} />
      </span>
    </div>
    <div className="perforation" style={{ ['--notch-bg' as string]: 'var(--app-bg)' }} />
    <div className="grid grid-cols-3 gap-2 px-5 pt-3.5 pb-4 text-xs text-navy-sub">
      <div>成員<b className="block num text-sm font-bold text-navy-fg mt-0.5">{trip.members.length} 人</b></div>
      <div className="min-w-0">幣別<b className="block num text-sm font-bold text-navy-fg mt-0.5 truncate">{currencyList(trip)}</b></div>
      <div>建立於<b className="block num text-sm font-bold text-navy-fg mt-0.5">{formatCreated(trip.created_at)}</b></div>
    </div>
  </button>
);

const TripRow: React.FC<{ trip: Trip; onClick: () => void }> = ({ trip, onClick }) => (
  <button
    onClick={onClick}
    className="w-full text-left flex items-center gap-3 px-4 py-3.5 hover:bg-sunk transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
  >
    <div className="min-w-0 flex-1">
      <p className="text-[15px] font-medium text-ink truncate">{trip.name}</p>
      <p className="text-xs text-muted mt-0.5 flex items-center gap-2">
        <span className="inline-flex items-center gap-1"><Users size={12} />{trip.members.length} 人</span>
        <span className="num">{currencyList(trip)}</span>
      </p>
    </div>
    {trip.is_archived ? (
      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-ink-2 bg-sunk border border-line rounded-md px-2 py-0.5">
        <Lock size={10} />已封存
      </span>
    ) : (
      <ChevronRight size={18} className="shrink-0 text-muted" />
    )}
  </button>
);

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});

  const [newTrip, setNewTrip] = useState({
    name: '',
    members: '',
    access_code: '',
    base_currency: 'TWD',
    category: ''
  });
  const [submitting, setSubmitting] = useState(false);
  // 建立旅程的錯誤顯示在表單裡；專案禁用原生 alert()
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    fetchTrips();
    document.title = APP_NAME;
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

  // trips 已依建立時間新到舊排序，第一筆沒封存的就是最近的旅程
  const featuredTrip = useMemo(() => trips.find(t => !t.is_archived) ?? null, [trips]);

  // 已封存的旅程和其他旅程一樣放在自己的分類裡（列上會標「已封存」）。
  // 同一組裡進行中的排前面，收合時先看到的是還在用的旅程。
  const groupedTrips = useMemo(() => {
    const buckets = new Map<string, Trip[]>();
    const ordered = [...trips.filter(t => !t.is_archived), ...trips.filter(t => t.is_archived)];
    ordered.forEach(t => {
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
  }, [trips]);

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
    if (!supabase) return;
    setCreateError(null);

    // 全形逗號與頓號也要認：中文輸入法打出來的多半是「，」「、」，
    // 以前只切半形逗號，「小明，小華」會變成一位叫「小明，小華」的成員
    const membersArray = [...new Set(
      newTrip.members.split(/[,，、]/).map(m => m.trim()).filter(Boolean)
    )];
    const tripName = newTrip.name.trim();
    // input 的 required 擋不住只打空白或逗號的情況，會建出沒有名字或沒有成員的旅程
    if (!tripName) { setCreateError('請輸入旅程名稱'); return; }
    if (membersArray.length === 0) { setCreateError('請至少輸入一位參與人員'); return; }

    try {
      setSubmitting(true);
      const { data, error } = await supabase
        .from('trips')
        .insert([{
          name: tripName,
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
      setCreateError('建立失敗：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  };

  const openTrip = (trip: Trip) => navigate(`/trip/${trip.id}`);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <main className="w-full max-w-5xl mx-auto px-4 sm:px-8 pt-[max(16px,env(safe-area-inset-top))] pb-10">
        <header className="flex items-center gap-3 py-3 sm:py-6">
          <BrandMark />
          <span className="text-lg sm:text-xl font-bold">{APP_NAME}</span>
          <button onClick={() => setIsModalOpen(true)} className={`${ui.btnPrimary} ml-auto`}>
            <Plus size={16} strokeWidth={2.6} />新旅程
          </button>
        </header>

        {error && (
          <div className={`${ui.errorBox} mb-6`}>
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <span>無法載入旅程：{error}</span>
          </div>
        )}

        {loading ? (
          <div className="space-y-4 mt-4" aria-label="載入中">
            <div className="h-40 rounded-2xl bg-surface border border-line animate-pulse" />
            <div className="h-48 rounded-2xl bg-surface border border-line animate-pulse" />
          </div>
        ) : trips.length === 0 ? (
          <div className={`${ui.card} mt-4 px-6 py-14 text-center`}>
            <span className="inline-flex w-14 h-14 rounded-2xl bg-sunk text-muted items-center justify-center mb-4">
              <Plane size={26} />
            </span>
            <h2 className="text-lg font-bold">還沒有任何旅程</h2>
            <p className="text-sm text-muted mt-1.5 mb-6">建立一趟旅程，邀請旅伴一起記帳。</p>
            <button onClick={() => setIsModalOpen(true)} className={ui.btnPrimary}>
              <Plus size={16} strokeWidth={2.6} />建立第一趟旅程
            </button>
          </div>
        ) : (
          <div className="mt-2 sm:mt-0 space-y-8">
            {featuredTrip && (
              <section>
                <h2 className="text-sm font-bold text-ink mb-2.5 px-1">最近的旅程</h2>
                <div className="md:max-w-xl">
                  <FeaturedTrip trip={featuredTrip} onClick={() => openTrip(featuredTrip)} />
                </div>
              </section>
            )}

            <div className="grid gap-x-6 gap-y-8 md:grid-cols-2 items-start">
              {groupedTrips.map(({ category, trips: groupTrips }) => {
                const isExpanded = !!expandedGroups[category];
                const visibleTrips = isExpanded ? groupTrips : groupTrips.slice(0, TRIPS_PER_GROUP);
                const hiddenCount = groupTrips.length - visibleTrips.length;
                return (
                  <section
                    key={category}
                    id={categorySlug(category)}
                    ref={el => { groupRefs.current[category] = el; }}
                    className="scroll-mt-6 min-w-0"
                  >
                    <div className="flex items-baseline justify-between mb-2.5 px-1">
                      <h2 className={`text-sm font-bold ${category === UNCATEGORIZED ? 'text-ink-2' : 'text-ink'}`}>{category}</h2>
                      <span className="text-xs text-muted num">{groupTrips.length} 趟</span>
                    </div>
                    <div className={`${ui.card} overflow-hidden divide-y divide-line`}>
                      {visibleTrips.map(trip => (
                        <TripRow key={trip.id} trip={trip} onClick={() => openTrip(trip)} />
                      ))}
                      {groupTrips.length > TRIPS_PER_GROUP && (
                        <button
                          onClick={() => setExpandedGroups(prev => ({ ...prev, [category]: !isExpanded }))}
                          className="w-full flex items-center justify-center gap-1 px-4 py-2.5 text-xs font-medium text-ink-2 hover:text-ink hover:bg-sunk transition-colors"
                        >
                          {isExpanded ? '收合' : `顯示其餘 ${hiddenCount} 趟`}
                          <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>

          </div>
        )}

        <footer className="mt-14 text-center text-xs text-muted">Made by 代杰</footer>
      </main>

      {/* 新增旅程 Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setCreateError(null); }}
        title="建立新旅程"
      >
        <form onSubmit={handleCreateTrip} className="space-y-4">
          <div>
            <label htmlFor="trip-name" className={ui.label}>旅程名稱</label>
            <input
              id="trip-name"
              required
              type="text"
              placeholder="例如：2027 東京賞櫻"
              className={ui.input}
              value={newTrip.name}
              onChange={e => setNewTrip({ ...newTrip, name: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="trip-members" className={ui.label}>
              參與人員 <span className="text-muted font-normal">· 以逗號或頓號隔開</span>
            </label>
            <input
              id="trip-members"
              required
              type="text"
              placeholder="例如：小明、小華、大強"
              className={ui.input}
              value={newTrip.members}
              onChange={e => setNewTrip({ ...newTrip, members: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="trip-category" className={ui.label}>
              旅程分類 <span className="text-muted font-normal">· 選填，首頁會依分類分組</span>
            </label>
            <input
              id="trip-category"
              type="text"
              list="home-trip-categories"
              placeholder="例如：家族、朋友、出差"
              className={ui.input}
              value={newTrip.category}
              onChange={e => setNewTrip({ ...newTrip, category: e.target.value })}
            />
            <datalist id="home-trip-categories">
              {knownCategories.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="trip-currency" className={ui.label}>主幣別</label>
              <select
                id="trip-currency"
                className={ui.select}
                value={newTrip.base_currency}
                onChange={e => setNewTrip({ ...newTrip, base_currency: e.target.value })}
              >
                <option value="TWD">TWD 新台幣</option>
                <option value="JPY">JPY 日圓</option>
                <option value="USD">USD 美金</option>
                <option value="EUR">EUR 歐元</option>
              </select>
            </div>
            <div>
              <label htmlFor="trip-code" className={ui.label}>
                進入密碼 <span className="text-muted font-normal">· 選填</span>
              </label>
              <div className="relative">
                {newTrip.access_code.trim()
                  ? <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" size={14} />
                  : <Unlock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-pos" size={14} />}
                <input
                  id="trip-code"
                  type="password"
                  maxLength={6}
                  placeholder="留空即免密碼"
                  className={`${ui.input} pl-9`}
                  value={newTrip.access_code}
                  onChange={e => setNewTrip({ ...newTrip, access_code: e.target.value })}
                />
              </div>
            </div>
          </div>
          <p className={ui.hint}>
            {newTrip.access_code.trim()
              ? '進入這趟旅程時需要輸入密碼。'
              : '沒有設定密碼：任何拿到連結的人都能直接進入，綁定 LINE 機器人時也不用驗證。'}
          </p>
          {createError && (
            <div className={ui.errorBox}>
              <AlertCircle size={16} className="shrink-0 mt-0.5" />{createError}
            </div>
          )}
          <button disabled={submitting} type="submit" className={`${ui.btnPrimary} w-full py-3.5 text-[15px]`}>
            {submitting ? <Loader2 className="animate-spin" size={18} /> : <Plus size={18} strokeWidth={2.6} />}
            {submitting ? '建立中…' : '建立旅程'}
          </button>
        </form>
      </Modal>
    </div>
  );
};

export default Home;
