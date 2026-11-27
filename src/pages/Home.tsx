import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Lock, Unlock, Loader2, AlertCircle, ChevronDown, Plane, ArrowDownUp, RotateCcw, GripVertical, Check, X, UserRound } from 'lucide-react';
import { supabase, TRIP_COLUMNS } from '../api/supabase';
import type { Trip } from '../types';
import Modal from '../components/Modal';
import BrandMark from '../components/BrandMark';
import MascotArt from '../components/MascotArt';
import Toast from '../components/Toast';
import { ui } from '../components/ui';
import { useNavigate, useLocation } from 'react-router-dom';
import { getCurrencyPrecision } from '../utils/finance';
import { CURRENCIES, normalizeCurrencyCode } from '../utils/currencies';
import { isSubmitEnter } from '../utils/keyboard';
import { globalStorageKey, IS_PUBLIC, PRODUCT_NAME } from '../config/mode';
import { peekReturnTo, signOut, useSession } from '../features/auth/session';
import SignInPanel from '../features/auth/SignInPanel';
import AccountModal from '../features/auth/AccountModal';
import { useToast } from '../hooks/useToast';
import { useBackClose } from '../hooks/useBackClose';
import { applyLayout, pickFeatured, defaultGroups, layoutFromGroups, sameOrder, UNCATEGORIZED, type HomeLayout, type TripGroup } from '../features/home/homeLayout';
import { fetchLayout, readCachedLayout, saveLayout } from '../features/home/homeLayoutStore';
import { FeaturedTrip, TripRow } from '../features/home/TripCards';
import SortEditor from '../features/home/SortEditor';
import TripDatesField from '../components/TripDatesField';
import { normalizeTripDates } from '../utils/tripDates';
import { getLocalDateString } from '../utils/date';

const TRIPS_PER_GROUP = 3;
const APP_NAME = PRODUCT_NAME;
const DEFAULT_CATEGORIES = ['餐飲', '交通', '住宿', '購物', '景點', '其他'];
// 開放版：建立旅程時就能調整，預設帶 emoji（圖示與顏色仍依關鍵字對應，見 utils/category.ts）
const PUBLIC_DEFAULT_CATEGORIES = ['🍜 餐飲', '🚃 交通', '🏨 住宿', '🛍️ 購物', '🎡 景點', '🎁 伴手禮', '📦 其他'];
const OTHER_CURRENCY = '__other__';

const EMPTY_NEW_TRIP = {
  name: '',
  members: '',
  access_code: '',
  base_currency: 'TWD',
  category: '',
  // 旅程日期（選填）
  start_date: '',
  end_date: '',
};

const categorySlug = (name: string) => `cat-${encodeURIComponent(name)}`;

/**
 * 首頁旅程清單的本機快取（只有 TRIP_COLUMNS，不含通行碼）。
 * 打開首頁先畫這份，同一支查詢照舊在背景跑一次，不多打任何請求。
 */
const TRIPS_CACHE_KEY = globalStorageKey('trips_list_cache');
const readTripsCache = (): Trip[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRIPS_CACHE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const writeTripsCache = (list: Trip[]) => {
  try { localStorage.setItem(TRIPS_CACHE_KEY, JSON.stringify(list)); } catch { /* 空間不足：只是少了快取 */ }
};

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  // 先畫上次存在手機上的清單，再到背景更新：國外網路慢時不必盯著骨架等
  // 開放版不在一開始讀快取：那時還不知道是誰登入，快取可能是上一個人的（等登入狀態確定、
  // ensureCacheOwner 清過之後才讀，見下面的 effect）
  const [trips, setTrips] = useState<Trip[]>(() => (IS_PUBLIC ? [] : readTripsCache()));
  const [loading, setLoading] = useState(() => IS_PUBLIC || readTripsCache().length === 0);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const groupRefs = useRef<Record<string, HTMLElement | null>>({});
  const { toast, showToast, dismissToast } = useToast();

  // 自訂排序：先照這台裝置的快取畫，背景再讀最新的（舊版一列 home_layout、開放版帳號的 user_metadata）
  const [layout, setLayout] = useState<HomeLayout | null>(() => (IS_PUBLIC ? null : readCachedLayout()));
  // 排序模式的草稿（null = 沒在排序）。按「完成」才存一次
  const [sortDraft, setSortDraft] = useState<TripGroup[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const [newTrip, setNewTrip] = useState(EMPTY_NEW_TRIP);
  // 開放版：記帳分類（建立時可增減）與自訂主幣別（null = 用選單上的）
  const [newCategories, setNewCategories] = useState<string[]>(PUBLIC_DEFAULT_CATEGORIES);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [customCurrency, setCustomCurrency] = useState<string | null>(null);
  const addNewCategory = () => {
    const cat = newCategoryInput.trim();
    if (cat && !newCategories.includes(cat)) setNewCategories([...newCategories, cat]);
    setNewCategoryInput('');
  };
  const [submitting, setSubmitting] = useState(false);
  // 建立旅程的錯誤顯示在表單裡；專案禁用原生 alert()
  const [createError, setCreateError] = useState<string | null>(null);
  // 開放版：沒付過費的帳號最多建立幾趟（資料庫 my_trip_allowance；算現在還留著的，加入別人的不算）
  const [allowance, setAllowance] = useState<{ paid: boolean; created: number; limit: number } | null>(null);
  useEffect(() => {
    if (!IS_PUBLIC || !isModalOpen || !supabase) return;
    let alive = true;
    supabase.rpc('my_trip_allowance').then(({ data }) => { if (alive && data) setAllowance(data); });
    return () => { alive = false; };
  }, [isModalOpen]);
  const tripsLeft = allowance && !allowance.paid ? Math.max(0, allowance.limit - allowance.created) : null;

  // 開放版：要登入才有「我的旅程」。舊版沒有登入，session 永遠是 null、也不會等
  const { session, loading: sessionLoading } = useSession();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    document.title = APP_NAME;
    // 開放版沒登入時不查（RLS 也只會回空的）；換帳號登入時重查
    if (IS_PUBLIC && !userId) return;
    if (IS_PUBLIC) showCachedTrips();
    fetchTrips();
    if (!IS_PUBLIC) void fetchLayout().then(l => { if (l !== undefined) setLayout(l); });
  }, [userId]);

  // 開放版：順序存在帳號的 user_metadata，登入狀態一來就有
  const userMetadata = session?.user.user_metadata;
  useEffect(() => {
    if (!IS_PUBLIC || !userId) return;
    setLayout(readCachedLayout());
    void fetchLayout(userMetadata).then(l => { if (l !== undefined) setLayout(l); });
  }, [userId, userMetadata]);

  // 開放版：登入狀態確定後（快取已經確認是這個人的）先畫快取
  function showCachedTrips() {
    const cached = readTripsCache();
    setTrips(cached);
    setLoading(cached.length === 0);
  }

  const [accountOpen, setAccountOpen] = useState(false);
  const handleSignOut = async () => {
    // 快取由 ensureCacheOwner 在登出時整批清掉（session.ts），這裡只清畫面
    setAccountOpen(false);
    setTrips([]);
    await signOut();
  };

  const fetchTrips = async () => {
    if (!supabase) return;
    try {
      // 手上已經有清單（快取）就不換回骨架，畫面保持可點
      setLoading(prev => prev && readTripsCache().length === 0);
      setError(null);
      const { data, error } = await supabase
        .from('trips')
        .select(TRIP_COLUMNS)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTrips(data || []);
      writeTripsCache(data || []);
    } catch (err) {
      console.error('Error fetching trips:', err);
      // 已經畫出快取的清單時不蓋上錯誤：離線或網路慢時照樣能點進旅程
      if (readTripsCache().length === 0) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // 正在進行的旅程優先，否則是日期最新的一趟（沒填日期用建立時間），見 pickFeatured
  const featuredTrip = useMemo(() => pickFeatured(trips, getLocalDateString()), [trips]);

  // 分組與排序規則在 features/home/homeLayout.ts：沒有自訂順序時，分組依最近一趟進行中的旅程排，
  // 組內進行中的在前；有自訂順序就照存下來的，之後才出現的旅程放最上面
  const groupedTrips = useMemo(() => applyLayout(trips, layout), [trips, layout]);

  const startSorting = () => {
    setSortDraft(groupedTrips);
    window.scrollTo({ top: 0 });
  };
  const cancelSorting = () => setSortDraft(null);
  useBackClose(sortDraft !== null, cancelSorting);

  const finishSorting = async () => {
    if (!sortDraft) return;
    if (sameOrder(sortDraft, groupedTrips)) { setSortDraft(null); return; }
    // 跟預設排法一樣就清掉自訂順序：之後新建的旅程照預設規則排
    const next = sameOrder(sortDraft, defaultGroups(trips)) ? null : layoutFromGroups(sortDraft);
    setSavingOrder(true);
    const synced = await saveLayout(next);
    setSavingOrder(false);
    setLayout(next);
    setSortDraft(null);
    showToast(synced ? '已儲存排序' : '排序只存在這台裝置（沒有連上伺服器）', synced ? 'success' : 'error');
  };

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
    const dates = normalizeTripDates(newTrip.start_date, newTrip.end_date);
    if ('error' in dates) { setCreateError(dates.error); return; }
    // 主幣別：選單上的，或「其他」自己輸入的 3 碼代碼
    const baseCurrency = customCurrency !== null ? normalizeCurrencyCode(customCurrency) : newTrip.base_currency;
    if (!baseCurrency) { setCreateError('主幣別請輸入 3 碼英文代碼，例如 CZK'); return; }

    if (IS_PUBLIC) {
      if (newCategories.length === 0) { setCreateError('請至少留一個記帳分類'); return; }
      // 開放版：trips 沒有 INSERT 權限，一律走 app.create_trip（建立者成為 owner 並加入）。
      // 建立時不問「你是哪一位」（David 2026-11-27）：先掛在第一位成員，進旅程後馬上請他選（Dashboard 的 ?who=1）
      const myName = membersArray[0];
      try {
        setSubmitting(true);
        const { data: newId, error } = await supabase.rpc('create_trip', {
          p_name: tripName,
          p_members: membersArray,
          p_my_name: myName,
          p_base_currency: baseCurrency,
          p_categories: newCategories,
          p_category: newTrip.category.trim() || null,
          // 精度與舊版建立時一致，跟建立一起寫進去
          p_precision_config: { [baseCurrency]: getCurrencyPrecision(baseCurrency) },
          p_start_date: dates.start_date,
          p_end_date: dates.end_date,
        });
        if (error) throw error;
        setIsModalOpen(false);
        setNewTrip(EMPTY_NEW_TRIP);
        setNewCategories(PUBLIC_DEFAULT_CATEGORIES);
        setCustomCurrency(null);
        navigate(membersArray.length > 1 ? `/trip/${newId}/dashboard?who=1` : `/trip/${newId}/dashboard`);
      } catch (err) {
        // supabase 的錯誤不是 Error 的實例，但有 message
        const msg = (err as { message?: string } | null)?.message ?? String(err);
        setCreateError(msg.includes('invalid_name') ? '每位成員的名字要 1～20 個字'
          : msg.includes('too_many_members') ? '成員最多 150 位'
          : msg.includes('trips_name_check') ? '旅程名稱最多 60 個字'
          : msg.includes('trip_limit') ? '免費帳號的旅程已經到上限了，刪掉不用的旅程就能空出名額。'
          : '建立失敗，請再試一次');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    try {
      setSubmitting(true);
      const { data, error } = await supabase
        .from('trips')
        .insert([{
          name: tripName,
          members: membersArray,
          access_code: newTrip.access_code.trim() || null,
          base_currency: baseCurrency,
          category: newTrip.category.trim() || null,
          start_date: dates.start_date,
          end_date: dates.end_date,
          categories: DEFAULT_CATEGORIES,
          rates: { [baseCurrency]: 1 },
          // 以前只有 TWD 給 0 位，JPY 主幣的旅程會顯示成 ¥1,000.00、分帳拆出 333.33
          precision_config: { [baseCurrency]: getCurrencyPrecision(baseCurrency) }
        }])
        .select(TRIP_COLUMNS);

      if (error) throw error;

      setTrips([data[0], ...trips]);
      setIsModalOpen(false);
      setNewTrip(EMPTY_NEW_TRIP);
      setCustomCurrency(null);
    } catch (err) {
      setCreateError('建立失敗：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  };

  // 分類目錄：展開那一組並捲過去
  const jumpToGroup = (category: string) => {
    setExpandedGroups(prev => ({ ...prev, [category]: true }));
    requestAnimationFrame(() => groupRefs.current[category]?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  // 開放版沒有通行碼頁，直接進 Dashboard
  const openTrip = (trip: Trip) => navigate(IS_PUBLIC ? `/trip/${trip.id}/dashboard` : `/trip/${trip.id}`);

  if (IS_PUBLIC && !session) {
    return (
      <div className="min-h-screen bg-canvas text-ink">
        <main className="w-full max-w-5xl mx-auto px-4 sm:px-8 pt-[max(16px,env(safe-area-inset-top))] pb-10">
          <header className="flex items-center gap-3 py-3 sm:py-6">
            <BrandMark />
            <span className="text-lg sm:text-xl font-bold">{APP_NAME}</span>
          </header>
          {sessionLoading ? (
            <div className="flex justify-center py-20 text-muted"><Loader2 className="animate-spin" size={24} /></div>
          ) : (
            <div className="mt-6 sm:mt-10 space-y-6">
              <div className="text-center px-2">
                <MascotArt slot="signinHero" width={220} className="mx-auto mb-2" />
                <h1 className="text-2xl font-bold text-balance">在 LINE 群組裡拍收據，帳就分好了</h1>
                <p className="text-sm text-muted mt-2">一起出去玩的旅伴都能記帳，回來還有一支回顧影片。</p>
              </div>
              <SignInPanel returnTo={peekReturnTo() ?? '/'} />
            </div>
          )}
        </main>
      </div>
    );
  }

  // 排序模式：頂端固定一條操作列，下面是可以拖曳的分組（展開一組再排組內的旅程）
  if (sortDraft) {
    const isDefault = sameOrder(sortDraft, defaultGroups(trips));
    return (
      <div className="min-h-screen bg-canvas text-ink">
        <div className="sticky top-offset z-20 bg-canvas/95 backdrop-blur border-b border-line">
          <div className="max-w-2xl mx-auto px-4 sm:px-8 pt-[max(12px,env(safe-area-inset-top))] pb-3 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="text-base sm:text-lg font-bold">調整順序</h1>
              <p className="text-xs text-muted text-pretty">
                按住 <GripVertical size={12} className="inline -mt-0.5" /> 拖曳，或用箭頭移動{IS_PUBLIC ? '' : '・大家看到的順序會一起改'}
              </p>
            </div>
            <button onClick={cancelSorting} disabled={savingOrder} className={`${ui.btnSecondary} px-3`}>取消</button>
            <button onClick={finishSorting} disabled={savingOrder} className={`${ui.btnPrimary} px-3.5`}>
              {savingOrder ? <Loader2 className="animate-spin" size={15} /> : <Check size={15} strokeWidth={2.6} />}完成
            </button>
          </div>
        </div>
        <main className="max-w-2xl mx-auto px-4 sm:px-8 pt-4 pb-16">
          <SortEditor groups={sortDraft} onChange={setSortDraft} />
          <div className="mt-5 flex justify-center">
            <button
              onClick={() => setSortDraft(defaultGroups(trips))}
              disabled={savingOrder || isDefault}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2 hover:text-ink px-3 py-2 rounded-xl hover:bg-sunk disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <RotateCcw size={13} />還原成預設順序（依建立時間）
            </button>
          </div>
        </main>
      </div>
    );
  }

  const showGroupNav = groupedTrips.length >= 2;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <main className="w-full max-w-5xl mx-auto px-4 sm:px-8 pt-[max(16px,env(safe-area-inset-top))] pb-10">
        <header className="flex items-center gap-2 sm:gap-3 py-3 sm:py-6">
          <BrandMark />
          <span className="text-lg sm:text-xl font-bold truncate">{APP_NAME}</span>
          <div className="ml-auto flex items-center gap-2">
            {trips.length > 1 && !loading && (
              <button onClick={startSorting} className={`${ui.btnSecondary} h-10 py-0 px-3`} aria-label="調整旅程順序" title="調整旅程順序">
                <ArrowDownUp size={15} /><span className="hidden sm:inline">排序</span>
              </button>
            )}
            <button onClick={() => setIsModalOpen(true)} className={`${ui.btnPrimary} h-10 py-0`}>
              <Plus size={16} strokeWidth={2.6} />新旅程
            </button>
            {IS_PUBLIC && (
              <button onClick={() => setAccountOpen(true)} className={`${ui.btnSecondary} h-10 py-0 px-3`} aria-label="我的帳號" title="我的帳號（登入方式、登出）">
                <UserRound size={15} /><span className="hidden sm:inline">帳號</span>
              </button>
            )}
          </div>
        </header>
        {IS_PUBLIC && <AccountModal isOpen={accountOpen} onClose={() => setAccountOpen(false)} onSignOut={handleSignOut} />}

        {error && (
          <div className={`${ui.errorBox} mb-6`}>
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0">無法載入旅程：{error}</span>
            <button onClick={fetchTrips} className="shrink-0 font-bold underline">重新載入</button>
          </div>
        )}

        {loading ? (
          <div className="space-y-4 mt-4" aria-label="載入中">
            <div className="h-40 rounded-2xl bg-surface border border-line animate-pulse" />
            <div className="h-48 rounded-2xl bg-surface border border-line animate-pulse" />
          </div>
        ) : trips.length === 0 ? (
          <div className={`${ui.card} mt-4 px-6 py-14 text-center`}>
            <MascotArt slot="emptyTrips" width={180} className="mx-auto mb-3" fallback={
              <span className="inline-flex w-14 h-14 rounded-2xl bg-sunk text-muted items-center justify-center mb-4">
                <Plane size={26} />
              </span>
            } />
            <h2 className="text-lg font-bold">還沒有任何旅程</h2>
            <p className="text-sm text-muted mt-1.5 mb-6">建立一趟旅程，邀請旅伴一起記帳。</p>
            <button onClick={() => setIsModalOpen(true)} className={ui.btnPrimary}>
              <Plus size={16} strokeWidth={2.6} />建立第一趟旅程
            </button>
          </div>
        ) : (
          <div className="mt-1 sm:mt-0 space-y-7 sm:space-y-9">
            {(featuredTrip || showGroupNav) && (
              <section className={`grid gap-x-6 gap-y-4 ${featuredTrip && showGroupNav ? 'lg:grid-cols-5' : ''}`}>
                {featuredTrip && (
                  <div className={`min-w-0 flex flex-col ${showGroupNav ? 'lg:col-span-3' : 'md:max-w-xl'}`}>
                    <h2 className="text-sm font-bold text-ink mb-2.5 px-1">最近的旅程</h2>
                    <div className="flex-1"><FeaturedTrip trip={featuredTrip} onClick={() => openTrip(featuredTrip)} /></div>
                  </div>
                )}
                {showGroupNav && (
                  <nav aria-label="旅程分類" className={`min-w-0 flex flex-col ${featuredTrip ? 'lg:col-span-2' : ''}`}>
                    <h2 className="text-sm font-bold text-ink mb-2.5 px-1 hidden lg:block">分類</h2>
                    {/* 手機：一排可以左右滑的分類；電腦：登機證旁邊的分類目錄 */}
                    <div className="flex lg:flex-col gap-2 lg:gap-0.5 overflow-x-auto lg:overflow-visible no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0 lg:flex-1 lg:bg-surface lg:border lg:border-line lg:rounded-2xl lg:p-1.5">
                      {groupedTrips.map(({ category, trips: groupTrips }) => {
                        const active = groupTrips.filter(t => !t.is_archived).length;
                        return (
                          <button
                            key={category}
                            onClick={() => jumpToGroup(category)}
                            className="shrink-0 inline-flex items-center gap-2 rounded-full lg:rounded-xl bg-surface lg:bg-transparent border border-line lg:border-0 px-3.5 py-2 lg:px-3 lg:py-2.5 text-sm hover:bg-sunk transition-colors text-left"
                          >
                            <span className={`truncate lg:flex-1 ${category === UNCATEGORIZED ? 'text-ink-2' : 'font-medium text-ink'}`}>{category}</span>
                            {active > 0 && <span className="w-1.5 h-1.5 rounded-full bg-accent" title={`${active} 趟進行中`} />}
                            <span className="num text-xs text-muted">{groupTrips.length}</span>
                          </button>
                        );
                      })}
                    </div>
                  </nav>
                )}
              </section>
            )}

            {/* 兩欄瀑布流：每組高度不同，用 grid 會在矮的那組下面留一塊空白 */}
            <div className="md:columns-2 md:gap-6">
              {groupedTrips.map(({ category, trips: groupTrips }) => {
                const isExpanded = !!expandedGroups[category];
                const visibleTrips = isExpanded ? groupTrips : groupTrips.slice(0, TRIPS_PER_GROUP);
                const hiddenCount = groupTrips.length - visibleTrips.length;
                const archivedCount = groupTrips.filter(t => t.is_archived).length;
                return (
                  <section
                    key={category}
                    id={categorySlug(category)}
                    ref={el => { groupRefs.current[category] = el; }}
                    className="scroll-mt-6 min-w-0 break-inside-avoid mb-7 md:mb-6"
                  >
                    <div className="flex items-baseline justify-between gap-3 mb-2.5 px-1">
                      <h2 className={`text-[15px] font-bold truncate ${category === UNCATEGORIZED ? 'text-ink-2' : 'text-ink'}`}>{category}</h2>
                      <span className="shrink-0 text-xs text-muted num">
                        {groupTrips.length} 趟{archivedCount > 0 && archivedCount < groupTrips.length ? `・${archivedCount} 已封存` : ''}
                      </span>
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

        {/* 開放版不放個人名字 */}
        <footer className="mt-10 text-center text-xs text-muted">{IS_PUBLIC ? PRODUCT_NAME : 'Made by 代杰'}</footer>
      </main>

      <Toast toast={toast} onDismiss={dismissToast} />

      {/* 新增旅程 Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setCreateError(null); }}
        title="建立新旅程"
        dirty={[newTrip.name, newTrip.members, newTrip.category, newTrip.access_code, newTrip.start_date, newTrip.end_date].some(v => v.trim() !== '')}
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
          <TripDatesField
            idPrefix="trip-dates"
            start={newTrip.start_date}
            end={newTrip.end_date}
            onChange={(start_date, end_date) => setNewTrip({ ...newTrip, start_date, end_date })}
          />
          {IS_PUBLIC && (
            <div>
              <p className={ui.label}>
                記帳分類 <span className="text-muted font-normal">· 之後也可以在旅程設定裡修改</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {newCategories.map(cat => (
                  <span key={cat} className="inline-flex items-center gap-1 rounded-full border border-line bg-sunk pl-3 pr-1 py-1 text-sm">
                    {cat}
                    <button
                      type="button"
                      aria-label={`移除分類 ${cat}`}
                      onClick={() => setNewCategories(newCategories.filter(c => c !== cat))}
                      className="w-5 h-5 rounded-full inline-flex items-center justify-center text-muted hover:text-neg"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                <input
                  type="text"
                  aria-label="新增分類"
                  maxLength={12}
                  placeholder="新增分類，例如 ☕ 咖啡"
                  className={ui.input}
                  value={newCategoryInput}
                  onChange={e => setNewCategoryInput(e.target.value)}
                  onKeyDown={e => { if (isSubmitEnter(e)) { e.preventDefault(); addNewCategory(); } }}
                />
                <button type="button" onClick={addNewCategory} className={`${ui.btnSecondary} shrink-0`}>新增</button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className={IS_PUBLIC ? 'col-span-2' : undefined}>
              <label htmlFor="trip-currency" className={ui.label}>主幣別</label>
              <select
                id="trip-currency"
                className={ui.select}
                value={customCurrency !== null ? OTHER_CURRENCY : newTrip.base_currency}
                onChange={e => {
                  if (e.target.value === OTHER_CURRENCY) { setCustomCurrency(''); return; }
                  setCustomCurrency(null);
                  setNewTrip({ ...newTrip, base_currency: e.target.value });
                }}
              >
                {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} {c.name}</option>)}
                <option value={OTHER_CURRENCY}>其他（自己輸入代碼）</option>
              </select>
              {customCurrency !== null && (
                <input
                  type="text"
                  aria-label="自訂主幣別代碼"
                  maxLength={3}
                  placeholder="3 碼英文代碼，例如 CZK"
                  className={`${ui.input} uppercase placeholder:normal-case mt-2`}
                  value={customCurrency}
                  onChange={e => setCustomCurrency(e.target.value)}
                />
              )}
            </div>
            {!IS_PUBLIC && <div>
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
                  autoComplete="new-password"
                  maxLength={6}
                  placeholder="留空即免密碼"
                  className={`${ui.input} pl-9`}
                  value={newTrip.access_code}
                  onChange={e => setNewTrip({ ...newTrip, access_code: e.target.value })}
                />
              </div>
            </div>}
          </div>
          <p className={ui.hint}>
            {IS_PUBLIC
              ? `建立後只有你看得到。到旅程設定可以拿邀請連結給旅伴，或開放分享給沒登入的人看。${
                  tripsLeft !== null ? `免費帳號還能建立 ${tripsLeft} 趟旅程（加入朋友的旅程不算）。` : ''}`
              : newTrip.access_code.trim()
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
