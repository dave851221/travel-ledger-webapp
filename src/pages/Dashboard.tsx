import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  PieChart as PieChartIcon, 
  Trash2, 
  Loader2, 
  Plus, 
  Wallet, 
  ArrowUpRight, 
  ArrowDownLeft,
  Settings,
  Receipt,
  Map,
  HandCoins,
  Lock,
  Users,
  Search,
  ChevronRight,
  Edit2,
  X,
  ChevronLeft as ChevronLeftIcon,
  RotateCcw,
  AlertTriangle,
  BarChart3,
  Scale,
  User,
  Check
} from 'lucide-react';
import { 
  PieChart, Pie, Cell, 
  Tooltip,
  ResponsiveContainer,
  LabelList
} from 'recharts';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { hasItinerary, getItineraryComponent } from '../features/itinerary/registry';
import ExpenseModal from '../components/ExpenseModal';
import ExpenseDetailModal from '../components/ExpenseDetailModal';
import SettingsModal from '../components/SettingsModal';
import Modal from '../components/Modal';
import { formatAmount } from '../utils/finance';
import { getCategoryColor } from '../utils/category';
import Decimal from 'decimal.js';

type TabType = 'ledger' | 'stats' | 'settlement' | 'itinerary' | 'recycle';

const fmt = (val: number, cur: string = '', prec: Record<string, number> = {}) => {
  const formatted = formatAmount(val, cur, prec);
  return `$${formatted}`;
};

const Dashboard: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [deletedExpenses, setDeletedExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>(() => hasItinerary(id || '') ? 'itinerary' : 'ledger');
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [isUserSelectorOpen, setIsUserSelectorOpen] = useState(false);
  const [isWelcomeSelectorOpen, setIsWelcomeSelectorOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  
  const [previewAlbum, setPreviewAlbum] = useState<string[] | null>(null);
  const [currentPhotoIdx, setCurrentPhotoIdx] = useState(0);
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null);

  // Toast State
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  };

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
  const [settleConfirm, setSettleConfirm] = useState<{ from: string, to: string, amount: number, cur: string } | null>(null);

  useEffect(() => {
    const checkAuth = () => {
      const authed = localStorage.getItem(`auth_${id}`);
      if (!authed) {
        navigate(`/trip/${id}`);
        return false;
      }
      return true;
    };

    if (checkAuth()) {
      initDashboard();
      if (!supabase || !id) return;
      const channel = supabase.channel(`expenses_changes_${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `trip_id=eq.${id}` }, () => {
          fetchExpenses();
          fetchDeletedExpenses();
        }).subscribe();
      return () => { supabase.removeChannel(channel); };
    }
  }, [id, navigate]);

  useEffect(() => {
    if (trip?.name) document.title = `${trip.name} - 旅遊小本本`;
  }, [trip?.name]);

  const initDashboard = async () => {
    setLoading(true);
    await Promise.all([fetchTripData(), fetchExpenses(), fetchDeletedExpenses()]);
    const savedUser = localStorage.getItem(`me_${id}`);
    if (savedUser) {
      setCurrentUser(savedUser);
    } else {
      setIsWelcomeSelectorOpen(true);
    }
    setLoading(false);
  };

  const fetchTripData = async () => {
    if (!supabase || !id) return;
    try {
      const { data, error } = await supabase.from('trips').select('*').eq('id', id).single();
      if (error) throw error;
      setTrip(data);
    } catch (err) { console.error(err); navigate('/'); }
  };

  const fetchExpenses = async () => {
    if (!supabase || !id) return;
    try {
      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .eq('trip_id', id)
        .is('deleted_at', null)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      setExpenses(data || []);
    } catch (err) { console.error(err); }
  };

  const fetchDeletedExpenses = async () => {
    if (!supabase || !id) return;
    try {
      const { data, error } = await supabase.from('expenses').select('*').eq('trip_id', id).not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
      if (error) throw error;
      const now = new Date();
      const validDeleted: Expense[] = [];
      const expiredIds: string[] = [];
      const expiredPhotoUrls: string[] = [];
      (data || []).forEach((exp: Expense) => {
        if (!exp.deleted_at) return;
        const hoursDiff = (now.getTime() - new Date(exp.deleted_at).getTime()) / (1000 * 60 * 60);
        if (hoursDiff <= 24) {
          validDeleted.push(exp);
        } else {
          expiredIds.push(exp.id);
          (exp.photo_urls || []).forEach(url => { if (url) expiredPhotoUrls.push(url); });
        }
      });
      if (expiredIds.length > 0) {
        if (expiredPhotoUrls.length > 0) {
          await supabase.storage.from('travel-images').remove(expiredPhotoUrls);
        }
        await supabase.from('expenses').delete().in('id', expiredIds);
      }
      setDeletedExpenses(validDeleted);
    } catch (err) { console.error(err); }
  };

  const handleDeleteExpense = async () => {
    if (!deleteConfirmId || !supabase) return;
    try {
      const { error } = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', deleteConfirmId);
      if (error) throw error;
      showToast('紀錄已移至垃圾桶');
      setDeleteConfirmId(null);
    } catch (err: any) { showToast('刪除失敗: ' + err.message, 'error'); }
  };

  const handleRestoreExpense = async (expenseId: string) => {
    if (!supabase) return;
    try {
      const { error } = await supabase.from('expenses').update({ deleted_at: null }).eq('id', expenseId);
      if (error) throw error;
      showToast('紀錄已還原');
    } catch (err: any) { showToast('還原失敗: ' + err.message, 'error'); }
  };

  const handlePermanentlyDeleteExpense = async () => {
    if (!permDeleteConfirmId || !supabase) return;
    try {
      // 1. 先取得該筆紀錄的資料以獲取照片路徑
      const { data: exp, error: fetchError } = await supabase
        .from('expenses')
        .select('photo_urls')
        .eq('id', permDeleteConfirmId)
        .single();
      
      if (fetchError) throw fetchError;

      // 2. 如果有照片，先從 Storage 刪除
      if (exp?.photo_urls && exp.photo_urls.length > 0) {
        const { error: storageError } = await supabase.storage
          .from('travel-images')
          .remove(exp.photo_urls);
        if (storageError) console.error('照片刪除失敗:', storageError);
      }

      // 3. 刪除資料庫紀錄
      const { error } = await supabase.from('expenses').delete().eq('id', permDeleteConfirmId);
      if (error) throw error;
      
      showToast('紀錄已永久刪除');
      setPermDeleteConfirmId(null);
      fetchDeletedExpenses();
    } catch (err: any) { showToast('刪除失敗: ' + err.message, 'error'); }
  };

  const handleEmptyTrash = async () => {
    if (!supabase || !id) return;
    try {
      // 1. 先取得垃圾桶內所有紀錄的照片清單
      const { data: exps, error: fetchError } = await supabase
        .from('expenses')
        .select('photo_urls')
        .eq('trip_id', id)
        .not('deleted_at', 'is', null);
      
      if (fetchError) throw fetchError;

      // 2. 整理出所有照片路徑
      const allPhotoUrls = (exps || [])
        .flatMap((exp: { photo_urls: string[] | null }) => exp.photo_urls || [])
        .filter((url: string) => !!url);

      // 3. 如果有照片，整批從 Storage 刪除
      if (allPhotoUrls.length > 0) {
        const { error: storageError } = await supabase.storage
          .from('travel-images')
          .remove(allPhotoUrls);
        if (storageError) console.error('整批照片刪除失敗:', storageError);
      }

      // 4. 刪除資料庫紀錄
      const { error } = await supabase.from('expenses').delete().eq('trip_id', id).not('deleted_at', 'is', null);
      if (error) throw error;

      showToast('垃圾桶已完全清空');
      setIsEmptyTrashConfirmOpen(false);
      fetchDeletedExpenses();
    } catch (err: any) { showToast('清空失敗: ' + err.message, 'error'); }
  };

  const handleEditExpense = (exp: Expense) => {
    setEditingExpense(exp);
    setIsExpenseModalOpen(true);
  };

  const closeExpenseModal = () => {
    setIsExpenseModalOpen(false);
    setEditingExpense(null);
  };

  const handleSetCurrentUser = (name: string) => {
    setCurrentUser(name);
    localStorage.setItem(`me_${id}`, name);
    setIsUserSelectorOpen(false);
    setIsWelcomeSelectorOpen(false);
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
    setSettleConfirm({
      from: manualSettleFrom,
      to: manualSettleTo,
      amount: parseFloat(manualSettleAmount),
      cur: manualSettleCurrency
    });
    setIsManualSettleOpen(false);
  };

  const filteredExpenses = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return expenses.filter(e => {
      if (e.is_settlement) return false;
      const matchesSearch = !q || (
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        Object.keys(e.payer_data).some(p => p.toLowerCase().includes(q))
      );
      const matchesCategory = selectedCategories.length === 0 || selectedCategories.includes(e.category);
      return matchesSearch && matchesCategory;
    });
  }, [expenses, searchQuery, selectedCategories]);

  const stats = useMemo(() => {
    const byCurrency: Record<string, { total: number, paidByMe: number, owedByMe: number }> = {};
    const grandBase = { total: 0, paidByMe: 0, owedByMe: 0 };
    const categoryMap: Record<string, number> = {};
    const memberDetails: Record<string, { totalOwed: number, categories: Record<string, number> }> = {};
    const balances: Record<string, Record<string, number>> = { 'GRAND_TOTAL': {} };
    if (!trip) return { byCurrency, grandBase, categoryData: [], memberDetails: {}, balances };
    trip.members.forEach(m => {
      memberDetails[m] = { totalOwed: 0, categories: {} };
      balances['GRAND_TOTAL'][m] = 0;
    });
    expenses.forEach(e => {
      const rate = trip.rates[e.currency] || 1;
      const amountInBase = e.amount * rate;
      if (!byCurrency[e.currency]) {
        byCurrency[e.currency] = { total: 0, paidByMe: 0, owedByMe: 0 };
        balances[e.currency] = {};
        trip.members.forEach(m => balances[e.currency][m] = 0);
      }
      const pMe = currentUser ? (Number(e.payer_data[currentUser]) || 0) : 0;
      const oMe = currentUser ? (Number(e.split_data[currentUser]) || 0) : 0;

      // 只有「非結清」紀錄才計入總支出與分類統計
      if (!e.is_settlement) {
        byCurrency[e.currency].total += Number(e.amount) || 0;
        byCurrency[e.currency].paidByMe += pMe;
        byCurrency[e.currency].owedByMe += oMe;
        grandBase.total += amountInBase;
        grandBase.paidByMe += (pMe * rate);
        grandBase.owedByMe += (oMe * rate);
        categoryMap[e.category] = (categoryMap[e.category] || 0) + amountInBase;
        trip.members.forEach(m => {
          const owed = Number(e.split_data[m]) || 0;
          const owedInBase = owed * rate;
          memberDetails[m].totalOwed += owedInBase;
          memberDetails[m].categories[e.category] = (memberDetails[m].categories[e.category] || 0) + owedInBase;
        });
      }

      // 所有紀錄（含結清）都要計入餘額，用來計算誰該給誰多少錢
      trip.members.forEach(m => {
        const paid = Number(e.payer_data[m]) || 0;
        const owed = Number(e.split_data[m]) || 0;
        balances[e.currency][m] += (paid - owed);
        balances['GRAND_TOTAL'][m] += ((paid - owed) * rate);
      });
    });
    const categoryData = Object.entries(categoryMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    return { byCurrency, grandBase, categoryData, memberDetails, balances };
  }, [expenses, trip, currentUser]);

  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>({});
  const [expandedCatStats, setExpandedCatStats] = useState<Set<string>>(new Set());
  const [expandedMemberCatStats, setExpandedMemberCatStats] = useState<Set<string>>(new Set());

  const groupedExpenses = useMemo(() => {
    const groups: Record<string, { expenses: Expense[], totals: Record<string, number> }> = {};
    const chineseDays = ['(日)', '(一)', '(二)', '(三)', '(四)', '(五)', '(六)'];

    filteredExpenses.forEach(exp => {
      if (!groups[exp.date]) {
        groups[exp.date] = { expenses: [], totals: {} };
      }
      groups[exp.date].expenses.push(exp);
      
      // Only count non-settlement for daily totals
      if (!exp.is_settlement) {
        groups[exp.date].totals[exp.currency] = (groups[exp.date].totals[exp.currency] || 0) + exp.amount;
      }
    });
    
    // Sort dates descending
    const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));
    return sortedDates.map(date => {
      const d = new Date(date);
      const dayName = chineseDays[d.getDay()];
      return { 
        date, 
        displayDate: `${date} ${dayName}`,
        ...groups[date] 
      };
    });
  }, [filteredExpenses]);

  const toggleCategory = (cat: string) => {
    setSelectedCategories(prev => 
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  const toggleDate = (date: string) => {
    setExpandedDates(prev => ({
      ...prev,
      [date]: prev[date] === false ? true : false
    }));
  };


  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

  const getTitleFontSize = (name: string = '') => {
    if (name.length > 20) return 'text-[16px] sm:text-lg md:text-xl';
    if (name.length > 12) return 'text-lg sm:text-2xl md:text-3xl';
    return 'text-xl sm:text-3xl md:text-4xl';
  };

  const openAlbum = (urls: string[]) => {
    setPreviewAlbum(urls.map(url => `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/travel-images/${url}`));
    setCurrentPhotoIdx(0);
  };

  const calculateSettlements = (memberBalances: Record<string, number>) => {
    const EPSILON = new Decimal('0.01');
    const debtors: { name: string, amt: Decimal }[] = [];
    const creditors: { name: string, amt: Decimal }[] = [];
    Object.entries(memberBalances).forEach(([name, bal]) => {
      const d = new Decimal(bal);
      if (d.lt(EPSILON.negated())) debtors.push({ name, amt: d.negated() });
      else if (d.gt(EPSILON)) creditors.push({ name, amt: d });
    });
    debtors.sort((a, b) => b.amt.comparedTo(a.amt));
    creditors.sort((a, b) => b.amt.comparedTo(a.amt));
    const result: { from: string, to: string, amount: number }[] = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const minAmt = Decimal.min(debtors[i].amt, creditors[j].amt);
      result.push({ from: debtors[i].name, to: creditors[j].name, amount: minAmt.toNumber() });
      debtors[i].amt = debtors[i].amt.minus(minAmt);
      creditors[j].amt = creditors[j].amt.minus(minAmt);
      if (debtors[i].amt.lt(EPSILON)) i++;
      if (creditors[j].amt.lt(EPSILON)) j++;
    }
    return result;
  };

  const confirmSettleUp = async () => {
    if (!supabase || !trip || !settleConfirm) return;
    const { from, to, amount, cur } = settleConfirm;
    const actualCur = cur === 'GRAND_TOTAL' ? trip.base_currency : cur;
    try {
      const { error } = await supabase.from('expenses').insert([{
        trip_id: trip.id, date: new Date().toISOString().split('T')[0], category: '結清',
        description: `結清：${from} ➡️ ${to}`, amount: amount, currency: actualCur,
        payer_data: { [from]: amount }, split_data: { [to]: amount }, is_settlement: true
      }]);
      if (error) throw error;
      setSettleConfirm(null); fetchExpenses();
    } catch (err: any) { showToast('結清失敗: ' + err.message, 'error'); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8fafc] dark:bg-slate-950 flex flex-col items-center justify-center">
        <Loader2 className="animate-spin text-blue-600 mb-4" size={32} /><p className="text-slate-500 font-bold animate-pulse text-sm">正在開啟旅程資料...</p>
      </div>
    );
  }

  const ItineraryComponent = id ? getItineraryComponent(id) : null;
  const showItineraryTab = id ? hasItinerary(id) : false;

  return (
    <div className="min-h-screen bg-[#f8fafc] dark:bg-slate-950 pb-24 md:pb-8 transition-colors duration-500 text-slate-900 dark:text-slate-100">
      
      {/* Album Preview */}
      {detailExpense && trip && (
        <ExpenseDetailModal expense={detailExpense} trip={trip} onClose={() => setDetailExpense(null)} />
      )}

      {previewAlbum && (
        <div className="fixed inset-0 z-[60] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setPreviewAlbum(null)}>
          <button className="absolute top-6 right-6 text-white bg-white/10 p-2 rounded-full"><X size={24} /></button>
          {previewAlbum.length > 1 && (
            <><button className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 p-4" onClick={(e) => { e.stopPropagation(); setCurrentPhotoIdx(prev => (prev > 0 ? prev - 1 : previewAlbum.length - 1)); }}><ChevronLeftIcon size={48} /></button><button className="absolute right-4 top-1/2 -translate-y-1/2 text-white/50 p-4" onClick={(e) => { e.stopPropagation(); setCurrentPhotoIdx(prev => (prev < previewAlbum.length - 1 ? prev + 1 : 0)); }}><ChevronRight size={48} /></button></>
          )}
          <img key={currentPhotoIdx} src={previewAlbum[currentPhotoIdx]} className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl" alt="Preview" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* Navigation */}
      <nav className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-100 dark:border-slate-800 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 sm:h-24 flex items-center justify-between gap-4">
          <div className="flex-1 flex flex-col min-w-0">
            <h1 className={`${getTitleFontSize(trip?.name)} font-black text-slate-900 dark:text-white truncate`}>{trip?.name}</h1>
            <div className="flex items-center gap-2 mt-1 sm:mt-2">
              <span className="text-[10px] sm:text-xs text-blue-600 font-bold uppercase tracking-[0.2em] leading-none">Travel Dashboard</span>
              {trip?.is_archived && <span className="text-[10px] sm:text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded flex items-center gap-1 font-black"><Lock size={10} /> READ ONLY</span>}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-1 sm:gap-2">
            <div className="relative">
              <button onClick={() => setIsUserSelectorOpen(!isUserSelectorOpen)} className={`flex items-center gap-1.5 px-2 py-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all ${currentUser ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900/30' : 'border-slate-200 text-slate-500 hover:border-blue-400'}`}>
                <User size={12} /><span className="text-[10px] sm:text-xs font-black truncate max-w-[60px] sm:max-w-[100px]">{currentUser || '設定身分'}</span>
              </button>
              {isUserSelectorOpen && (
                <div className="absolute right-0 top-12 w-48 bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-100 dark:border-slate-700 py-3 z-50">
                  <p className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-700/10 mb-2">誰是「我」？</p>
                  {trip?.members.map(member => (<button key={member} onClick={() => handleSetCurrentUser(member)} className={`w-full text-left px-4 py-3 text-sm font-bold transition-colors flex items-center justify-between ${currentUser === member ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>{member}{currentUser === member && <div className="w-2 h-2 rounded-full bg-blue-600" />}</button>))}
                </div>
              )}
            </div>
            <button onClick={() => setIsSettingsModalOpen(true)} className="p-2 text-slate-400 hover:text-blue-600 transition-all">
              <Settings size={18} />
            </button>
          </div>
        </div>
        <div className="hidden md:flex max-w-7xl mx-auto px-6 border-t border-slate-50 dark:border-slate-800/50">
          <div className="flex gap-10">
            {showItineraryTab && <button onClick={() => setActiveTab('itinerary')} className={`py-6 text-xs lg:text-sm font-black uppercase tracking-[0.2em] border-b-4 transition-all ${activeTab === 'itinerary' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>行程規劃</button>}
            <button onClick={() => setActiveTab('ledger')} className={`py-6 text-xs lg:text-sm font-black uppercase tracking-[0.2em] border-b-4 transition-all ${activeTab === 'ledger' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>支出紀錄</button>
            <button onClick={() => setActiveTab('stats')} className={`py-6 text-xs lg:text-sm font-black uppercase tracking-[0.2em] border-b-4 transition-all ${activeTab === 'stats' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>統計分析</button>
            <button onClick={() => setActiveTab('settlement')} className={`py-6 text-xs lg:text-sm font-black uppercase tracking-[0.2em] border-b-4 transition-all ${activeTab === 'settlement' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>結清指南</button>
            {deletedExpenses.length > 0 && <button onClick={() => setActiveTab('recycle')} className={`py-6 text-xs lg:text-sm font-black uppercase tracking-[0.2em] border-b-4 transition-all ${activeTab === 'recycle' ? 'border-rose-600 text-rose-600' : 'border-transparent text-slate-500 hover:text-rose-600'}`}>垃圾桶 ({deletedExpenses.length})</button>}
          </div>
        </div>
      </nav>

      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-12 md:px-16 lg:px-24 py-4 md:py-8">
        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-8 mb-6 md:mb-10">
          {/* Card 1: Total Expense */}
          <div className="bg-white dark:bg-slate-900 py-3 px-4 sm:px-6 rounded-2xl sm:rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-3 sm:gap-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 w-8 h-8 sm:w-12 sm:h-12 rounded-lg sm:rounded-2xl flex items-center justify-center shrink-0"><Wallet className="text-blue-600 w-4 h-4 sm:w-6 sm:h-6" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] sm:text-xs font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5">總支出 ({trip?.base_currency})</p>
              <p className="text-sm sm:text-xl font-black text-slate-900 dark:text-white leading-tight truncate">{fmt(stats.grandBase.total, trip?.base_currency, trip?.precision_config)}</p>
              <div className="flex flex-wrap gap-x-2 mt-0.5">
                {Object.entries(stats.byCurrency).map(([cur, data]) => (<span key={cur} className="text-[8px] sm:text-[9px] font-black text-slate-800 dark:text-slate-400 whitespace-nowrap">{fmt(data.total, cur, trip?.precision_config)} <span className="opacity-60">{cur}</span></span>))}
              </div>
            </div>
          </div>

          {/* Card 2: Members */}
          <div className="bg-white dark:bg-slate-900 py-3 px-4 sm:px-6 rounded-2xl sm:rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-3 sm:gap-4">
            <div className="bg-amber-50 dark:bg-amber-900/20 w-8 h-8 sm:w-12 sm:h-12 rounded-lg sm:rounded-2xl flex items-center justify-center shrink-0"><Users className="text-amber-600 w-4 h-4 sm:w-6 sm:h-6" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] sm:text-xs font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5">成員 ({trip?.members.length})</p>
              <div className="flex flex-wrap gap-1 mt-0.5">{trip?.members.map(m => (<span key={m} className={`px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-black uppercase ${m === currentUser ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-300'}`}>{m}</span>))}</div>
            </div>
          </div>

          {/* Card 3: Paid by Me */}
          <div className={`py-3 px-4 sm:px-6 rounded-2xl sm:rounded-[2rem] border transition-all flex items-center gap-3 sm:gap-4 ${currentUser ? 'bg-emerald-50/30 border-emerald-100 dark:bg-emerald-900/10' : 'bg-white dark:bg-slate-900 shadow-sm'}`}>
            <div className={`w-8 h-8 sm:w-12 sm:h-12 rounded-lg sm:rounded-2xl flex items-center justify-center shrink-0 ${currentUser ? 'bg-emerald-500 text-white' : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600'}`}><ArrowUpRight className="w-4 h-4 sm:w-6 sm:h-6" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] sm:text-xs font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5 truncate">{currentUser ? `${currentUser} 墊付` : '我墊付'}</p>
              <p className="text-sm sm:text-xl font-black text-slate-900 dark:text-white leading-tight truncate">{fmt(stats.grandBase.paidByMe, trip?.base_currency, trip?.precision_config)}</p>
              <div className="flex flex-wrap gap-x-2 mt-0.5">
                {Object.entries(stats.byCurrency).map(([cur, data]) => (<span key={cur} className="text-[8px] sm:text-[9px] font-black text-emerald-700 dark:text-emerald-400 whitespace-nowrap">{fmt(data.paidByMe, cur, trip?.precision_config)} <span className="opacity-60">{cur}</span></span>))}
              </div>
            </div>
          </div>

          {/* Card 4: Owed by Me */}
          <div className={`py-3 px-4 sm:px-6 rounded-2xl sm:rounded-[2rem] border transition-all flex items-center gap-3 sm:gap-4 ${currentUser ? 'bg-rose-50/30 border-rose-100 dark:bg-rose-900/10' : 'bg-white dark:bg-slate-900 shadow-sm'}`}>
            <div className={`w-8 h-8 sm:w-12 sm:h-12 rounded-lg sm:rounded-2xl flex items-center justify-center shrink-0 ${currentUser ? 'bg-rose-500 text-white' : 'bg-rose-50 text-rose-600'}`}><ArrowDownLeft className="w-4 h-4 sm:w-6 sm:h-6" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] sm:text-xs font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5 truncate">{currentUser ? `${currentUser} 應付` : '我應付'}</p>
              <p className="text-sm sm:text-xl font-black text-slate-900 dark:text-white leading-tight truncate">{fmt(stats.grandBase.owedByMe, trip?.base_currency, trip?.precision_config)}</p>
              <div className="flex flex-wrap gap-x-2 mt-0.5">
                {Object.entries(stats.byCurrency).map(([cur, data]) => (<span key={cur} className="text-[8px] sm:text-[9px] font-black text-rose-700 dark:text-rose-400 whitespace-nowrap">{fmt(data.owedByMe, cur, trip?.precision_config)} <span className="opacity-60">{cur}</span></span>))}
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-[400px]">
          {activeTab === 'ledger' && (
            <div className="space-y-6 animate-in fade-in duration-500">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-3 sm:gap-4"><Receipt className="text-blue-600 w-6 h-6 sm:w-8 sm:h-8" />支出紀錄</h2>
                  {!trip?.is_archived && (
                    <button onClick={() => setIsExpenseModalOpen(true)} className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-black px-4 py-2 sm:px-6 sm:py-3.5 rounded-xl sm:rounded-2xl transition-all shadow-lg shadow-blue-500/20 active:scale-95 text-xs sm:text-lg">
                      <Plus className="w-4 h-4 sm:w-6 sm:h-6" strokeWidth={3} />
                      <span>新增支出</span>
                    </button>
                  )}
                </div>
                <div className="space-y-3">
                  <div className="relative w-full">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input type="text" placeholder="搜尋描述、類別、成員..." className="w-full pl-11 pr-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl text-sm font-bold outline-none transition-all shadow-sm focus:ring-4 focus:ring-blue-500/5" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
                  </div>
                  
                  {/* Category Filters */}
                  <div className="flex flex-wrap gap-2">
                    {trip?.categories.map(cat => (
                      <button
                        key={cat}
                        onClick={() => toggleCategory(cat)}
                        className={`px-3 py-1.5 rounded-xl text-[10px] sm:text-xs font-black transition-all border ${
                          selectedCategories.includes(cat)
                            ? `${getCategoryColor(cat, trip?.categories)} border-transparent shadow-md shadow-blue-500/10`
                            : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-100 dark:border-slate-800 hover:border-blue-400'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                    {selectedCategories.length > 0 && (
                      <button 
                        onClick={() => setSelectedCategories([])}
                        className="px-3 py-1.5 rounded-xl text-[10px] sm:text-xs font-black bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-rose-600 transition-colors flex items-center gap-1"
                      >
                        <X size={12} /> 清除全部
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {deletedExpenses.length > 0 && (<button onClick={() => setActiveTab('recycle')} className="w-full flex items-center justify-center gap-2 py-2 bg-rose-50 dark:bg-rose-900/10 text-rose-600 dark:text-rose-400 text-[10px] sm:text-xs font-black rounded-xl border border-rose-100 dark:border-rose-900/30 hover:bg-rose-100 transition-all"><RotateCcw size={12} /><span>垃圾桶中有 {deletedExpenses.length} 筆可還原紀錄</span></button>)}
              
              <div className="space-y-4">
                {groupedExpenses.map(({ date, displayDate, expenses: dayExpenses, totals }) => (
                  <div key={date} className="space-y-2">
                    {/* Date Header (Collapsible) */}
                    <button 
                      onClick={() => toggleDate(date)}
                      className="w-full flex items-center justify-between p-3 sm:p-4 bg-slate-100/50 dark:bg-slate-800/30 rounded-2xl hover:bg-slate-200/50 transition-all group/date gap-2"
                    >
                      <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
                        <div className={`transition-transform duration-300 shrink-0 ${expandedDates[date] === false ? '' : 'rotate-90'}`}>
                          <ChevronRight size={18} className="text-slate-400" />
                        </div>
                        <span className="text-[13px] sm:text-lg font-black text-slate-900 dark:text-white whitespace-nowrap">{displayDate}</span>
                        <span className="text-[9px] sm:text-xs font-bold text-slate-400 bg-white dark:bg-slate-800 px-1.5 py-0.5 rounded-full border border-slate-100 dark:border-slate-700 shrink-0">{dayExpenses.length} 筆</span>
                      </div>
                      <div className="flex flex-wrap justify-end gap-0.5 sm:gap-2 flex-1 min-w-0">
                        {Object.entries(totals).map(([cur, amt]) => (
                          <span key={cur} className="text-[9px] sm:text-sm font-black text-blue-600 bg-blue-50 dark:bg-blue-900/20 px-1 sm:px-3 py-1 rounded-xl border border-blue-100 dark:border-blue-900/30 whitespace-nowrap shrink-0">
                            {fmt(amt, cur, trip?.precision_config)} <span className="text-[7px] sm:text-[8px] opacity-60 ml-0.5">{cur}</span>
                          </span>
                        ))}
                      </div>
                    </button>

                    {/* Expenses under this date */}
                    <div className={`grid grid-cols-1 gap-2 overflow-hidden transition-all duration-300 ${expandedDates[date] === false ? 'max-h-0 opacity-0' : 'max-h-[5000px] opacity-100'}`}>
                      {dayExpenses.map(exp => (
                        <div key={exp.id} onClick={() => setDetailExpense(exp)} className={`group p-3 sm:p-5 rounded-2xl border transition-all flex items-center gap-4 sm:gap-6 relative overflow-hidden cursor-pointer ${exp.is_settlement ? 'bg-emerald-50/20 dark:bg-emerald-900/5 border-dashed border-emerald-200 hover:bg-emerald-50/40' : 'bg-white dark:bg-slate-900 border-slate-100 shadow-sm hover:shadow-md hover:border-blue-200 dark:hover:border-blue-900/50'}`}>
                          <div className={`w-12 h-12 sm:w-16 sm:h-16 bg-slate-50 dark:bg-slate-800 rounded-xl overflow-hidden shrink-0 flex items-center justify-center border border-slate-100 relative ${exp.photo_urls?.length ? 'cursor-zoom-in' : ''}`} onClick={e => { e.stopPropagation(); exp.photo_urls?.length && openAlbum(exp.photo_urls); }}>
                            {exp.photo_urls && exp.photo_urls.length > 0 ? (
                              <><img src={`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/travel-images/${exp.photo_urls[0]}`} className="w-full h-full object-cover" alt="receipt" />{exp.photo_urls.length > 1 && <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-[8px] font-black text-white">+{exp.photo_urls.length}</div>}</>
                            ) : (
                              <div className="bg-slate-50 dark:bg-slate-800/50 w-full h-full flex items-center justify-center text-slate-400">{exp.is_settlement ? <HandCoins size={20} /> : <Receipt size={20} />}</div>
                            )}
                          </div>
                          
                          <div className="flex-1 min-w-0 pr-10">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`px-1.5 py-0.5 text-[9px] sm:text-[10px] font-black rounded uppercase tracking-wider ${getCategoryColor(exp.category, trip?.categories)}`}>
                                {exp.category}
                              </span>
                              {exp.is_settlement && <span className="text-[9px] font-black text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">SETTLEMENT</span>}
                            </div>
                            <h4 className={`text-xs sm:text-base font-black truncate ${exp.is_settlement ? 'text-emerald-700' : 'text-slate-900 dark:text-white'}`}>
                              {exp.description}
                            </h4>
                            <div className="flex items-center gap-2 mt-1">
                              <div className="flex flex-col">
                                <span className={`text-sm sm:text-lg font-black ${exp.is_settlement ? 'text-emerald-600' : 'text-slate-900 dark:text-white'}`}>
                                  <span className="text-[8px] sm:text-xs mr-0.5 opacity-50 font-bold">{exp.currency}</span>
                                  {fmt(exp.amount, exp.currency, trip?.precision_config)}
                                </span>
                                {currentUser && exp.split_data[currentUser] !== undefined && !exp.is_settlement && (
                                  <span className="text-[10px] sm:text-xs font-bold text-blue-600 dark:text-blue-400 mt-0.5">
                                    {currentUser} 花費 {fmt(exp.split_data[currentUser], exp.currency, trip?.precision_config)} {exp.currency}
                                  </span>
                                )}
                              </div>
                              <div className="h-3 w-px bg-slate-200 dark:bg-slate-800 mx-1" />
                              <span className="text-[9px] sm:text-xs text-slate-500 font-bold truncate">
                                <span className="text-emerald-600">
                                  {Object.entries(exp.payer_data).filter(([, val]) => val !== 0).map(([name]) => name).join(', ')}
                                </span>
                                {exp.is_settlement ? ' ➡️ ' : ' 付 '}
                                <span className="text-blue-600">
                                  {exp.is_settlement 
                                    ? Object.entries(exp.split_data).filter(([, val]) => val !== 0).map(([name]) => name).join(', ') 
                                    : ''}
                                </span>
                              </span>
                            </div>
                          </div>

                          {!trip?.is_archived && !exp.is_settlement && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 sm:gap-1.5">
                              <button onClick={e => { e.stopPropagation(); handleEditExpense(exp); }} className="p-1.5 sm:p-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 hover:bg-blue-600 hover:text-white transition-all shadow-sm">
                                <Edit2 className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                              </button>
                              <button onClick={e => { e.stopPropagation(); setDeleteConfirmId(exp.id); }} className="p-1.5 sm:p-2 rounded-lg bg-rose-50 dark:bg-rose-900/20 text-rose-400 dark:text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-sm">
                                <Trash2 className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'recycle' && (
            <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <h2 className="text-xl sm:text-3xl font-black text-rose-600 tracking-tight flex items-center gap-4"><RotateCcw size={24} />垃圾桶</h2>
                <div className="flex items-center gap-2 sm:gap-4">
                  <div className="hidden sm:flex items-center gap-2 bg-rose-50 dark:bg-rose-900/10 px-4 py-2 rounded-xl text-rose-600 dark:text-rose-400 text-xs font-black">
                    <AlertTriangle size={18} />
                    <span>僅顯示 24 小時內刪除的紀錄</span>
                  </div>
                  <button 
                    onClick={() => setIsEmptyTrashConfirmOpen(true)}
                    disabled={deletedExpenses.length === 0}
                    className="flex items-center gap-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 text-white font-black px-4 py-2 sm:px-6 sm:py-3 rounded-xl transition-all shadow-lg shadow-rose-500/20 active:scale-95 text-xs sm:text-sm"
                  >
                    <Trash2 size={16} />
                    <span>清空垃圾桶</span>
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 md:gap-6">
                {deletedExpenses.map(exp => (
                  <div key={exp.id} className="bg-white/60 dark:bg-slate-900/40 p-4 sm:p-8 rounded-3xl border border-rose-100 dark:border-rose-900/30 flex items-center gap-4 sm:gap-8 relative grayscale group hover:grayscale-0 transition-all">
                    <div className="w-12 h-12 sm:w-24 sm:h-24 bg-slate-100 dark:bg-slate-800 rounded-2xl flex items-center justify-center text-slate-400 shrink-0">
                      <Receipt size={32} />
                    </div>
                    <div className="flex-1 min-w-0 pr-16 sm:pr-40">
                      <h4 className="text-sm sm:text-xl font-black text-slate-500 line-through truncate">{exp.description}</h4>
                      <p className="text-[10px] sm:text-xs text-slate-400 mt-2 font-bold">刪除於: {new Date(exp.deleted_at!).toLocaleString()}</p>
                    </div>
                    <div className="absolute right-4 sm:right-8 top-1/2 -translate-y-1/2 flex flex-col sm:flex-row gap-2">
                      <button 
                        onClick={() => handleRestoreExpense(exp.id)} 
                        className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black px-3 py-2 sm:px-6 sm:py-3 rounded-xl sm:rounded-2xl transition-all shadow-xl active:scale-95 text-[10px] sm:text-sm"
                      >
                        <RotateCcw size={14} className="sm:w-4 sm:h-4" />
                        <span>還原</span>
                      </button>
                      <button 
                        onClick={() => setPermDeleteConfirmId(exp.id)} 
                        className="flex items-center justify-center gap-2 bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 hover:bg-rose-600 hover:text-white font-black px-3 py-2 sm:px-4 sm:py-3 rounded-xl sm:rounded-2xl transition-all border border-rose-200 dark:border-rose-900/50 active:scale-95 text-[10px] sm:text-sm"
                      >
                        <Trash2 size={14} className="sm:w-4 sm:h-4" />
                        <span className="hidden sm:inline">永久刪除</span>
                      </button>
                    </div>
                  </div>
                ))}
                {deletedExpenses.length === 0 && (
                  <div className="py-20 text-center text-slate-400 font-black border-2 border-dashed border-slate-100 dark:border-slate-800 rounded-3xl">
                    垃圾桶是空的
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'stats' && (
            <div className="space-y-12 sm:space-y-20">
              <h2 className="text-xl sm:text-4xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-4"><BarChart3 className="text-blue-600 w-7 h-7 sm:w-10 sm:h-10" />數據視覺化分析</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 sm:gap-16">

                {/* Category Pie Chart & Details Table */}
                <section className="bg-white dark:bg-slate-900 p-6 sm:p-12 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col">
                  <h3 className="text-sm sm:text-lg font-black text-slate-900 dark:text-white mb-6 uppercase tracking-[0.2em] self-start">消費類別佔比 (總計 {fmt(stats.grandBase.total, trip?.base_currency || 'TWD', trip?.precision_config)})</h3>
                  <div className="flex flex-col items-center gap-5">

                    {/* Chart Area — no built-in Legend */}
                    <div className="w-full max-w-[480px] h-[280px] sm:h-[340px] shrink-0">
                      {stats.categoryData.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={stats.categoryData} cx="50%" cy="50%" innerRadius="38%" outerRadius="56%" paddingAngle={4} dataKey="value" stroke="none">
                              {stats.categoryData.map((_, idx) => (<Cell key={`c-${idx}`} fill={COLORS[idx % COLORS.length]} />))}
                              <LabelList dataKey="value" position="outside" offset={10} formatter={(v: any) => typeof v === 'number' ? fmt(v, '', trip?.precision_config) : ''} style={{ fontSize: '10px', fontWeight: '900', fill: '#1e293b' }} />
                            </Pie>
                            <Tooltip contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)' }} formatter={(v: any) => [fmt(Number(v), trip?.base_currency, trip?.precision_config), '金額']} />
                          </PieChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-400 font-black border-2 border-dashed border-slate-100 rounded-3xl">
                          暫無消費數據
                        </div>
                      )}
                    </div>

                    {/* Custom Legend — 2-column grid */}
                    {stats.categoryData.length > 0 && (
                      <div className="w-full grid grid-cols-2 gap-x-6 gap-y-1.5 px-1">
                        {stats.categoryData.map((cat, idx) => (
                          <div key={cat.name} className="flex items-center gap-2 min-w-0">
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 truncate">{cat.name}</span>
                            <span className="text-[11px] font-black text-slate-400 ml-auto shrink-0">{((cat.value / stats.grandBase.total) * 100).toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Table Area — compact rows, expandable */}
                    {stats.categoryData.length > 0 && (
                      <div className="w-full border-t border-slate-100 dark:border-slate-800 pt-2">
                        {stats.categoryData.map((cat, idx) => {
                          const isExpanded = expandedCatStats.has(cat.name);
                          const catExpenses = expenses
                            .filter(e => !e.is_settlement && e.category === cat.name)
                            .sort((a, b) => b.date.localeCompare(a.date));
                          return (
                            <div key={cat.name} className="border-b border-slate-50 dark:border-slate-800 last:border-b-0">
                              <button
                                onClick={() => setExpandedCatStats(prev => {
                                  const next = new Set(prev);
                                  next.has(cat.name) ? next.delete(cat.name) : next.add(cat.name);
                                  return next;
                                })}
                                className="flex items-center justify-between py-1.5 px-2 w-full hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-lg transition-all"
                              >
                                <div className="flex items-center gap-2.5">
                                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                                  <span className="text-xs sm:text-sm font-black text-slate-700 dark:text-slate-300">{cat.name}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs sm:text-sm font-black text-slate-900 dark:text-white">{fmt(cat.value, trip?.base_currency || 'TWD', trip?.precision_config)}</span>
                                  <span className="text-[10px] text-slate-400 font-bold w-8 text-right">{((cat.value / stats.grandBase.total) * 100).toFixed(1)}%</span>
                                  <ChevronRight size={12} className={`text-slate-300 transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
                                </div>
                              </button>
                              {isExpanded && (
                                <div className="ml-5 mb-1.5 mt-0.5 space-y-0.5">
                                  {catExpenses.length === 0 ? (
                                    <p className="text-[11px] text-slate-400 px-2 py-1">無資料</p>
                                  ) : catExpenses.map(e => (
                                    <div key={e.id} className="flex items-center justify-between text-[11px] py-1 px-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-lg">
                                      <div className="flex items-center gap-2 min-w-0 flex-1">
                                        <span className="text-slate-400 shrink-0 tabular-nums">{e.date.slice(5)}</span>
                                        <span className="font-bold text-slate-600 dark:text-slate-400 truncate">{e.description}</span>
                                      </div>
                                      <span className="font-black text-slate-700 dark:text-slate-300 shrink-0 ml-3 tabular-nums">
                                        {e.currency} {formatAmount(e.amount, e.currency, trip?.precision_config || {})}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>

                {/* Member Details Table — compact + expandable */}
                <section className="bg-white dark:bg-slate-900 p-6 sm:p-12 rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
                  <h3 className="text-sm sm:text-lg font-black text-slate-900 dark:text-white mb-6 uppercase tracking-[0.2em]">個人消費明細表 ({trip?.base_currency})</h3>
                  <div className="space-y-5 max-h-[600px] overflow-y-auto no-scrollbar pr-2">
                    {Object.entries(stats.memberDetails).map(([name, data]) => (
                      <div key={name} className="space-y-0.5">
                        <div className="flex items-center justify-between border-b-2 border-slate-100 dark:border-slate-800 pb-1.5 mb-1">
                          <span className="text-sm sm:text-base font-black text-blue-600">{name}</span>
                          <span className="text-xs sm:text-sm font-black text-slate-900 dark:text-white">總額: {fmt(data.totalOwed, trip?.base_currency || 'TWD', trip?.precision_config)} {trip?.base_currency}</span>
                        </div>
                        {Object.entries(data.categories)
                          .filter(([, val]) => val !== 0)
                          .sort(([, a], [, b]) => b - a)
                          .map(([cat, val]) => {
                            const key = `${name}::${cat}`;
                            const isExpanded = expandedMemberCatStats.has(key);
                            const memberCatExpenses = expenses
                              .filter(e => !e.is_settlement && e.category === cat && (Number(e.split_data[name]) || 0) > 0)
                              .sort((a, b) => b.date.localeCompare(a.date));
                            return (
                              <div key={cat} className="border-b border-slate-50 dark:border-slate-800 last:border-b-0">
                                <button
                                  onClick={() => setExpandedMemberCatStats(prev => {
                                    const next = new Set(prev);
                                    next.has(key) ? next.delete(key) : next.add(key);
                                    return next;
                                  })}
                                  className="flex items-center justify-between text-xs font-black text-slate-700 dark:text-slate-300 py-1 px-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors w-full"
                                >
                                  <span className="truncate text-left">{cat}</span>
                                  <div className="flex items-center gap-2 shrink-0 ml-2">
                                    <span className="tabular-nums">{fmt(val, trip?.base_currency || 'TWD', trip?.precision_config)}</span>
                                    <span className="text-[10px] text-slate-400 w-9 text-right tabular-nums">({((val / data.totalOwed) * 100).toFixed(0)}%)</span>
                                    <ChevronRight size={11} className={`text-slate-300 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
                                  </div>
                                </button>
                                {isExpanded && (
                                  <div className="ml-2 mb-1 mt-0.5 space-y-0.5">
                                    {memberCatExpenses.length === 0 ? (
                                      <p className="text-[11px] text-slate-400 px-2 py-1">無資料</p>
                                    ) : memberCatExpenses.map(e => (
                                      <div key={e.id} className="flex items-center justify-between text-[11px] py-1 px-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-lg">
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                          <span className="text-slate-400 shrink-0 tabular-nums">{e.date.slice(5)}</span>
                                          <span className="font-bold text-slate-600 dark:text-slate-400 truncate">{e.description}</span>
                                        </div>
                                        <span className="font-black text-slate-700 dark:text-slate-300 shrink-0 ml-3 tabular-nums">
                                          {e.currency} {formatAmount(Number(e.split_data[name]) || 0, e.currency, trip?.precision_config || {})}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    ))}
                  </div>
                </section>

              </div>
            </div>
          )}

          {activeTab === 'settlement' && (
            <div className="space-y-10 sm:space-y-16 animate-in fade-in duration-500">
              <h2 className="text-xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-4"><HandCoins className="text-blue-600 w-6 h-6 sm:w-8 sm:h-8" />結清指南</h2>
              <section className="bg-white dark:bg-slate-900 p-3 sm:p-12 rounded-[2.5rem] border border-slate-100 shadow-sm">
                <div className="flex items-center justify-between mb-10 px-2 sm:px-0">
                  <h3 className="text-base sm:text-2xl font-black text-slate-900 dark:text-white flex items-center gap-4"><Scale className="text-blue-600" size={28} />結算試算建議</h3>
                  <div className="flex items-center gap-4">
                    {!trip?.is_archived && (
                      <button 
                        onClick={handleOpenManualSettle}
                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-black px-4 py-2 rounded-xl transition-all shadow-lg active:scale-95 text-xs"
                      >
                        <Plus size={14} strokeWidth={3} />
                        <span>手動新增結清</span>
                      </button>
                    )}
                    <p className="hidden sm:block text-xs text-slate-500 font-black uppercase tracking-widest">點擊圖示一鍵新增結清紀錄</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-10">
                  {Object.entries(stats.balances).map(([cur, memberBalances]) => {
                    const settlements = calculateSettlements(memberBalances);
                    if (settlements.length === 0) return null;

                    const isGrand = cur === 'GRAND_TOTAL';
                    const currencyCount = Object.keys(stats.balances).filter(k => k !== 'GRAND_TOTAL').length;
                    if (!isGrand && currencyCount === 1) return null;

                    // When grand total is already settled, per-currency imbalances cancel out
                    // in aggregate (e.g. owe 5000 JPY but are owed equivalent TWD) — no action needed.
                    const grandIsSettled = calculateSettlements(stats.balances['GRAND_TOTAL']).length === 0;
                    if (!isGrand && grandIsSettled) return null;

                    const curName = isGrand ? trip?.base_currency : cur;
                    return (
                      <div key={cur} className={`p-4 sm:p-10 rounded-[2rem] border-2 transition-all ${isGrand ? 'bg-blue-50/50 dark:bg-blue-900/10 border-blue-200' : 'bg-slate-50 dark:bg-slate-800/50 border-slate-100'}`}>
                        <h4 className={`text-[10px] sm:text-sm font-black px-4 py-1.5 rounded-full inline-block uppercase tracking-[0.2em] mb-8 ${isGrand ? 'bg-blue-600 text-white shadow-md' : 'bg-slate-700 text-white'}`}>{isGrand ? `總結算 (折合 ${trip?.base_currency})` : `${cur} 獨立結算`}</h4>
                        <div className="space-y-4">
                          {settlements.map((s, idx) => (
                            <div key={idx} className="flex items-center justify-between p-3 sm:p-4 bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-50 dark:border-slate-800">
                              <div className="flex items-center gap-2 sm:gap-4 text-sm sm:text-xl font-black min-w-0 flex-1">
                                <span className="text-slate-800 dark:text-slate-200 truncate">{s.from}</span>
                                <ChevronRight size={18} className="text-slate-300 shrink-0" />
                                <span className="text-slate-900 dark:text-white truncate">{s.to}</span>
                              </div>
                              <div className="flex items-center gap-3 sm:gap-8 ml-2 shrink-0">
                                <span className={`text-sm sm:text-2xl font-black ${isGrand ? 'text-blue-600' : 'text-slate-900 dark:text-white'}`}>{fmt(s.amount, curName, trip?.precision_config)}</span>
                                {!trip?.is_archived && (<button onClick={() => setSettleConfirm({ from: s.from, to: s.to, amount: s.amount, cur: curName || '' })} className="p-2 sm:p-3 rounded-xl bg-blue-600 text-white shadow-lg active:scale-90 transition-all hover:bg-blue-700"><HandCoins className="w-4 h-4 sm:w-5 sm:h-5" /></button>)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {calculateSettlements(stats.balances['GRAND_TOTAL'] ?? {}).length === 0 && (<div className="py-20 text-center text-slate-400 font-black">目前一切都已結清。</div>)}
              </section>

              {/* Settlement History */}
              {(() => {
                const settlementRecords = expenses
                  .filter(e => e.is_settlement)
                  .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
                if (settlementRecords.length === 0) return null;
                return (
                  <section className="bg-white dark:bg-slate-900 p-4 sm:p-12 rounded-[2.5rem] border border-slate-100 shadow-sm">
                    <h3 className="text-base sm:text-2xl font-black text-slate-900 dark:text-white mb-6 flex items-center gap-3">
                      <Check size={20} className="text-emerald-600" />結清記錄
                    </h3>
                    <div className="space-y-2">
                      {settlementRecords.map(sr => {
                        const from = Object.entries(sr.payer_data).filter(([, v]) => v !== 0).map(([n]) => n).join(', ');
                        const to = Object.entries(sr.split_data).filter(([, v]) => v !== 0).map(([n]) => n).join(', ');
                        return (
                          <div key={sr.id} className="flex items-center gap-3 sm:gap-6 p-3 sm:p-4 bg-emerald-50/40 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-900/30">
                            <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl flex items-center justify-center text-emerald-600 shrink-0">
                              <HandCoins size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 text-sm font-black text-slate-700 dark:text-slate-300">
                                <span className="text-emerald-600 truncate">{from}</span>
                                <ChevronRight size={14} className="text-slate-300 shrink-0" />
                                <span className="truncate">{to}</span>
                              </div>
                              <p className="text-[10px] text-slate-400 font-bold mt-0.5">{sr.date}</p>
                            </div>
                            <span className="text-sm sm:text-base font-black text-emerald-600 shrink-0 tabular-nums">
                              {sr.currency} {formatAmount(sr.amount, sr.currency, trip?.precision_config || {})}
                            </span>
                            {!trip?.is_archived && (
                              <div className="flex gap-1 shrink-0">
                                <button
                                  onClick={() => handleEditExpense(sr)}
                                  className="p-1.5 rounded-lg bg-white dark:bg-slate-800 text-slate-400 hover:bg-blue-600 hover:text-white transition-all border border-slate-100 dark:border-slate-700"
                                >
                                  <Edit2 size={13} />
                                </button>
                                <button
                                  onClick={() => setDeleteConfirmId(sr.id)}
                                  className="p-1.5 rounded-lg bg-white dark:bg-slate-800 text-slate-400 hover:bg-rose-600 hover:text-white transition-all border border-slate-100 dark:border-slate-700"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })()}
            </div>
          )}

          {activeTab === 'itinerary' && (<div className="animate-in fade-in duration-500">{ItineraryComponent ? <ItineraryComponent /> : <div className="text-center p-20"><p className="text-slate-400 font-bold text-sm sm:text-lg">行程網頁尚未就緒</p></div>}</div>)}
        </div>
      </main>

      {/* Confirmation Modal for Settlement */}
      {settleConfirm && (
        <Modal isOpen={!!settleConfirm} onClose={() => setSettleConfirm(null)} title="確認結清紀錄">
          <div className="py-6 text-center space-y-6">
            <div className="w-20 h-20 bg-emerald-50 dark:bg-emerald-900/20 rounded-full flex items-center justify-center mx-auto text-emerald-600 shadow-inner"><HandCoins size={40} /></div>
            <div className="space-y-2">
              <p className="text-slate-500 font-bold">您即將建立一筆結清紀錄：</p>
              <div className="text-2xl font-black text-slate-900 dark:text-white flex items-center justify-center gap-4">
                {settleConfirm.from} <ChevronRight className="text-slate-300" /> {settleConfirm.to}
              </div>
              <p className="text-3xl font-black text-blue-600">{fmt(settleConfirm.amount, settleConfirm.cur, trip?.precision_config)} <span className="text-sm opacity-60">{settleConfirm.cur}</span></p>
            </div>
            <div className="flex gap-4 pt-4">
              <button onClick={() => setSettleConfirm(null)} className="flex-1 px-6 py-4 rounded-2xl bg-slate-100 text-slate-500 font-black hover:bg-slate-200 transition-all">取消</button>
              <button onClick={confirmSettleUp} className="flex-1 px-6 py-4 rounded-2xl bg-blue-600 text-white font-black shadow-xl shadow-blue-500/20 hover:bg-blue-700 transition-all flex items-center justify-center gap-2"><Check size={20} strokeWidth={3} />確認結清</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Manual Settlement Modal */}
      {isManualSettleOpen && trip && (
        <Modal isOpen={isManualSettleOpen} onClose={() => setIsManualSettleOpen(false)} title="手動新增結清紀錄">
          <div className="py-4 space-y-6">
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">付款人 (誰給錢)</label>
                <select 
                  className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 font-bold text-sm outline-none border-2 border-transparent focus:border-blue-600"
                  value={manualSettleFrom}
                  onChange={e => setManualSettleFrom(e.target.value)}
                >
                  {trip.members.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="flex justify-center -my-2 relative z-10">
                <div className="bg-white dark:bg-slate-800 p-1 rounded-full border border-slate-100 dark:border-slate-700">
                  <ChevronRight className="text-slate-300 rotate-90" size={20} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">收款人 (誰收錢)</label>
                <select 
                  className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 font-bold text-sm outline-none border-2 border-transparent focus:border-blue-600"
                  value={manualSettleTo}
                  onChange={e => setManualSettleTo(e.target.value)}
                >
                  {trip.members.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">金額與幣別</label>
                <div className="flex gap-2">
                  <select 
                    className="w-24 px-3 py-3 rounded-xl bg-slate-100 dark:bg-slate-800 font-bold text-xs outline-none appearance-none"
                    value={manualSettleCurrency}
                    onChange={e => setManualSettleCurrency(e.target.value)}
                  >
                    {Object.keys(trip.rates).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input 
                    type="number" 
                    step="any"
                    placeholder="0.00"
                    className="flex-1 px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 outline-none transition-all font-black text-lg"
                    value={manualSettleAmount}
                    onChange={e => setManualSettleAmount(e.target.value)}
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-4 pt-4">
              <button onClick={() => setIsManualSettleOpen(false)} className="flex-1 px-6 py-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 font-black hover:bg-slate-200 transition-all">取消</button>
              <button onClick={submitManualSettle} className="flex-1 px-6 py-4 rounded-2xl bg-blue-600 text-white font-black shadow-xl shadow-blue-500/20 hover:bg-blue-700 transition-all">下一步</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Mobile Nav */}
      <div className="md:hidden fixed bottom-2 left-6 right-6 z-40">
        <div className="bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-2xl text-white rounded-[2.5rem] p-2 shadow-2xl flex justify-around items-center border border-white/10 ring-1 ring-black/20">
          <button onClick={() => setActiveTab('itinerary')} className={`flex flex-col items-center py-2 flex-1 transition-all ${activeTab === 'itinerary' ? 'text-blue-400' : 'text-slate-500'} ${!showItineraryTab ? 'hidden' : ''}`}>
            <Map size={20} strokeWidth={activeTab === 'itinerary' ? 3 : 2} />
            <span className="text-[9px] font-black mt-1 uppercase tracking-wider">行程</span>
          </button>
          
          <button onClick={() => setActiveTab('ledger')} className={`flex flex-col items-center py-2 flex-1 transition-all ${activeTab === 'ledger' ? 'text-blue-400' : 'text-slate-500'}`}>
            <Receipt size={20} strokeWidth={activeTab === 'ledger' ? 3 : 2} />
            <span className="text-[9px] font-black mt-1 uppercase tracking-wider">支出</span>
          </button>
          
          {!trip?.is_archived && (
            <button onClick={() => setIsExpenseModalOpen(true)} className="flex flex-col items-center px-1 flex-1">
              <div className="bg-blue-600 w-12 h-12 rounded-2xl shadow-lg shadow-blue-600/40 flex items-center justify-center active:scale-90 transition-transform">
                <Plus size={28} strokeWidth={3} className="text-white" />
              </div>
            </button>
          )}
          
          <button onClick={() => setActiveTab('stats')} className={`flex flex-col items-center py-2 flex-1 transition-all ${activeTab === 'stats' ? 'text-blue-400' : 'text-slate-500'}`}>
            <PieChartIcon size={20} strokeWidth={activeTab === 'stats' ? 3 : 2} />
            <span className="text-[9px] font-black mt-1 uppercase tracking-wider">統計</span>
          </button>
          
          <button onClick={() => setActiveTab('settlement')} className={`flex flex-col items-center py-2 flex-1 transition-all ${activeTab === 'settlement' ? 'text-blue-400' : 'text-slate-500'}`}>
            <HandCoins size={20} strokeWidth={activeTab === 'settlement' ? 3 : 2} />
            <span className="text-[9px] font-black mt-1 uppercase tracking-wider">結清</span>
          </button>
        </div>
      </div>

      {trip && (<ExpenseModal isOpen={isExpenseModalOpen} onClose={closeExpenseModal} trip={trip} currentUser={currentUser} onSuccess={() => { fetchExpenses(); }} showToast={showToast} editData={editingExpense} />)}
      {trip && (<SettingsModal isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} trip={trip} onSuccess={() => { fetchTripData(); showToast('設定已更新'); }} expenses={expenses} />)}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <Modal isOpen={!!deleteConfirmId} onClose={() => setDeleteConfirmId(null)} title="確認刪除紀錄">
          <div className="py-6 text-center space-y-6">
            <div className="w-20 h-20 bg-rose-50 dark:bg-rose-900/20 rounded-full flex items-center justify-center mx-auto text-rose-600 shadow-inner"><Trash2 size={40} /></div>
            <div className="space-y-2">
              <p className="text-xl font-black text-slate-900 dark:text-white">確定要刪除這筆紀錄嗎？</p>
              <p className="text-sm text-slate-500 font-bold">刪除後紀錄會移至垃圾桶，24 小時內可還原。</p>
            </div>
            <div className="flex gap-4 pt-4">
              <button onClick={() => setDeleteConfirmId(null)} className="flex-1 px-6 py-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 font-black hover:bg-slate-200 transition-all">取消</button>
              <button onClick={handleDeleteExpense} className="flex-1 px-6 py-4 rounded-2xl bg-rose-500 text-white font-black shadow-xl shadow-rose-500/20 hover:bg-rose-600 transition-all flex items-center justify-center gap-2">確認刪除</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Welcome Identity Selector Modal */}
      {trip && (
        <Modal 
          isOpen={isWelcomeSelectorOpen} 
          onClose={() => setIsWelcomeSelectorOpen(false)} 
          title="👋 歡迎回來！"
        >
          <div className="py-4 space-y-6 text-center">
            <div className="w-16 h-16 bg-blue-50 dark:bg-blue-900/20 rounded-2xl flex items-center justify-center mx-auto text-blue-600">
              <User size={32} />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-black text-slate-900 dark:text-white">請選擇您的身分</h3>
              <p className="text-sm text-slate-500 font-bold leading-relaxed">
                選定身分後，系統將為您高亮顯示<br/>個人的分帳與墊付資訊。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2">
              {trip.members.map(member => (
                <button
                  key={member}
                  onClick={() => handleSetCurrentUser(member)}
                  className="px-4 py-4 rounded-2xl border-2 border-slate-100 dark:border-slate-800 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all group"
                >
                  <div className="text-base font-black text-slate-700 dark:text-slate-300 group-hover:text-blue-600 transition-colors">
                    {member}
                  </div>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-slate-400 font-bold">
              之後隨時可以從右上角選單更改。
            </p>
          </div>
        </Modal>
      )}

      {/* Permanent Delete Confirmation Modal */}
      {permDeleteConfirmId && (
        <Modal isOpen={!!permDeleteConfirmId} onClose={() => setPermDeleteConfirmId(null)} title="永久刪除紀錄">
          <div className="py-6 text-center space-y-6">
            <div className="w-20 h-20 bg-rose-50 dark:bg-rose-900/20 rounded-full flex items-center justify-center mx-auto text-rose-600 shadow-inner">
              <AlertTriangle size={40} />
            </div>
            <div className="space-y-2">
              <p className="text-xl font-black text-slate-900 dark:text-white">確定要永久刪除嗎？</p>
              <p className="text-sm text-rose-500 font-bold">此動作將無法復原，該筆支出將永久消失。</p>
            </div>
            <div className="flex gap-4 pt-4">
              <button onClick={() => setPermDeleteConfirmId(null)} className="flex-1 px-6 py-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 font-black hover:bg-slate-200 transition-all">取消</button>
              <button onClick={handlePermanentlyDeleteExpense} className="flex-1 px-6 py-4 rounded-2xl bg-rose-600 text-white font-black shadow-xl shadow-rose-500/20 hover:bg-rose-700 transition-all">永久刪除</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Empty Trash Confirmation Modal */}
      {isEmptyTrashConfirmOpen && (
        <Modal isOpen={isEmptyTrashConfirmOpen} onClose={() => setIsEmptyTrashConfirmOpen(false)} title="清空垃圾桶">
          <div className="py-6 text-center space-y-6">
            <div className="w-20 h-20 bg-rose-600 rounded-full flex items-center justify-center mx-auto text-white shadow-xl shadow-rose-500/30">
              <Trash2 size={40} />
            </div>
            <div className="space-y-2">
              <p className="text-xl font-black text-slate-900 dark:text-white">確定要清空垃圾桶嗎？</p>
              <p className="text-sm text-rose-600 font-black px-4 py-2 bg-rose-50 dark:bg-rose-900/20 rounded-xl">警告：所有垃圾桶內的紀錄將會永久刪除且無法復原。</p>
            </div>
            <div className="flex gap-4 pt-4">
              <button onClick={() => setIsEmptyTrashConfirmOpen(false)} className="flex-1 px-6 py-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 font-black hover:bg-slate-200 transition-all">取消</button>
              <button onClick={handleEmptyTrash} className="flex-1 px-6 py-4 rounded-2xl bg-rose-600 text-white font-black shadow-xl shadow-rose-500/20 hover:bg-rose-700 transition-all">確認清空</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-4 duration-300">
          <div className={`px-6 py-3 rounded-full shadow-2xl border flex items-center gap-3 font-black text-sm ${toast.type === 'success' ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-rose-500 text-white border-rose-400'}`}>
            {toast.type === 'success' ? <Check size={18} strokeWidth={3} /> : <AlertTriangle size={18} strokeWidth={3} />}
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
