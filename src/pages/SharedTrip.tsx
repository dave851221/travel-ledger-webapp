import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Eye, Loader2, Lock } from 'lucide-react';
import { supabase } from '../api/supabase';
import { ui } from '../components/ui';
import BrandMark from '../components/BrandMark';
import ExpenseDetailModal from '../components/ExpenseDetailModal';
import type { Expense, Trip } from '../types';
import { PRODUCT_NAME } from '../config/mode';
import { useTripStats } from '../hooks/useTripStats';
import { formatTripDates } from '../utils/tripDates';
import { primePhotoUrls, setPhotoShareAccess, usePhotoUrlVersion } from '../utils/signedPhotos';
import { hasItinerary } from '../features/itinerary/registry';
import { TAB_ALBUM, TAB_ITINERARY, TAB_LEDGER, TAB_SETTLEMENT, TAB_STATS, type TabDef, type TabType } from '../features/dashboard/tabs';
import BottomNav from '../features/dashboard/BottomNav';
import LedgerTab from '../features/dashboard/LedgerTab';
import SettlementTab from '../features/dashboard/SettlementTab';
import AlbumTab from '../features/dashboard/AlbumTab';
import { MemberBalances } from '../features/dashboard/SummaryPanel';
import { MemberColorProvider } from '../features/dashboard/MemberAvatar';

const StatsTab = lazy(() => import('../features/dashboard/StatsTab'));
const TripItinerary = lazy(() => import('../features/itinerary/TripItinerary'));

type Snapshot = { trip: Trip; expenses: Expense[] };

const noop = () => {};
const TabLoading = () => <div className="flex justify-center py-20 text-muted"><Loader2 className="animate-spin" size={22} /></div>;

/**
 * 開放版的分享頁：#/s/{tripId}/{shareToken}，給沒登入的人「只看不改」。
 * David 2026-11-28：跟成員看到的一樣有帳目、統計、結清、行程、相簿，只是不能新增、編輯、刪除。
 *
 * 資料只從 app.get_trip_snapshot 來（資料庫檢查分享設定、連結與密碼），不碰任何需要登入的查詢。
 * 照片與試算表行程：Edge Function（tlb-photos 的 sign_shared、tlb-itinerary）用同一組分享連結與密碼再驗一次。
 * 各分頁沿用成員頁的元件，旅程一律當成「已封存」傳進去 —— 那些元件在封存時本來就把新增、編輯、刪除藏起來。
 */
const SharedTrip: React.FC = () => {
  const { id, token } = useParams<{ id: string; token: string }>();
  const [state, setState] = useState<'loading' | 'ready' | 'password' | 'invalid'>(() => (id && token ? 'loading' : 'invalid'));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [password, setPassword] = useState('');
  const [acceptedPassword, setAcceptedPassword] = useState<string | null>(null);
  const [wrongPassword, setWrongPassword] = useState(false);
  const [checking, setChecking] = useState(false);
  const [tab, setTab] = useState<TabType>('ledger');
  const [detail, setDetail] = useState<Expense | null>(null);
  usePhotoUrlVersion();

  const accept = (data: Snapshot, pw: string | null) => {
    if (id && token) {
      setPhotoShareAccess({ tripId: id, token, password: pw });
      primePhotoUrls(data.expenses.flatMap(e => e.photo_urls || []));
    }
    setAcceptedPassword(pw);
    setSnapshot(data);
    setState('ready');
  };

  const load = async (pw: string | null) => {
    if (!id || !token) return;
    const { data, error } = await supabase.rpc('get_trip_snapshot', { p_trip_id: id, p_token: token, p_password: pw });
    if (error) {
      if (error.message.includes('wrong_password')) {
        setWrongPassword(pw !== null);
        setState('password');
      } else {
        setState('invalid');
      }
      return;
    }
    accept(data as Snapshot, pw);
  };

  useEffect(() => {
    if (!id || !token) return;
    let alive = true;
    supabase.rpc('get_trip_snapshot', { p_trip_id: id, p_token: token, p_password: null }).then(({ data, error }) => {
      if (!alive) return;
      if (error) { setState(error.message.includes('wrong_password') ? 'password' : 'invalid'); return; }
      accept(data as Snapshot, null);
    });
    return () => { alive = false; setPhotoShareAccess(null); };
    // accept 只用到 id、token（已在相依裡）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token]);

  useEffect(() => {
    if (snapshot) document.title = `${snapshot.trip.name} · ${PRODUCT_NAME}`;
  }, [snapshot]);

  // 各分頁的元件看到「已封存」就只能看
  const viewTrip = useMemo<Trip | null>(() => (snapshot ? { ...snapshot.trip, is_archived: true } : null), [snapshot]);
  const expenses = useMemo(() => snapshot?.expenses ?? [], [snapshot]);
  const stats = useTripStats(expenses, viewTrip, null);

  const tabs = useMemo<TabDef[]>(() => {
    const hasPlan = !!snapshot && (hasItinerary(snapshot.trip.id) || !!snapshot.trip.itinerary_sheet);
    return hasPlan ? [TAB_LEDGER, TAB_STATS, TAB_SETTLEMENT, TAB_ITINERARY, TAB_ALBUM] : [TAB_LEDGER, TAB_STATS, TAB_SETTLEMENT, TAB_ALBUM];
  }, [snapshot]);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setChecking(true);
    await load(password);
    setChecking(false);
  };

  if (state !== 'ready' || !snapshot || !viewTrip) {
    return (
      <div className="min-h-screen bg-canvas text-ink">
        <main className="w-full max-w-2xl mx-auto px-4 pt-[max(16px,env(safe-area-inset-top))] pb-10">
          <header className="flex items-center gap-3 py-4">
            <BrandMark />
            <span className="text-lg font-bold">{PRODUCT_NAME}</span>
          </header>
          {state === 'loading' && <TabLoading />}
          {state === 'invalid' && (
            <div className={`${ui.card} px-6 py-10 text-center`}>
              <AlertCircle className="mx-auto text-neg mb-3" size={28} />
              <h1 className="text-lg font-bold">這個分享連結無法使用</h1>
              <p className="text-sm text-muted mt-1.5">可能已經關閉分享或重新產生了連結，請向旅程成員要新的連結。</p>
            </div>
          )}
          {state === 'password' && (
            <form onSubmit={submitPassword} className={`${ui.card} px-6 py-8 max-w-sm mx-auto space-y-3`}>
              <Lock className="mx-auto text-muted" size={26} />
              <h1 className="text-lg font-bold text-center">這趟旅程需要密碼</h1>
              <input
                type="password"
                autoComplete="current-password"
                aria-label="密碼"
                className={ui.input}
                value={password}
                onChange={e => { setPassword(e.target.value); setWrongPassword(false); }}
              />
              {wrongPassword && <p className="text-sm text-neg">密碼不對，再試一次</p>}
              <button type="submit" disabled={!password || checking} className={`${ui.btnPrimary} w-full`}>
                {checking && <Loader2 className="animate-spin" size={16} />}查看
              </button>
            </form>
          )}
        </main>
      </div>
    );
  }

  const trip = snapshot.trip;
  const dates = formatTripDates(trip);
  const share = token ? { token, password: acceptedPassword } : undefined;

  return (
    <MemberColorProvider members={trip.members}>
      <div className="min-h-screen bg-canvas text-ink">
        <main className="w-full max-w-5xl mx-auto px-4 sm:px-6 pt-[max(12px,env(safe-area-inset-top))] pb-28 md:pb-12">
          <header className="flex items-center gap-2.5 py-3">
            <BrandMark size={30} />
            <span className="font-bold">{PRODUCT_NAME}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-sunk px-3 py-1 text-xs text-ink-2">
              <Eye size={13} />分享檢視・只能看
            </span>
          </header>

          <div className="mt-2 mb-4">
            <h1 className="text-2xl font-bold leading-snug">{trip.name}</h1>
            <p className="text-sm text-muted mt-1 num">
              {[trip.category?.trim(), dates, `${trip.members.length} 人`, trip.base_currency].filter(Boolean).join(' · ')}
            </p>
          </div>

          {/* 電腦、平板：分頁列在上面；手機用底部導覽 */}
          <nav className="hidden md:flex gap-1.5 mb-5 border-b border-line" aria-label="分頁">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                aria-current={tab === key ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 -mb-px text-sm border-b-2 transition-colors ${
                  tab === key ? 'border-accent text-ink font-bold' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                <Icon size={16} />{label}
              </button>
            ))}
          </nav>

          <div hidden={tab !== 'ledger'}>
            <LedgerTab
              trip={viewTrip}
              expenses={expenses}
              currentUser={null}
              trashCount={0}
              onOpenExpense={setDetail}
              onEditExpense={noop}
              onDeleteExpense={noop}
              onQuickSaved={noop}
              onOpenQuickInForm={noop}
              onOpenTrash={noop}
              showToast={noop}
              summary={<div className={`${ui.card} p-4 mb-4`}><MemberBalances trip={viewTrip} stats={stats} currentUser={null} /></div>}
            />
          </div>

          {tab === 'stats' && (
            <Suspense fallback={<TabLoading />}>
              <StatsTab trip={viewTrip} expenses={expenses} stats={stats} currentUser={null} onOpenExpense={setDetail} />
            </Suspense>
          )}

          {tab === 'settlement' && (
            <SettlementTab
              trip={viewTrip}
              expenses={expenses}
              stats={stats}
              currentUser={null}
              onRecord={noop}
              onManual={noop}
              onEdit={noop}
              onDelete={noop}
            />
          )}

          {tab === 'itinerary' && (
            <Suspense fallback={<TabLoading />}>
              <TripItinerary trip={viewTrip} canManage={false} onChanged={noop} share={share} />
            </Suspense>
          )}

          {tab === 'album' && <AlbumTab trip={viewTrip} expenses={expenses} onOpenExpense={setDetail} />}
        </main>

        <BottomNav tabs={tabs} active={tab} onChange={setTab} />

        {detail && <ExpenseDetailModal expense={detail} trip={viewTrip} currentUser={null} onClose={() => setDetail(null)} />}
      </div>
    </MemberColorProvider>
  );
};

export default SharedTrip;
