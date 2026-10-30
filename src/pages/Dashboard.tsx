import React, { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, AlertTriangle, ArrowDown, ArrowRight, Check, HandCoins, Trash2 } from 'lucide-react';
import { supabase } from '../api/supabase';
import type { Expense } from '../types';
import { hasItinerary } from '../features/itinerary/registry';
import ExpenseModal from '../components/ExpenseModal';
import ExpenseDetailModal from '../components/ExpenseDetailModal';
import SettingsModal from '../components/SettingsModal';
import Modal from '../components/Modal';
import { ui } from '../components/ui';
import { getLocalDateString } from '../utils/date';
import { buildQuickAddDraft } from '../utils/quickAdd';
import { formatMoney } from '../utils/money';
import { useToast } from '../hooks/useToast';
import Toast from '../components/Toast';
import ConfirmDialog from '../components/ConfirmDialog';
import { useTripData } from '../hooks/useTripData';
import { useTripStats } from '../hooks/useTripStats';
import { useTrash } from '../hooks/useTrash';
import { useTripAuthGuard } from '../hooks/useTripAuthGuard';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { insertExpenseOrQueue, withPending } from '../utils/offlineQueue';
import { primaryTabs, type TabType } from '../features/dashboard/tabs';
import BottomNav from '../features/dashboard/BottomNav';
import { DesktopHeader, MobileTopBar, SideNav } from '../features/dashboard/TripChrome';
import BalanceTicket from '../features/dashboard/BalanceTicket';
import SummaryPanel from '../features/dashboard/SummaryPanel';
import LedgerTab from '../features/dashboard/LedgerTab';
import SettlementTab, { type SettleRequest } from '../features/dashboard/SettlementTab';
import TrashTab from '../features/dashboard/TrashTab';
import SiblingsTab from '../features/dashboard/SiblingsTab';
import AlbumTab from '../features/dashboard/AlbumTab';
import MemberAvatar from '../features/dashboard/MemberAvatar';

// 統計分頁帶著圖表套件（recharts，壓縮前 300 KB），行程分頁帶著版面元件，都等點到才下載
const StatsTab = lazy(() => import('../features/dashboard/StatsTab'));
const TripItinerary = lazy(() => import('../features/itinerary/TripItinerary'));

const TabLoading = () => (
  <div className="flex justify-center py-20 text-muted"><Loader2 className="animate-spin" size={24} /></div>
);

const APP_NAME = '旅遊小本本';

const Dashboard: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // 通行碼關卡未通過前不抓任何資料，並導回 TripPortal
  const authed = useTripAuthGuard(id);

  const {
    trip, expenses, deletedExpenses, siblingTrips, loading,
    refetchTrip, refetchExpenses, refetchDeleted,
  } = useTripData(authed ? id : undefined, useCallback(() => navigate('/'), [navigate]));
  const [activeTab, setActiveTab] = useState<TabType>(() => hasItinerary(id || '') ? 'itinerary' : 'ledger');
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  // 「我是誰」由資料推導，不另外存一份會過期的 state。
  // localStorage 的 me_{id} 是來源（設定頁改名時會跟著改它），但只認還在成員清單裡的名字 ——
  // 被移除的人留著的話，新增支出會把不存在的人預設成付款人，那筆錢就從結算裡消失。
  const [pickedUser, setPickedUser] = useState<string | null>(null);
  const storedUser = id ? localStorage.getItem(`me_${id}`) : null;
  const currentUser = !loading && trip
    ? [pickedUser, storedUser].find((m): m is string => !!m && trip.members.includes(m)) ?? null
    : null;

  // 還沒選身分就請使用者先選一次；關掉之後不再自己跳出來（頭像選單隨時可以改）
  const [welcomeRequested, setWelcomeRequested] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const isWelcomeSelectorOpen = welcomeRequested || (!loading && !!trip && !currentUser && !welcomeDismissed);
  const closeWelcome = () => { setWelcomeRequested(false); setWelcomeDismissed(true); };
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null);

  const { toast, showToast } = useToast();

  // Delete Confirmation State
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [permDeleteConfirmId, setPermDeleteConfirmId] = useState<string | null>(null);
  const [isEmptyTrashConfirmOpen, setIsEmptyTrashConfirmOpen] = useState(false);

  // Manual Settlement State
  const [isManualSettleOpen, setIsManualSettleOpen] = useState(false);
  const [manualSettleFrom, setManualSettleFrom] = useState('');
  const [manualSettleTo, setManualSettleTo] = useState('');
  const [manualSettleAmount, setManualSettleAmount] = useState('');
  const [manualSettleCurrency, setManualSettleCurrency] = useState('');

  // Settlement Confirmation State
  const [settleConfirm, setSettleConfirm] = useState<SettleRequest | null>(null);

  // 記住的身分已經不是成員了（被移除）就清掉，下次不會再讀到
  useEffect(() => {
    if (!loading && trip && storedUser && !trip.members.includes(storedUser)) {
      localStorage.removeItem(`me_${id}`);
    }
  }, [loading, trip, storedUser, id]);

  useEffect(() => {
    if (trip?.name) document.title = `${trip.name} · ${APP_NAME}`;
  }, [trip?.name]);

  // 切換分頁時回到頂端，否則手機上會停在上一頁捲到的位置
  const changeTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    window.scrollTo({ top: 0 });
  }, []);

  const { softDelete, restore, permanentlyDelete, emptyTrash } = useTrash(id, showToast);

  // 刪除與還原都會讓一筆紀錄在「帳目」與「垃圾桶」之間移動，兩份清單都要更新。
  // 不能只靠 realtime：手機切到背景或鎖螢幕時 websocket 會被中斷，
  // 事件收不到，畫面就要手動重整才會變。
  const refetchLedgerAndTrash = useCallback(
    () => Promise.all([refetchExpenses(), refetchDeleted()]),
    [refetchExpenses, refetchDeleted],
  );

  const handleDeleteExpense = async () => {
    if (!deleteConfirmId) return;
    if (await softDelete(deleteConfirmId)) {
      setDeleteConfirmId(null);
      refetchLedgerAndTrash();
    }
  };

  const handleRestoreExpense = async (expenseId: string) => {
    if (await restore(expenseId)) refetchLedgerAndTrash();
  };

  const handlePermanentlyDeleteExpense = async () => {
    if (!permDeleteConfirmId) return;
    if (await permanentlyDelete(permDeleteConfirmId)) {
      setPermDeleteConfirmId(null);
      refetchDeleted();
    }
  };

  const handleEmptyTrash = async () => {
    if (await emptyTrash()) {
      setIsEmptyTrashConfirmOpen(false);
      refetchDeleted();
    }
  };

  // 把快速記帳列已經打好的內容轉進完整表單。
  // 傳一份沒有 id 的草稿，ExpenseModal 會視為新增而非編輯。
  const openQuickAddInFullForm = (prefill: { description: string; amount: string }) => {
    if (!trip) return;
    const draft = buildQuickAddDraft(
      `${prefill.description} ${prefill.amount}`.trim(),
      trip,
      currentUser,
    );
    if (!draft) return;
    setEditingExpense({
      id: '',
      trip_id: trip.id,
      date: draft.date,
      category: draft.category,
      description: draft.description,
      amount: draft.amount,
      currency: draft.currency,
      payer_data: draft.payer_data,
      split_data: draft.split_data,
      adjustment_member: draft.adjustment_member,
      photo_urls: [],
      is_settlement: false,
      deleted_at: null,
      created_at: new Date().toISOString(),
    });
    setIsExpenseModalOpen(true);
  };

  // 離線記的那幾筆還不在資料庫裡，改或刪都要等上傳之後
  const blockPending = (exp: Expense) => {
    if (!exp.pending_sync) return false;
    showToast('這筆還沒上傳，恢復連線後才能修改或刪除', 'error');
    return true;
  };

  const handleEditExpense = (exp: Expense) => {
    if (blockPending(exp)) return;
    setDetailExpense(null);
    setEditingExpense(exp);
    setIsExpenseModalOpen(true);
  };

  const requestDelete = (exp: Expense) => {
    if (blockPending(exp)) return;
    setDetailExpense(null);
    setDeleteConfirmId(exp.id);
  };

  const openNewExpense = () => {
    setEditingExpense(null);
    setIsExpenseModalOpen(true);
  };

  const closeExpenseModal = () => {
    setIsExpenseModalOpen(false);
    setEditingExpense(null);
  };

  const handleSetCurrentUser = (name: string) => {
    localStorage.setItem(`me_${id}`, name);
    setPickedUser(name);
    closeWelcome();
  };

  const handleOpenManualSettle = () => {
    if (!trip) return;
    setManualSettleFrom(trip.members[0]);
    setManualSettleTo(trip.members[1] || trip.members[0]);
    setManualSettleAmount('');
    setManualSettleCurrency(trip.base_currency);
    setIsManualSettleOpen(true);
  };

  const submitManualSettle = () => {
    if (!manualSettleFrom || !manualSettleTo || !manualSettleAmount) return;
    if (manualSettleFrom === manualSettleTo) {
      showToast('付款人與收款人不能是同一位成員', 'error');
      return;
    }
    const parsedAmount = parseFloat(manualSettleAmount);
    if (!isFinite(parsedAmount) || parsedAmount <= 0) {
      showToast('請輸入大於 0 的結清金額', 'error');
      return;
    }
    setSettleConfirm({
      from: manualSettleFrom,
      to: manualSettleTo,
      amount: parsedAmount,
      cur: manualSettleCurrency
    });
    setIsManualSettleOpen(false);
  };

  // 離線時記的支出先併進來，帳目、餘額、統計都會先算進去
  const { queue: offlineQueue } = useOfflineQueue(!loading && !!trip, async (count) => {
    await refetchExpenses();
    showToast(`已上傳 ${count} 筆離線時記的支出`);
  });
  const allExpenses = useMemo(
    () => (trip ? withPending(expenses, offlineQueue, trip.id) : expenses),
    [expenses, offlineQueue, trip],
  );

  const stats = useTripStats(allExpenses, trip, currentUser);

  // 明細面板跟著最新資料走：開著的時候別人改了金額要看得到，被刪掉了就關起來
  const liveDetail = detailExpense ? allExpenses.find(e => e.id === detailExpense.id) ?? null : null;

  const confirmSettleUp = async () => {
    if (!supabase || !trip || !settleConfirm) return;
    const { from, to, amount, cur } = settleConfirm;
    const actualCur = cur === 'GRAND_TOTAL' ? trip.base_currency : cur;
    try {
      const { queued } = await insertExpenseOrQueue({
        trip_id: trip.id, date: getLocalDateString(), category: '結清',
        description: `結清：${from} ➡️ ${to}`, amount: amount, currency: actualCur,
        payer_data: { [from]: amount }, split_data: { [to]: amount }, is_settlement: true,
        adjustment_member: null, photo_urls: [],
      });
      setSettleConfirm(null); refetchExpenses();
      showToast(queued ? '目前離線，結清已先存在手機，恢復連線後會自動上傳' : '已記錄結清');
    } catch (err) { showToast('結清失敗：' + (err instanceof Error ? err.message : String(err)), 'error'); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas text-ink-2 flex flex-col items-center justify-center">
        <Loader2 className="animate-spin text-ink mb-3" size={28} /><p className="text-sm">正在開啟旅程…</p>
      </div>
    );
  }

  // 查無此旅程時 useTripData 已經導回首頁；還走到這裡代表是網路問題，讓使用者自己重試
  if (!trip) {
    return (
      <div className="min-h-screen bg-canvas text-ink flex flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-ink-2">無法載入旅程資料，請確認網路連線後再試一次。</p>
        <button onClick={() => { refetchTrip(); refetchExpenses(); refetchDeleted(); }} className={ui.btnPrimary}>
          重新載入
        </button>
      </div>
    );
  }

  const showItineraryTab = id ? hasItinerary(id) : false;
  const tabs = primaryTabs(showItineraryTab);
  const readOnly = trip.is_archived;
  const goHome = () => navigate('/');
  const goCategory = () => { if (trip.category) navigate(`/#cat-${encodeURIComponent(trip.category)}`); };

  const chromeProps = {
    trip,
    currentUser,
    onPick: handleSetCurrentUser,
    tabs,
    active: activeTab,
    onChange: changeTab,
    trashCount: deletedExpenses.length,
    onBack: goHome,
    onOpenSettings: () => setIsSettingsModalOpen(true),
  };

  const ticket = (notchBg: string) => (
    <BalanceTicket
      trip={trip}
      stats={stats}
      currentUser={currentUser}
      onSettle={() => changeTab('settlement')}
      onPickUser={() => setWelcomeRequested(true)}
      notchBg={notchBg}
    />
  );

  return (
    <div className="min-h-screen bg-canvas text-ink md:flex">
      <SideNav {...chromeProps} />
      <MobileTopBar {...chromeProps} />

      <main className="flex-1 min-w-0 px-4 sm:px-6 md:px-8 pt-1 md:pt-7 pb-nav md:pb-12">
        <div className={`mx-auto space-y-5 ${activeTab === 'ledger' ? 'max-w-4xl' : 'max-w-5xl'}`}>
          <DesktopHeader
            trip={trip}
            currentUser={currentUser}
            onPick={handleSetCurrentUser}
            onAdd={readOnly ? undefined : openNewExpense}
            onCategory={goCategory}
          />

          {/* 缺少匯率警告：避免統計數字默默算錯 */}
          {stats.missingRateCurrencies.length > 0 && (
            <div className={ui.warnBox} role="alert">
              <AlertTriangle size={17} className="shrink-0 mt-0.5" />
              <p>
                有支出用了沒設定匯率的幣別（{stats.missingRateCurrencies.join('、')}），目前暫時以 1:1 換算成 {trip.base_currency}，
                總支出與結清金額並不正確。請到「旅程設定 → 匯率」補上。
              </p>
            </div>
          )}

          {activeTab === 'ledger' && (
            <LedgerTab
              trip={trip}
              expenses={allExpenses}
              currentUser={currentUser}
              trashCount={deletedExpenses.length}
              onOpenExpense={setDetailExpense}
              onEditExpense={handleEditExpense}
              onDeleteExpense={requestDelete}
              onQuickSaved={refetchExpenses}
              onOpenQuickInForm={openQuickAddInFullForm}
              onOpenTrash={() => changeTab('recycle')}
              showToast={showToast}
              summary={<div className="xl:hidden">{ticket('var(--app-bg)')}</div>}
            />
          )}

          {activeTab === 'stats' && (
            <Suspense fallback={<TabLoading />}>
              <StatsTab trip={trip} expenses={allExpenses} stats={stats} currentUser={currentUser} />
            </Suspense>
          )}

          {activeTab === 'settlement' && (
            <SettlementTab
              trip={trip}
              expenses={allExpenses}
              stats={stats}
              currentUser={currentUser}
              onRecord={setSettleConfirm}
              onManual={handleOpenManualSettle}
              onEdit={handleEditExpense}
              onDelete={requestDelete}
            />
          )}

          {activeTab === 'recycle' && (
            <TrashTab
              trip={trip}
              deleted={deletedExpenses}
              onRestore={handleRestoreExpense}
              onPermanentDelete={setPermDeleteConfirmId}
              onEmpty={() => setIsEmptyTrashConfirmOpen(true)}
            />
          )}

          {activeTab === 'itinerary' && id && (
            <Suspense fallback={<TabLoading />}>
              <TripItinerary tripId={id} />
            </Suspense>
          )}

          {activeTab === 'album' && <AlbumTab trip={trip} expenses={allExpenses} onOpenExpense={setDetailExpense} />}

          {activeTab === 'siblings' && (
            <SiblingsTab
              trip={trip}
              siblings={siblingTrips}
              onOpenTrip={(sid) => navigate(`/trip/${sid}`)}
              onOpenCategory={goCategory}
              onOpenSettings={() => setIsSettingsModalOpen(true)}
            />
          )}
        </div>
      </main>

      {activeTab === 'ledger' && (
        <SummaryPanel
          trip={trip}
          stats={stats}
          currentUser={currentUser}
          ticket={ticket('var(--app-sunk)')}
          onRecordSettlement={readOnly ? undefined : setSettleConfirm}
          onOpenSettlement={() => changeTab('settlement')}
        />
      )}

      <BottomNav tabs={tabs} active={activeTab} onChange={changeTab} onAdd={readOnly ? undefined : openNewExpense} />

      {liveDetail && (
        <ExpenseDetailModal
          expense={liveDetail}
          trip={trip}
          currentUser={currentUser}
          onClose={() => setDetailExpense(null)}
          onEdit={readOnly ? undefined : handleEditExpense}
          onDelete={readOnly ? undefined : requestDelete}
        />
      )}

      {settleConfirm && (
        <ConfirmDialog
          isOpen={!!settleConfirm}
          onClose={() => setSettleConfirm(null)}
          onConfirm={confirmSettleUp}
          title="記錄結清"
          icon={<HandCoins />}
          tone="primary"
          description={<p>實際轉完帳後再記錄，餘額會跟著更新。</p>}
          confirmLabel="記錄結清"
          confirmIcon={<Check size={18} strokeWidth={2.6} />}
        >
          <div className="rounded-xl bg-sunk border border-line px-4 py-4 space-y-2">
            <div className="flex items-center justify-center gap-3 text-base font-bold">
              <span className="inline-flex items-center gap-1.5"><MemberAvatar name={settleConfirm.from} size={26} />{settleConfirm.from}</span>
              <ArrowRight size={18} className="text-muted" />
              <span className="inline-flex items-center gap-1.5"><MemberAvatar name={settleConfirm.to} size={26} />{settleConfirm.to}</span>
            </div>
            <p className="num text-2xl font-extrabold">{formatMoney(settleConfirm.amount, settleConfirm.cur, trip.precision_config)}</p>
          </div>
        </ConfirmDialog>
      )}

      {/* Manual Settlement Modal */}
      {isManualSettleOpen && (
        <Modal isOpen={isManualSettleOpen} onClose={() => setIsManualSettleOpen(false)} title="手動新增結清">
          <div className="space-y-4">
            <div>
              <label htmlFor="settle-from" className={ui.label}>誰付錢</label>
              <select id="settle-from" className={ui.select} value={manualSettleFrom} onChange={e => setManualSettleFrom(e.target.value)}>
                {trip.members.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="flex justify-center -my-1 text-muted"><ArrowDown size={18} /></div>
            <div>
              <label htmlFor="settle-to" className={ui.label}>誰收錢</label>
              <select id="settle-to" className={ui.select} value={manualSettleTo} onChange={e => setManualSettleTo(e.target.value)}>
                {trip.members.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="settle-amount" className={ui.label}>金額與幣別</label>
              <div className="flex gap-2">
                <select
                  aria-label="幣別"
                  className={`${ui.select} w-28 shrink-0`}
                  value={manualSettleCurrency}
                  onChange={e => setManualSettleCurrency(e.target.value)}
                >
                  {Object.keys(trip.rates).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input
                  id="settle-amount"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  placeholder="0"
                  className={`${ui.input} num text-lg font-bold`}
                  value={manualSettleAmount}
                  onChange={e => setManualSettleAmount(e.target.value)}
                />
              </div>
            </div>
            {manualSettleFrom === manualSettleTo && (
              <p className="flex items-center gap-1.5 text-xs text-neg">
                <AlertTriangle size={14} className="shrink-0" />付款人與收款人不能是同一位成員
              </p>
            )}
            <div className="flex gap-3 pt-2">
              <button onClick={() => setIsManualSettleOpen(false)} className={`${ui.btnSecondary} flex-1 py-3`}>取消</button>
              <button onClick={submitManualSettle} disabled={manualSettleFrom === manualSettleTo} className={`${ui.btnPrimary} flex-1 py-3`}>
                下一步
              </button>
            </div>
          </div>
        </Modal>
      )}

      <ExpenseModal isOpen={isExpenseModalOpen} onClose={closeExpenseModal} trip={trip} currentUser={currentUser} onSuccess={() => { refetchExpenses(); }} showToast={showToast} editData={editingExpense} />
      <SettingsModal isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} trip={trip} onSuccess={() => { refetchTrip(); showToast('設定已更新'); }} expenses={expenses} />

      {deleteConfirmId && (
        <ConfirmDialog
          isOpen={!!deleteConfirmId}
          onClose={() => setDeleteConfirmId(null)}
          onConfirm={handleDeleteExpense}
          title="刪除支出"
          icon={<Trash2 />}
          heading="確定要刪除這筆支出嗎？"
          description={<p>刪除後會移到垃圾桶，24 小時內都可以還原。</p>}
          confirmLabel="刪除"
        />
      )}

      {/* Welcome Identity Selector Modal */}
      <Modal isOpen={isWelcomeSelectorOpen} onClose={closeWelcome} title="你是哪一位？">
        <div className="space-y-4">
          <p className="text-sm text-ink-2">選好之後，帳目會標出你的份額，最上面也會顯示你還要付或可以收回多少。之後可以從右上角的頭像更改。</p>
          <div className="grid grid-cols-2 gap-2.5">
            {trip.members.map(member => (
              <button
                key={member}
                onClick={() => handleSetCurrentUser(member)}
                className={`flex items-center gap-2.5 px-3 py-3 rounded-xl border text-left transition-colors ${
                  member === currentUser ? 'border-ink bg-sunk' : 'border-line hover:bg-sunk'
                }`}
              >
                <MemberAvatar name={member} size={30} isMe={member === currentUser} />
                <span className="text-[15px] font-medium truncate">{member}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>

      {permDeleteConfirmId && (
        <ConfirmDialog
          isOpen={!!permDeleteConfirmId}
          onClose={() => setPermDeleteConfirmId(null)}
          onConfirm={handlePermanentlyDeleteExpense}
          title="永久刪除"
          icon={<AlertTriangle />}
          heading="確定要永久刪除嗎？"
          description={<p>這個動作無法復原，這筆支出會完全消失。</p>}
          confirmLabel="永久刪除"
        />
      )}

      {isEmptyTrashConfirmOpen && (
        <ConfirmDialog
          isOpen={isEmptyTrashConfirmOpen}
          onClose={() => setIsEmptyTrashConfirmOpen(false)}
          onConfirm={handleEmptyTrash}
          title="清空垃圾桶"
          icon={<Trash2 />}
          solidIcon
          heading="確定要清空垃圾桶嗎？"
          description={<p>垃圾桶裡的 {deletedExpenses.length} 筆紀錄會永久刪除，無法復原。</p>}
          confirmLabel="清空"
        />
      )}

      <Toast toast={toast} />
    </div>
  );
};

export default Dashboard;
