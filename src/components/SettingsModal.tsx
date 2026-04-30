import React, { useState, useEffect } from 'react';
import { 
  X, 
  Save, 
  Trash2, 
  Plus, 
  Users, 
  Globe, 
  Tag, 
  Settings as SettingsIcon, 
  Lock, 
  AlertCircle,
  Loader2,
  ChevronRight,
  Archive,
  Download,
  ShieldCheck,
  Copy,
  Check,
  MessageCircle
} from 'lucide-react';
import Modal from './Modal';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { exportExpensesToCSV } from '../utils/finance';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  trip: Trip;
  onSuccess: () => void;
  expenses: Expense[];
}

type TabType = 'basic' | 'members' | 'finance' | 'categories';

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, trip, onSuccess, expenses }) => {
  const [activeTab, setActiveTab] = useState<TabType>('basic');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form States
  const [name, setName] = useState(trip.name);
  const [accessCode, setAccessCode] = useState(trip.access_code);
  const [isArchived, setIsArchived] = useState(trip.is_archived);
  const [members, setMembers] = useState<string[]>([...trip.members]);
  const [categories, setCategories] = useState<string[]>([...trip.categories]);
  const [lineBotId, setLineBotId] = useState<string>('');
  const [copied, setCopied] = useState(false);
  
  // Track renames: { oldName: newName }
  const [memberRenames, setMemberRenames] = useState<Record<string, string>>({});
  
  const [ratesStr, setRatesStr] = useState<Record<string, string>>({});
  const [precisionStr, setPrecisionStr] = useState<Record<string, string>>({});
  const [baseCurrency, setBaseCurrency] = useState(trip.base_currency);
  const [defaultCurrency, setDefaultCurrency] = useState(trip.default_currency || trip.base_currency);
  const [defaultCategory, setDefaultCategory] = useState(trip.default_category || trip.categories[0] || '');
  const [defaultPayer, setDefaultPayer] = useState<string[]>(trip.default_payer || []);
  const [defaultSplitMembers, setDefaultSplitMembers] = useState<string[]>(trip.default_split_members || []);

  const [newMember, setNewMember] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newCurrency, setNewCurrency] = useState('');

  useEffect(() => {
    if (isOpen) {
      setName(trip.name);
      setAccessCode(trip.access_code);
      setIsArchived(trip.is_archived);
      setMembers([...trip.members]);
      setCategories([...trip.categories]);
      setBaseCurrency(trip.base_currency);
      setDefaultCurrency(trip.default_currency || trip.base_currency);
      setDefaultCategory(trip.default_category || trip.categories[0] || '');
      setDefaultPayer(trip.default_payer || []);
      setDefaultSplitMembers(trip.default_split_members || []);
      setMemberRenames({});

      const rStr: Record<string, string> = {};
      Object.keys(trip.rates).forEach(k => rStr[k] = trip.rates[k].toString());
      setRatesStr(rStr);

      const pStr: Record<string, string> = {};
      Object.keys(trip.precision_config).forEach(k => pStr[k] = trip.precision_config[k].toString());
      setPrecisionStr(pStr);

      // Fetch LineBot ID
      const fetchLineBotId = async () => {
        if (!supabase) return;
        const { data, error: fetchErr } = await supabase
          .from('line_trip_id_mapping')
          .select('linebot_id')
          .eq('trip_id', trip.id)
          .single();
        
        if (!fetchErr && data) {
          setLineBotId(data.linebot_id);
        }
      };
      fetchLineBotId();
    }
  }, [isOpen, trip]);

  const handleCopy = () => {
    if (lineBotId) {
      const fullId = `ID:${lineBotId}`;
      // Primary method: modern clipboard API
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(fullId).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => {
          // Fallback if it fails
          fallbackCopy(fullId);
        });
      } else {
        // Fallback for non-secure contexts or older browsers
        fallbackCopy(fullId);
      }
    }
  };

  const fallbackCopy = (text: string) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
  };

  const handleMemberRename = (index: number, newName: string) => {
    const oldName = trip.members[index];
    if (!oldName) return; 

    const updatedMembers = [...members];
    updatedMembers[index] = newName;
    setMembers(updatedMembers);

    if (trip.members.includes(oldName)) {
      setMemberRenames(prev => ({ ...prev, [oldName]: newName }));
    }
  };

  const handleSave = async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);

    const finalRates: Record<string, number> = {};
    const finalPrecision: Record<string, number> = {};

    try {
      Object.keys(ratesStr).forEach(k => {
        const val = parseFloat(ratesStr[k]);
        if (isNaN(val) || val <= 0) throw new Error(`${k} 的匯率必須為大於 0 的數字`);
        finalRates[k] = val;
      });

      Object.keys(precisionStr).forEach(k => {
        const val = parseInt(precisionStr[k]);
        if (isNaN(val) || val < 0) throw new Error(`${k} 的精度必須為大於或等於 0 的整數`);
        finalPrecision[k] = val;
      });

      const { error: updateError } = await supabase
        .from('trips')
        .update({
          name,
          access_code: accessCode,
          is_archived: isArchived,
          members,
          categories,
          rates: finalRates,
          precision_config: finalPrecision,
          base_currency: baseCurrency,
          default_currency: defaultCurrency,
          default_category: defaultCategory,
          default_payer: defaultPayer,
          default_split_members: defaultSplitMembers
        })
        .eq('id', trip.id);

      if (updateError) throw updateError;

      const renamePairs = Object.entries(memberRenames).filter(([oldN, newN]) => oldN !== newN);
      if (renamePairs.length > 0) {
        const { data: expensesData, error: fetchErr } = await supabase
          .from('expenses')
          .select('*')
          .eq('trip_id', trip.id);

        if (!fetchErr && expensesData) {
          for (const exp of expensesData) {
            let needsUpdate = false;
            const newPayerData = { ...exp.payer_data };
            const newSplitData = { ...exp.split_data };
            let newAdjMember = exp.adjustment_member;

            renamePairs.forEach(([oldN, newN]) => {
              if (newPayerData[oldN] !== undefined) {
                newPayerData[newN] = newPayerData[oldN];
                delete newPayerData[oldN];
                needsUpdate = true;
              }
              if (newSplitData[oldN] !== undefined) {
                newSplitData[newN] = newSplitData[oldN];
                delete newSplitData[oldN];
                needsUpdate = true;
              }
              if (newAdjMember === oldN) {
                newAdjMember = newN;
                needsUpdate = true;
              }
            });

            if (needsUpdate) {
              await supabase
                .from('expenses')
                .update({ 
                  payer_data: newPayerData, 
                  split_data: newSplitData, 
                  adjustment_member: newAdjMember 
                })
                .eq('id', exp.id);
            }
          }
        }

        const savedMe = localStorage.getItem(`me_${trip.id}`);
        renamePairs.forEach(([oldN, newN]) => {
          if (savedMe === oldN) {
            localStorage.setItem(`me_${trip.id}`, newN);
          }
        });
      }
      
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const addMember = () => {
    if (newMember && !members.includes(newMember)) {
      setMembers([...members, newMember]);
      setNewMember('');
    }
  };

  const removeMember = (m: string) => {
    if (members.length > 1) {
      setMembers(members.filter(item => item !== m));
    } else {
      setError('至少需要一位成員');
    }
  };

  const addCategory = () => {
    if (newCategory && !categories.includes(newCategory)) {
      setCategories([...categories, newCategory]);
      setNewCategory('');
    }
  };

  const addCurrency = () => {
    const code = newCurrency.toUpperCase().trim();
    if (code && !ratesStr[code]) {
      setRatesStr({ ...ratesStr, [code]: '1' });
      setPrecisionStr({ ...precisionStr, [code]: code === 'TWD' ? '0' : '2' });
      setNewCurrency('');
    }
  };

  const removeCurrency = (code: string) => {
    if (code === baseCurrency) {
      setError('不能刪除主幣別');
      return;
    }
    setRatesStr(Object.fromEntries(Object.entries(ratesStr).filter(([k]) => k !== code)));
    setPrecisionStr(Object.fromEntries(Object.entries(precisionStr).filter(([k]) => k !== code)));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="旅程進階設定" maxWidth="max-w-3xl">
      <div className="flex flex-col sm:flex-row h-[70vh] -m-6 overflow-hidden">
        <div className="w-full sm:w-56 bg-slate-50 dark:bg-slate-900/50 border-b sm:border-b-0 sm:border-r border-slate-100 dark:border-slate-800 p-2 sm:p-3 flex sm:flex-col gap-1 sm:gap-2 overflow-x-auto no-scrollbar shrink-0">
          <TabButton active={activeTab === 'basic'} icon={<SettingsIcon className="w-4 h-4 sm:w-5 sm:h-5" />} label="基本設定" onClick={() => setActiveTab('basic')} />
          <TabButton active={activeTab === 'members'} icon={<Users className="w-4 h-4 sm:w-5 sm:h-5" />} label="成員管理" onClick={() => setActiveTab('members')} />
          <TabButton active={activeTab === 'finance'} icon={<Globe className="w-4 h-4 sm:w-5 sm:h-5" />} label="匯率精度" onClick={() => setActiveTab('finance')} />
          <TabButton active={activeTab === 'categories'} icon={<Tag className="w-4 h-4 sm:w-5 sm:h-5" />} label="消費類別" onClick={() => setActiveTab('categories')} />
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-10 no-scrollbar">
          {activeTab === 'basic' && (
            <div className="space-y-6 sm:space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-2">
                <label className="text-[10px] sm:text-sm font-black text-slate-400 uppercase tracking-widest ml-1">旅程名稱</label>
                <input type="text" className="w-full px-4 py-3 sm:py-4 rounded-xl bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-600 outline-none transition-all font-bold text-sm sm:text-base" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] sm:text-sm font-black text-slate-400 uppercase tracking-widest ml-1">訪問密碼</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 w-4 h-4 sm:w-5 sm:h-5" />
                  <input type="text" maxLength={6} className="w-full pl-11 sm:pl-12 pr-4 py-3 sm:py-4 rounded-xl bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-600 outline-none transition-all font-bold text-sm sm:text-base" value={accessCode} onChange={e => setAccessCode(e.target.value)} />
                </div>
              </div>

              {/* LineBot Binding Section */}
              <div className="p-4 sm:p-6 bg-emerald-50/50 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-900/30">
                <div className="flex items-center justify-between mb-3 sm:mb-5">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="p-2 sm:p-3 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 rounded-lg sm:rounded-xl"><MessageCircle size={20} /></div>
                    <div>
                      <p className="text-sm sm:text-base font-black text-slate-900 dark:text-white leading-none">LINE Bot 快速記帳</p>
                      <p className="text-[9px] sm:text-xs text-slate-400 mt-1 sm:mt-1.5 font-medium">使用專屬 ID 綁定 LINE 機器人</p>
                    </div>
                  </div>
                  <a 
                    href="https://line.me/R/ti/p/%40457ctfgb" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] sm:text-xs font-black rounded-lg transition-all active:scale-95 shadow-lg shadow-emerald-500/20"
                  >
                    <Plus size={14} />
                    <span>加入好友</span>
                  </a>
                </div>
                <div className="flex gap-2 sm:gap-3">
                  <div className="flex-1 px-4 py-3 sm:py-4 bg-white dark:bg-slate-800 border-2 border-emerald-100 dark:border-emerald-900/30 rounded-xl sm:rounded-2xl font-black text-center text-xl sm:text-2xl tracking-[0.2em] text-emerald-600">
                    ID:{lineBotId || '------'}
                  </div>
                  <button 
                    onClick={handleCopy}
                    className="px-4 sm:px-6 flex items-center justify-center bg-white dark:bg-slate-800 border-2 border-emerald-100 dark:border-emerald-900/30 hover:border-emerald-600 text-emerald-600 rounded-xl sm:rounded-2xl transition-all active:scale-95"
                  >
                    {copied ? <Check size={20} className="text-emerald-500" /> : <Copy size={20} />}
                  </button>
                </div>
                <p className="mt-3 text-[9px] sm:text-xs text-slate-400 font-medium leading-relaxed">點擊上方按鈕加入好友後，貼上複製的 ID 即可完成綁定。</p>
              </div>

              <div className="pt-4 sm:pt-6 border-t border-slate-100 dark:border-slate-800 space-y-4 sm:space-y-6">
                <div className="flex items-center justify-between p-4 sm:p-5 bg-slate-50 dark:bg-slate-800/50 rounded-2xl">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className={`p-2 sm:p-3 rounded-lg sm:rounded-xl ${isArchived ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-400'}`}><Archive size={20} /></div>
                    <div>
                      <p className="text-sm sm:text-base font-black text-slate-900 dark:text-white leading-none">封存旅程</p>
                      <p className="text-[9px] sm:text-xs text-slate-400 mt-1 sm:mt-1.5 font-medium">封存後將進入唯讀模式</p>
                    </div>
                  </div>
                  <button onClick={() => setIsArchived(!isArchived)} className={`w-10 sm:w-14 h-5 sm:h-7 rounded-full transition-all relative ${isArchived ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-700'}`}><div className={`absolute top-0.5 sm:top-1 w-4 sm:w-5 h-4 sm:h-5 rounded-full bg-white transition-all ${isArchived ? 'left-5.5 sm:left-8' : 'left-0.5 sm:left-1'}`} /></button>
                </div>

                <div className="p-4 sm:p-6 bg-blue-50/50 dark:bg-blue-900/10 rounded-2xl border border-blue-100 dark:border-blue-900/30">
                  <div className="flex items-center gap-3 sm:gap-4 mb-3 sm:mb-5">
                    <div className="p-2 sm:p-3 bg-blue-100 dark:bg-blue-900/30 text-blue-600 rounded-lg sm:rounded-xl"><ShieldCheck size={20} /></div>
                    <div>
                      <p className="text-sm sm:text-base font-black text-slate-900 dark:text-white leading-none">數據備份</p>
                      <p className="text-[9px] sm:text-xs text-slate-400 mt-1 sm:mt-1.5 font-medium">匯出所有支出紀錄至 CSV 檔案</p>
                    </div>
                  </div>
                  <button onClick={() => exportExpensesToCSV(expenses, trip.name)} className="w-full flex items-center justify-center gap-2 py-3 sm:py-4 px-4 bg-white dark:bg-slate-800 border-2 border-blue-100 dark:border-blue-900/30 hover:border-blue-600 text-blue-600 dark:text-blue-400 font-black rounded-xl sm:rounded-2xl transition-all shadow-sm active:scale-95 text-[10px] sm:text-sm"><Download size={16} /><span>導出 CSV 檔案</span></button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'members' && (
            <div className="space-y-6 sm:space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="flex gap-2 sm:gap-3">
                <input type="text" placeholder="新增成員" className="flex-1 px-4 py-2.5 sm:py-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 font-bold text-sm sm:text-base outline-none border-2 border-transparent focus:border-blue-600" value={newMember} onChange={e => setNewMember(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMember()} />
                <button onClick={addMember} className="px-4 sm:px-5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors shadow-lg active:scale-95"><Plus size={20} strokeWidth={3} /></button>
              </div>
              <div className="space-y-3 sm:space-y-4">
                {members.map((m, idx) => (
                  <div key={idx} className="flex items-center gap-2 sm:gap-3 group animate-in fade-in duration-200">
                    <div className="flex-1 flex items-center gap-3 sm:gap-4 p-3 sm:p-4 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-xl sm:rounded-2xl shadow-sm">
                      <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center text-blue-600 font-black text-xs sm:text-sm shrink-0">{m.charAt(0)}</div>
                      <input type="text" className="flex-1 bg-transparent font-black text-sm sm:text-base outline-none focus:text-blue-600" value={m} onChange={e => handleMemberRename(idx, e.target.value)} placeholder="成員姓名" />
                    </div>
                    <button onClick={() => removeMember(m)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>
              <p className="text-[10px] sm:text-xs text-slate-400 px-2 font-medium bg-slate-50 dark:bg-slate-900/50 p-3 sm:p-4 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 leading-relaxed">💡 <b>提示：</b> 您可以直接點擊姓名進行修改，系統會自動同步歷史紀錄。</p>

              {/* Default payer & split */}
              <div className="pt-2 space-y-5 border-t border-slate-100 dark:border-slate-800">
                <p className="text-[10px] sm:text-xs font-black text-slate-400 uppercase tracking-widest pt-2">記帳預設值</p>

                {/* Default payer */}
                <div className="space-y-2">
                  <label className="text-[10px] sm:text-xs font-bold text-slate-500">預設付款人</label>
                  <div className="flex flex-wrap gap-2">
                    {members.map(m => {
                      const checked = defaultPayer.includes(m);
                      return (
                        <button
                          key={m}
                          onClick={() =>
                            setDefaultPayer(prev =>
                              checked ? prev.filter(x => x !== m) : [...prev, m]
                            )
                          }
                          className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-black transition-all border ${
                            checked
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-blue-300'
                          }`}
                        >
                          {m}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[9px] sm:text-[10px] text-slate-400">未選則以登入身分為準，若未登入則使用第一位成員。</p>
                </div>

                {/* Default split members */}
                <div className="space-y-2">
                  <label className="text-[10px] sm:text-xs font-bold text-slate-500">預設分攤成員</label>
                  <div className="flex flex-wrap gap-2">
                    {members.map(m => {
                      const checked = defaultSplitMembers.includes(m);
                      return (
                        <button
                          key={m}
                          onClick={() =>
                            setDefaultSplitMembers(prev =>
                              checked ? prev.filter(x => x !== m) : [...prev, m]
                            )
                          }
                          className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-black transition-all border ${
                            checked
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-indigo-300'
                          }`}
                        >
                          {m}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[9px] sm:text-[10px] text-slate-400">未選則預設全部成員分攤。</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'finance' && (
            <div className="space-y-8 sm:space-y-10 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                <div className="p-4 sm:p-6 bg-blue-50 dark:bg-blue-900/20 rounded-2xl border border-blue-100 dark:border-blue-900/30">
                  <label className="text-[10px] sm:text-xs font-black text-blue-600 dark:text-blue-400 uppercase tracking-widest">當前主幣別</label>
                  <div className="relative mt-1 sm:mt-2">
                    <select className="w-full bg-transparent font-black text-xl sm:text-3xl text-blue-700 dark:text-blue-300 outline-none cursor-pointer appearance-none" value={baseCurrency} onChange={e => setBaseCurrency(e.target.value)}>{Object.keys(ratesStr).map(c => <option key={c} value={c}>{c}</option>)}</select>
                    <ChevronRight size={20} className="absolute right-0 top-1/2 -translate-y-1/2 rotate-90 text-blue-300 pointer-events-none" />
                  </div>
                </div>
                <div className="p-4 sm:p-6 bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-900/30">
                  <label className="text-[10px] sm:text-xs font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">預設記帳幣別</label>
                  <div className="relative mt-1 sm:mt-2">
                    <select className="w-full bg-transparent font-black text-xl sm:text-3xl text-indigo-700 dark:text-indigo-300 outline-none cursor-pointer appearance-none" value={defaultCurrency} onChange={e => setDefaultCurrency(e.target.value)}>{Object.keys(ratesStr).map(c => <option key={c} value={c}>{c}</option>)}</select>
                    <ChevronRight size={20} className="absolute right-0 top-1/2 -translate-y-1/2 rotate-90 text-indigo-300 pointer-events-none" />
                  </div>
                </div>
              </div>
              <div className="space-y-4 sm:space-y-6">
                <div className="flex items-center justify-between px-1"><label className="text-[10px] sm:text-xs font-black text-slate-400 uppercase tracking-widest">幣別與匯率配置</label><span className="text-[9px] sm:text-xs text-slate-400 font-bold">(1 幣別 = ? {baseCurrency})</span></div>
                <div className="space-y-3 sm:space-y-4">
                  {Object.keys(ratesStr).map(code => (
                    <div key={code} className="p-4 sm:p-6 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-2xl sm:rounded-[2rem] shadow-sm space-y-4 sm:space-y-5">
                      <div className="flex items-center justify-between">
                        <span className="font-black text-blue-600 dark:text-blue-400 text-sm sm:text-xl">{code}</span>
                        {code !== baseCurrency && (<button onClick={() => removeCurrency(code)} className="p-1.5 text-slate-300 hover:text-rose-500 transition-colors"><X size={16} /></button>)}
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:gap-6">
                        <div className="space-y-1 sm:space-y-2">
                          <label className="text-[9px] sm:text-[10px] font-black text-slate-400 uppercase tracking-wider ml-1">基準匯率</label>
                          <input type="text" inputMode="decimal" className="w-full px-3 py-2 sm:px-4 sm:py-3 bg-slate-50 dark:bg-slate-900 rounded-xl font-black text-sm sm:text-base outline-none border-2 border-transparent focus:border-blue-500/20" value={ratesStr[code] ?? ''} onChange={e => setRatesStr({...ratesStr, [code]: e.target.value})} />
                        </div>
                        <div className="space-y-1 sm:space-y-2">
                          <label className="text-[9px] sm:text-[10px] font-black text-slate-400 uppercase tracking-wider ml-1">小數精度</label>
                          <input type="text" inputMode="numeric" className="w-full px-3 py-2 sm:px-4 sm:py-3 bg-slate-50 dark:bg-slate-900 rounded-xl font-black text-sm sm:text-base outline-none border-2 border-transparent focus:border-blue-500/20" value={precisionStr[code] ?? ''} onChange={e => setPrecisionStr({...precisionStr, [code]: e.target.value})} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 sm:gap-3 pt-4 sm:pt-6">
                  <input type="text" placeholder="新增幣別" className="flex-1 px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 text-xs sm:text-sm font-bold outline-none border-2 border-transparent focus:border-blue-600" value={newCurrency} onChange={e => setNewCurrency(e.target.value)} />
                  <button onClick={addCurrency} className="px-4 sm:px-8 py-3 sm:py-4 bg-slate-900 dark:bg-slate-700 text-white rounded-xl text-xs sm:text-sm font-black hover:bg-black transition-all shadow-lg active:scale-95">新增</button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'categories' && (
            <div className="space-y-6 sm:space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-4 sm:p-6 bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-900/30">
                <label className="text-[10px] sm:text-xs font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">預設記帳類別</label>
                <div className="relative mt-1 sm:mt-2">
                  <select className="w-full bg-transparent font-black text-xl sm:text-3xl text-indigo-700 dark:text-indigo-300 outline-none cursor-pointer appearance-none" value={defaultCategory} onChange={e => setDefaultCategory(e.target.value)}>{categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}</select>
                  <ChevronRight size={20} className="absolute right-0 top-1/2 -translate-y-1/2 rotate-90 text-indigo-300 pointer-events-none" />
                </div>
              </div>
              <div className="flex gap-2 sm:gap-3">
                <input type="text" placeholder="新增類別" className="flex-1 px-4 py-2.5 sm:py-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 font-bold text-sm sm:text-base outline-none border-2 border-transparent focus:border-blue-600" value={newCategory} onChange={e => setNewCategory(e.target.value)} onKeyDown={e => e.key === 'Enter' && addCategory()} />
                <button onClick={addCategory} className="px-4 sm:px-5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors shadow-lg active:scale-95"><Plus size={20} strokeWidth={3} /></button>
              </div>
              <div className="flex flex-wrap gap-2 sm:gap-3">
                {categories.map(cat => (
                  <div key={cat} className="flex items-center gap-2 sm:gap-3 px-3 py-1.5 sm:px-5 sm:py-2.5 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-full shadow-sm group hover:border-blue-200 transition-all">
                    <span className="text-xs sm:text-base font-black text-slate-700 dark:text-slate-200">{cat}</span>
                    <button onClick={() => setCategories(categories.filter(c => c !== cat))} className="text-slate-300 hover:text-rose-500 transition-colors"><X size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-4 sm:mt-8 pt-4 sm:pt-6 border-t border-slate-100 dark:border-slate-800">
        {error && <div className="flex items-center gap-1.5 text-rose-500 text-[10px] font-black shrink min-w-0 mr-2"><AlertCircle size={14} className="shrink-0" /> <span className="truncate">{error}</span></div>}
        {!error && <div className="hidden sm:block text-xs text-slate-400 font-bold uppercase tracking-widest">點擊儲存後生效</div>}
        <div className="flex gap-2 sm:gap-3 shrink-0 ml-auto">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs sm:text-sm font-black text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">取消</button>
          <button disabled={loading} onClick={handleSave} className="flex items-center gap-2 sm:gap-3 bg-blue-600 hover:bg-blue-700 text-white font-black px-5 sm:px-8 py-2 sm:py-3 rounded-xl shadow-xl shadow-blue-500/20 active:scale-95 transition-all whitespace-nowrap text-xs sm:text-sm">{loading ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}<span>儲存設定</span></button>
        </div>
      </div>
    </Modal>
  );
};

const TabButton: React.FC<{ active: boolean; icon: React.ReactNode; label: string; onClick: () => void }> = ({ active, icon, label, onClick }) => (
  <button onClick={onClick} className={`flex items-center gap-2 sm:gap-4 px-3 py-2.5 sm:px-5 sm:py-4 rounded-xl transition-all ${active ? 'bg-white dark:bg-slate-800 text-blue-600 shadow-md font-black' : 'text-slate-400 hover:bg-white/50 dark:hover:bg-slate-800/30 font-bold'}`}><div className={`${active ? 'text-blue-600' : 'text-slate-300'}`}>{icon}</div><span className="text-[10px] sm:text-sm truncate">{label}</span></button>
);

export default SettingsModal;
