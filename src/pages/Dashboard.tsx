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
  Tooltip, Legend, 
  ResponsiveContainer,
  LabelList
} from 'recharts';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { hasItinerary, getItineraryComponent } from '../features/itinerary/registry';
import ExpenseModal from '../components/ExpenseModal';
import SettingsModal from '../components/SettingsModal';
import Modal from '../components/Modal';
import { formatAmount } from '../utils/finance';

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
  const [isMounted, setIsMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('ledger');
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [isUserSelectorOpen, setIsUserSelectorOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [previewAlbum, setPreviewAlbum] = useState<string[] | null>(null);
  const [currentPhotoIdx, setCurrentPhotoIdx] = useState(0);

  // Settlement Confirmation State
  const [settleConfirm, setSettleConfirm] = useState<{ from: string, to: string, amount: number, cur: string } | null>(null);

  useEffect(() => {
    setIsMounted(true);
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
    if (savedUser) setCurrentUser(savedUser);
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
      const validDeleted = (data || []).filter((exp: Expense) => {
        if (!exp.deleted_at) return false;
        const deletedTime = new Date(exp.deleted_at);
        const hoursDiff = (now.getTime() - deletedTime.getTime()) / (1000 * 60 * 60);
        return hoursDiff <= 24;
      });
      setDeletedExpenses(validDeleted);
    } catch (err) { console.error(err); }
  };

  const handleDeleteExpense = async (expenseId: string) => {
    if (!window.confirm('確定要將此紀錄移至垃圾桶嗎？')) return;
    if (!supabase) return;
    try {
      const { error } = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', expenseId);
      if (error) throw error;
    } catch (err: any) { alert('刪除失敗: ' + err.message); }
  };

  const handleRestoreExpense = async (expenseId: string) => {
    if (!supabase) return;
    try {
      const { error } = await supabase.from('expenses').update({ deleted_at: null }).eq('id', expenseId);
      if (error) throw error;
      alert('紀錄已從垃圾桶還原！');
    } catch (err: any) { alert('還原失敗: ' + err.message); }
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
  };

  const filteredExpenses = useMemo(() => {
    if (!searchQuery.trim()) return expenses;
    const q = searchQuery.toLowerCase();
    return expenses.filter(e => 
      e.description.toLowerCase().includes(q) || e.category.toLowerCase().includes(q) ||
      Object.keys(e.payer_data).some(p => p.toLowerCase().includes(q))
    );
  }, [expenses, searchQuery]);

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
    expenses.filter(e => !e.is_settlement).forEach(e => {
      const rate = trip.rates[e.currency] || 1;
      const amountInBase = e.amount * rate;
      if (!byCurrency[e.currency]) {
        byCurrency[e.currency] = { total: 0, paidByMe: 0, owedByMe: 0 };
        balances[e.currency] = {};
        trip.members.forEach(m => balances[e.currency][m] = 0);
      }
      const pMe = currentUser ? (e.payer_data[currentUser] || 0) : 0;
      const oMe = currentUser ? (e.split_data[currentUser] || 0) : 0;
      byCurrency[e.currency].total += e.amount;
      byCurrency[e.currency].paidByMe += pMe;
      byCurrency[e.currency].owedByMe += oMe;
      grandBase.total += amountInBase;
      grandBase.paidByMe += (pMe * rate);
      grandBase.owedByMe += (oMe * rate);
      categoryMap[e.category] = (categoryMap[e.category] || 0) + amountInBase;
      trip.members.forEach(m => {
        const paid = e.payer_data[m] || 0;
        const owed = e.split_data[m] || 0;
        const owedInBase = owed * rate;
        memberDetails[m].totalOwed += owedInBase;
        memberDetails[m].categories[e.category] = (memberDetails[m].categories[e.category] || 0) + owedInBase;
        balances[e.currency][m] += (paid - owed);
        balances['GRAND_TOTAL'][m] += ((paid - owed) * rate);
      });
    });
    const categoryData = Object.entries(categoryMap).map(([name, value]) => ({ name, value }));
    return { byCurrency, grandBase, categoryData, memberDetails, balances };
  }, [expenses, trip, currentUser]);

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
    const debtors: { name: string, amt: number }[] = [];
    const creditors: { name: string, amt: number }[] = [];
    Object.entries(memberBalances).forEach(([name, bal]) => {
      if (bal < -0.01) debtors.push({ name, amt: -bal });
      else if (bal > 0.01) creditors.push({ name, amt: bal });
    });
    debtors.sort((a, b) => b.amt - a.amt); creditors.sort((a, b) => b.amt - a.amt);
    const result: { from: string, to: string, amount: number }[] = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const minAmt = Math.min(debtors[i].amt, creditors[j].amt);
      result.push({ from: debtors[i].name, to: creditors[j].name, amount: minAmt });
      debtors[i].amt -= minAmt; creditors[j].amt -= minAmt;
      if (debtors[i].amt < 0.01) i++; if (creditors[j].amt < 0.01) j++;
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
    } catch (err: any) { alert('結清失敗: ' + err.message); }
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
              <p className="text-[9px] sm:text-[10px] font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5">總支出 ({trip?.base_currency})</p>
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
              <p className="text-[9px] sm:text-[10px] font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5">成員 ({trip?.members.length})</p>
              <div className="flex flex-wrap gap-1 mt-0.5">{trip?.members.map(m => (<span key={m} className={`px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-black uppercase ${m === currentUser ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-300'}`}>{m}</span>))}</div>
            </div>
          </div>

          {/* Card 3: Paid by Me */}
          <div className={`py-3 px-4 sm:px-6 rounded-2xl sm:rounded-[2rem] border transition-all flex items-center gap-3 sm:gap-4 ${currentUser ? 'bg-emerald-50/30 border-emerald-100 dark:bg-emerald-900/10' : 'bg-white dark:bg-slate-900 shadow-sm'}`}>
            <div className={`w-8 h-8 sm:w-12 sm:h-12 rounded-lg sm:rounded-2xl flex items-center justify-center shrink-0 ${currentUser ? 'bg-emerald-500 text-white' : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600'}`}><ArrowUpRight className="w-4 h-4 sm:w-6 sm:h-6" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[9px] sm:text-[10px] font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5 truncate">{currentUser ? `${currentUser} 墊付` : '我墊付'}</p>
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
              <p className="text-[9px] sm:text-[10px] font-black text-slate-900 dark:text-slate-300 uppercase tracking-widest mb-0.5 truncate">{currentUser ? `${currentUser} 應付` : '我應付'}</p>
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
                <div className="relative w-full">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input type="text" placeholder="搜尋描述、類別、成員..." className="w-full pl-11 pr-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl text-sm font-bold outline-none transition-all shadow-sm focus:ring-4 focus:ring-blue-500/5" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
                </div>
              </div>

              {deletedExpenses.length > 0 && (<button onClick={() => setActiveTab('recycle')} className="w-full flex items-center justify-center gap-2 py-2 bg-rose-50 dark:bg-rose-900/10 text-rose-600 dark:text-rose-400 text-[10px] sm:text-xs font-black rounded-xl border border-rose-100 dark:border-rose-900/30 hover:bg-rose-100 transition-all"><RotateCcw size={12} /><span>垃圾桶中有 {deletedExpenses.length} 筆可還原紀錄</span></button>)}
              
              <div className="grid grid-cols-1 gap-4 md:gap-6">
                {filteredExpenses.map(exp => (
                  <div key={exp.id} className={`group p-4 sm:p-8 rounded-3xl border transition-all flex items-start gap-4 sm:gap-8 relative overflow-hidden ${exp.is_settlement ? 'bg-emerald-50/30 dark:bg-emerald-900/10 border-dashed border-emerald-300' : 'bg-white dark:bg-slate-900 border-slate-100 shadow-sm hover:shadow-xl'}`}>
                    <div className={`w-16 h-16 sm:w-24 sm:h-24 bg-slate-50 dark:bg-slate-800 rounded-2xl overflow-hidden shrink-0 flex items-center justify-center border border-slate-100 relative ${exp.photo_urls?.length ? 'cursor-zoom-in' : ''}`} onClick={() => exp.photo_urls?.length && openAlbum(exp.photo_urls)}>
                      {exp.photo_urls && exp.photo_urls.length > 0 ? (<><img src={`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/travel-images/${exp.photo_urls[0]}`} className="w-full h-full object-cover" alt="receipt" />{exp.photo_urls.length > 1 && <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-xs font-black text-white">+{exp.photo_urls.length}</div>}</>) : (<div className="bg-slate-50 dark:bg-slate-800/50 w-full h-full flex items-center justify-center text-slate-400">{exp.is_settlement ? <HandCoins size={32} /> : <Receipt size={32} />}</div>)}
                    </div>
                    <div className="flex-1 min-w-0 pr-12">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2"><span className={`px-2 py-1 text-[10px] sm:text-xs font-black rounded-lg uppercase tracking-widest ${exp.is_settlement ? 'bg-emerald-500 text-white' : 'bg-blue-600 text-white'}`}>{exp.category}</span><span className="text-xs sm:text-sm font-black text-slate-700 dark:text-slate-300">{exp.date}</span></div>
                      <h4 className={`text-sm sm:text-2xl font-black truncate mb-1 ${exp.is_settlement ? 'text-emerald-700' : 'text-slate-900 dark:text-white'}`}>{exp.description}</h4>
                      <div className="flex items-baseline gap-2 mt-2"><span className={`text-base sm:text-3xl font-black ${exp.is_settlement ? 'text-emerald-600' : 'text-slate-900 dark:text-white'}`}><span className="text-[10px] sm:text-lg mr-0.5 opacity-50">{exp.currency}</span>{fmt(exp.amount, exp.currency, trip?.precision_config)}</span><span className="text-[10px] sm:text-sm text-slate-700 dark:text-slate-300 font-black ml-2">由 <span className="text-emerald-600 font-black">{Object.keys(exp.payer_data).join(', ')}</span> {exp.is_settlement ? '結清給' : '支付'} <span className="font-black text-blue-600">{exp.is_settlement ? Object.keys(exp.split_data).join(', ') : ''}</span></span></div>
                    </div>
                    {!trip?.is_archived && !exp.is_settlement && (<div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col gap-3"><button onClick={() => handleDeleteExpense(exp.id)} className="p-3 rounded-xl bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-sm"><Trash2 size={18} /></button><button onClick={() => handleEditExpense(exp)} className="p-3 rounded-xl bg-slate-50 text-slate-500 hover:bg-blue-600 hover:text-white transition-all shadow-sm"><Edit2 size={18} /></button></div>)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'recycle' && (
            <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center justify-between"><h2 className="text-xl sm:text-3xl font-black text-rose-600 tracking-tight flex items-center gap-4"><RotateCcw size={24} />垃圾桶</h2><div className="flex items-center gap-2 bg-rose-50 px-4 py-2 rounded-xl text-rose-600 text-xs sm:text-sm font-black"><AlertTriangle size={18} /><span>僅顯示 24 小時內刪除的紀錄</span></div></div>
              <div className="grid grid-cols-1 gap-4 md:gap-6">{deletedExpenses.map(exp => (<div key={exp.id} className="bg-white/60 p-4 sm:p-8 rounded-3xl border border-rose-100 flex items-center gap-4 sm:gap-8 relative grayscale"><div className="w-16 h-16 sm:w-24 sm:h-24 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-400 shrink-0"><Receipt size={32} /></div><div className="flex-1 min-w-0 pr-24"><h4 className="text-sm sm:text-xl font-black text-slate-500 line-through truncate">{exp.description}</h4><p className="text-xs text-slate-400 mt-2 font-bold">刪除於: {new Date(exp.deleted_at!).toLocaleString()}</p></div><button onClick={() => handleRestoreExpense(exp.id)} className="absolute right-6 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black px-6 py-3 rounded-2xl transition-all shadow-xl active:scale-95">還原</button></div>))}</div>
            </div>
          )}

          {activeTab === 'stats' && (
            <div className="space-y-12 sm:space-y-20">
              <h2 className="text-xl sm:text-4xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-4"><BarChart3 className="text-blue-600 w-7 h-7 sm:w-10 sm:h-10" />數據視覺化分析</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 sm:gap-16">
                {/* Category Pie Chart & Details Table */}
                <section className="bg-white dark:bg-slate-900 p-6 sm:p-12 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col">
                  <h3 className="text-sm sm:text-lg font-black text-slate-900 dark:text-white mb-10 uppercase tracking-[0.2em] self-start">消費類別佔比 (總計 {fmt(stats.grandBase.total, trip?.base_currency || 'TWD', trip?.precision_config)})</h3>
                  <div className="flex flex-col items-center gap-12">
                    {/* Chart Area */}
                    <div className="w-full max-w-[500px] h-[350px] sm:h-[450px] shrink-0">
                      {isMounted && stats.categoryData.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={stats.categoryData} cx="50%" cy="50%" innerRadius="40%" outerRadius="60%" paddingAngle={5} dataKey="value" stroke="none">
                              {stats.categoryData.map((_, idx) => (<Cell key={`c-${idx}`} fill={COLORS[idx % COLORS.length]} />))}
                              <LabelList dataKey="value" position="outside" offset={12} formatter={(v: any) => typeof v === 'number' ? fmt(v, '', trip?.precision_config) : ''} style={{ fontSize: '11px', fontWeight: '900', fill: '#1e293b' }} />
                            </Pie>
                            <Tooltip contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)' }} formatter={(v: any) => [fmt(Number(v), trip?.base_currency, trip?.precision_config), '金額']} />
                            <Legend verticalAlign="bottom" height={36} iconType="circle" />
                          </PieChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-400 font-black border-2 border-dashed border-slate-100 rounded-3xl">
                          {stats.categoryData.length === 0 ? '暫無消費數據' : '圖表載入中...'}
                        </div>
                      )}
                    </div>

                    {/* Table Area */}
                    <div className="w-full space-y-3">
                      <div className="grid grid-cols-1 divide-y divide-slate-50 dark:divide-slate-800 border-t border-slate-50 dark:border-slate-800 pt-6">
                        {stats.categoryData.sort((a, b) => b.value - a.value).map((cat, idx) => (
                          <div key={cat.name} className="flex items-center justify-between py-3 px-2">
                            <div className="flex items-center gap-3"><div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }} /><span className="text-sm font-black text-slate-700 dark:text-slate-300">{cat.name}</span></div>
                            <div className="flex items-baseline gap-3"><span className="text-sm font-black text-slate-900 dark:text-white">{fmt(cat.value, trip?.base_currency || 'TWD', trip?.precision_config)}</span><span className="text-[10px] text-slate-400 font-bold w-10 text-right">{((cat.value / stats.grandBase.total) * 100).toFixed(1)}%</span></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Member Details Table */}
                <section className="bg-white dark:bg-slate-900 p-6 sm:p-12 rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
                  <h3 className="text-sm sm:text-lg font-black text-slate-900 dark:text-white mb-10 uppercase tracking-[0.2em]">個人消費明細表 ({trip?.base_currency})</h3>
                  <div className="space-y-10 max-h-[500px] overflow-y-auto no-scrollbar pr-2">
                    {Object.entries(stats.memberDetails).map(([name, data]) => (
                      <div key={name} className="space-y-4">
                        <div className="flex items-center justify-between border-b-2 border-slate-100 dark:border-slate-800 pb-2">
                          <span className="text-base sm:text-xl font-black text-blue-600">{name}</span>
                          <span className="text-sm sm:text-lg font-black text-slate-900 dark:text-white">總額: {fmt(data.totalOwed, trip?.base_currency || 'TWD', trip?.precision_config)} {trip?.base_currency}</span>
                        </div>
                        <div className="grid grid-cols-1 gap-3">
                          {Object.entries(data.categories).map(([cat, val]) => (
                            <div key={cat} className="flex items-center justify-between text-xs sm:text-base font-black text-slate-700 dark:text-slate-300">
                              <span>{cat}</span>
                              <div className="flex gap-4"><span>{fmt(val, trip?.base_currency || 'TWD', trip?.precision_config)}</span><span className="text-[10px] text-slate-400 w-12 text-right">({((val / data.totalOwed) * 100).toFixed(0)}%)</span></div>
                            </div>
                          ))}
                        </div>
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
                  <p className="hidden sm:block text-xs text-slate-500 font-black uppercase tracking-widest">點擊圖示一鍵新增結清紀錄</p>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-10">
                  {Object.entries(stats.balances).map(([cur, memberBalances]) => {
                    const settlements = calculateSettlements(memberBalances);
                    if (settlements.length === 0) return null;
                    const isGrand = cur === 'GRAND_TOTAL';
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
                {Object.keys(stats.balances).every(cur => calculateSettlements(stats.balances[cur]).length === 0) && (<div className="py-20 text-center text-slate-400 font-black">目前一切都已結清。</div>)}
              </section>
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

      {/* Mobile Nav */}
      <div className="md:hidden fixed bottom-2 left-4 right-4 z-40">
        <div className="bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-xl text-white rounded-[2.5rem] p-2 shadow-2xl flex justify-around items-center border border-white/10">
          <button onClick={() => setActiveTab('itinerary')} className={`flex flex-col items-center p-2.5 flex-1 transition-all ${activeTab === 'itinerary' ? 'text-blue-400 bg-white/5 rounded-xl' : 'opacity-40'} ${!showItineraryTab ? 'hidden' : ''}`}><Map size={18} /><span className="text-[7px] font-bold mt-1 uppercase tracking-tighter">行程</span></button>
          <button onClick={() => setActiveTab('ledger')} className={`flex flex-col items-center p-2.5 flex-1 transition-all ${activeTab === 'ledger' ? 'text-blue-400 bg-white/5 rounded-xl' : 'opacity-40'}`}><Receipt size={18} /><span className="text-[7px] font-bold mt-1 uppercase tracking-tighter">支出</span></button>
          {!trip?.is_archived && (<button onClick={() => setIsExpenseModalOpen(true)} className="flex flex-col items-center p-2 flex-1 text-white"><div className="bg-blue-600 p-2.5 rounded-lg shadow-lg"><Plus size={18} strokeWidth={3} /></div></button>)}
          <button onClick={() => setActiveTab('stats')} className={`flex flex-col items-center p-2.5 flex-1 transition-all ${activeTab === 'stats' ? 'text-blue-400 bg-white/5 rounded-xl' : 'opacity-40'}`}><PieChartIcon size={18} /><span className="text-[7px] font-bold mt-1 uppercase tracking-tighter">統計</span></button>
          <button onClick={() => setActiveTab('settlement')} className={`flex flex-col items-center p-2.5 flex-1 transition-all ${activeTab === 'settlement' ? 'text-blue-400 bg-white/5 rounded-xl' : 'opacity-40'}`}><HandCoins size={18} /><span className="text-[7px] font-bold mt-1 uppercase tracking-tighter">結清</span></button>
        </div>
      </div>

      {trip && (<ExpenseModal isOpen={isExpenseModalOpen} onClose={closeExpenseModal} trip={trip} currentUser={currentUser} onSuccess={() => fetchExpenses()} editData={editingExpense} />)}
      {trip && (<SettingsModal isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} trip={trip} onSuccess={() => fetchTripData()} expenses={expenses} />)}
    </div>
  );
};

export default Dashboard;
