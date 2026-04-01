import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  X, 
  Camera, 
  Lock, 
  Unlock, 
  AlertCircle, 
  Loader2, 
  Coins,
  Receipt,
  Plus,
  CreditCard,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  Save
} from 'lucide-react';
import Modal from './Modal';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { calculateDistribution } from '../utils/finance';
import imageCompression from 'browser-image-compression';

interface ExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
  trip: Trip;
  currentUser: string | null;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error') => void;
  editData?: Expense | null; // Pass this to enter Edit Mode
}

const ExpenseModal: React.FC<ExpenseModalProps> = ({ isOpen, onClose, trip, currentUser, onSuccess, showToast, editData }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<string>('');
  const [currency, setCurrency] = useState(trip.base_currency);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [category, setCategory] = useState(trip.categories[0] || '其他');
  
  // Payer Control
  const [payerData, setPayerData] = useState<Record<string, number | string>>({});
  const [payerActive, setPayerActive] = useState<Set<string>>(new Set());
  const [payerLocked, setPayerLocked] = useState<Set<string>>(new Set());
  
  // Split Control
  const [splitData, setSplitData] = useState<Record<string, number | string>>({});
  const [splitActive, setSplitActive] = useState<Set<string>>(new Set(trip.members));
  const [splitLocked, setSplitLocked] = useState<Set<string>>(new Set());
  const [adjustmentMember, setAdjustmentMember] = useState<string | null>(null);
  
  // Photo State
  const [photos, setPhotos] = useState<File[]>([]);
  const [existingPhotos, setExistingPhotos] = useState<string[]>([]); // URLs from server
  const [previews, setPreviews] = useState<string[]>([]);

  const precision = trip.precision_config[currency] ?? (currency === 'TWD' ? 0 : 2);
  const numAmount = useMemo(() => parseFloat(amount) || 0, [amount]);

  // Initialization & Reset
  useEffect(() => {
    if (isOpen) {
      if (editData) {
        // --- Edit Mode ---
        setDescription(editData.description);
        setAmount(editData.amount.toString());
        setCurrency(editData.currency);
        setDate(editData.date);
        setCategory(editData.category);
        setAdjustmentMember(editData.adjustment_member);
        setExistingPhotos(editData.photo_urls || []);
        setPhotos([]);
        setPreviews([]);

        // Set Payers
        const pActive = new Set(Object.keys(editData.payer_data));
        setPayerActive(pActive);
        setPayerData(editData.payer_data);
        setPayerLocked(new Set(Object.keys(editData.payer_data))); // In edit mode, usually treat as locked initially

        // Set Splitters
        const sActive = new Set(Object.keys(editData.split_data));
        setSplitActive(sActive);
        setSplitData(editData.split_data);
        setSplitLocked(new Set(Object.keys(editData.split_data)));
      } else {
        // --- New Mode ---
        setDescription('');
        setAmount('');
        setCurrency(trip.base_currency);
        setDate(new Date().toISOString().split('T')[0]);
        setCategory(trip.categories[0] || '其他');
        setExistingPhotos([]);
        setPhotos([]);
        setPreviews([]);
        
        const initialPayer = currentUser || trip.members[0];
        setPayerActive(new Set([initialPayer]));
        setPayerLocked(new Set());
        setPayerData({});

        setSplitActive(new Set(trip.members));
        setSplitLocked(new Set());
        setSplitData({});
        setAdjustmentMember(initialPayer);
      }
    }
  }, [isOpen, editData, trip.members, currentUser, trip.base_currency]);

  // General Distribution Logic
  const runDistribution = useCallback((
    total: number, 
    active: Set<string>, 
    locked: Set<string>, 
    currentData: Record<string, number | string>,
    adjMember: string | null
  ) => {
    const activeList = Array.from(active);
    const lockedMap: Record<string, number> = {};
    locked.forEach(m => {
      if (active.has(m)) lockedMap[m] = Number(currentData[m]) || 0;
    });
    return calculateDistribution(total, activeList, lockedMap, adjMember, precision);
  }, [precision]);

  // Auto-recalculate Payers (only if not manually locked everything)
  useEffect(() => {
    if (payerLocked.size === payerActive.size && payerLocked.size > 0) return;
    const newData = runDistribution(numAmount, payerActive, payerLocked, payerData, null);
    setPayerData(prev => {
      const next = { ...prev };
      Object.keys(newData).forEach(m => {
        if (!payerLocked.has(m)) next[m] = newData[m];
      });
      return next;
    });
  }, [numAmount, payerActive, payerLocked, runDistribution]);

  // Auto-recalculate Splitters
  useEffect(() => {
    if (splitLocked.size === splitActive.size && splitLocked.size > 0) return;
    const newData = runDistribution(numAmount, splitActive, splitLocked, splitData, adjustmentMember);
    setSplitData(prev => {
      const next = { ...prev };
      Object.keys(newData).forEach(m => {
        if (!splitLocked.has(m)) next[m] = newData[m];
      });
      return next;
    });
  }, [numAmount, splitActive, splitLocked, adjustmentMember, runDistribution]);

  const payerSum = useMemo(() => Object.values(payerData).reduce((a, b) => a + (Number(b) || 0), 0), [payerData]);
  const splitSum = useMemo(() => Object.values(splitData).reduce((a, b) => a + (Number(b) || 0), 0), [splitData]);

  const isPayerValid = Math.abs(payerSum - numAmount) < 0.01;
  const isSplitValid = Math.abs(splitSum - numAmount) < 0.01;

  // Handlers
  const toggleActive = (member: string, type: 'payer' | 'split') => {
    if (type === 'payer') {
      const next = new Set(payerActive);
      const isRemoving = next.has(member);
      isRemoving ? next.delete(member) : next.add(member);
      setPayerActive(next);
      
      if (isRemoving) {
        // Clear data and lock when removing
        setPayerData(prev => ({ ...prev, [member]: 0 }));
        setPayerLocked(prev => { const n = new Set(prev); n.delete(member); return n; });
      }
    } else {
      const next = new Set(splitActive);
      const isRemoving = next.has(member);
      isRemoving ? next.delete(member) : next.add(member);
      setSplitActive(next);
      
      if (isRemoving) {
        // Clear data and lock when removing
        setSplitData(prev => ({ ...prev, [member]: 0 }));
        setSplitLocked(prev => { const n = new Set(prev); n.delete(member); return n; });
      }
    }
  };

  const handleManualEdit = (member: string, val: string, type: 'payer' | 'split') => {
    // Store as string to allow typing freely (empty string, decimals)
    if (type === 'payer') {
      setPayerData(prev => ({ ...prev, [member]: val }));
      setPayerLocked(prev => new Set(prev).add(member));
      if (!payerActive.has(member)) setPayerActive(prev => new Set(prev).add(member));
    } else {
      setSplitData(prev => ({ ...prev, [member]: val }));
      setSplitLocked(prev => new Set(prev).add(member));
      if (!splitActive.has(member)) setSplitActive(prev => new Set(prev).add(member));
    }
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setLoading(true);
    const compressedFiles: File[] = [];
    const newPreviews: string[] = [];
    for (const file of files) {
      try {
        const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1280, useWebWorker: true };
        const compressed = await imageCompression(file, options);
        compressedFiles.push(compressed);
        newPreviews.push(URL.createObjectURL(compressed));
      } catch (err) { console.error(err); }
    }
    setPhotos(prev => [...prev, ...compressedFiles]);
    setPreviews(prev => [...prev, ...newPreviews]);
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!numAmount || !description || !supabase) return;
    if (!isPayerValid || !isSplitValid) {
      setError('金額分配與總額不符，請檢查付款或分攤明細');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      // 1. Upload New Photos
      const newPhotoUrls: string[] = [];
      for (const file of photos) {
        const filePath = `expenses/${trip.id}/${Math.random()}.${file.name.split('.').pop()}`;
        const { error: uErr } = await supabase.storage.from('travel-images').upload(filePath, file);
        if (uErr) throw uErr;
        newPhotoUrls.push(filePath);
      }

      const finalPhotoUrls = [...existingPhotos, ...newPhotoUrls];

      const record = {
        trip_id: trip.id, date, category, description, amount: numAmount, currency,
        payer_data: payerData, split_data: splitData, adjustment_member: adjustmentMember,
        photo_urls: finalPhotoUrls, is_settlement: false
      };

      if (editData) {
        // --- Update ---
        const { error: uErr } = await supabase.from('expenses').update(record).eq('id', editData.id);
        if (uErr) throw uErr;
        showToast('支出紀錄已更新！');
      } else {
        // --- Insert ---
        const { error: iErr } = await supabase.from('expenses').insert([record]);
        if (iErr) throw iErr;
        showToast('支出紀錄已新增！');
      }

      onSuccess();
      onClose();
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  };

  const ValidationBadge = ({ isValid, current, target }: { isValid: boolean, current: number, target: number }) => (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-black transition-all ${isValid ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400' : 'bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400 animate-pulse'}`}>
      {isValid ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
      <span>{isValid ? '符合' : `不符: ${current.toFixed(precision)} / ${target}`}</span>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editData ? "編輯支出紀錄" : "新增支出紀錄"}>
      <div className="w-full max-w-lg mx-auto overflow-hidden px-1">
        <form onSubmit={handleSubmit} className="space-y-6 max-h-[75vh] overflow-y-auto no-scrollbar py-2">
          
          {/* Header Info */}
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">支出描述</label>
              <div className="relative">
                <Receipt className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
                <input required type="text" placeholder="例如：機場晚餐" className="w-full pl-11 pr-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 outline-none transition-all font-bold text-sm" value={description} onChange={e => setDescription(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">金額</label>
              <div className="flex gap-2">
                <div className="relative w-24 shrink-0">
                  <select className="w-full pl-3 pr-8 py-3 rounded-xl bg-slate-100 dark:bg-slate-800 border-2 border-transparent font-bold text-xs outline-none appearance-none" value={currency} onChange={e => setCurrency(e.target.value)}>
                    {Object.keys(trip.rates).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={12} />
                </div>
                <input required type="number" step="any" inputMode="decimal" placeholder="0.00" className="flex-1 min-w-0 px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 outline-none transition-all font-black text-lg" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">日期</label>
              <input type="date" className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 font-bold text-xs outline-none" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">分類</label>
              <select className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 font-bold text-xs outline-none" value={category} onChange={e => setCategory(e.target.value)}>
                {trip.categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
          </div>

          {/* Payers */}
          <div className="space-y-3">
            <div className="flex items-center justify-between ml-1">
              <div className="flex items-center gap-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">誰付的錢？</label>
                <ValidationBadge isValid={isPayerValid} current={payerSum} target={numAmount} />
              </div>
              <CreditCard size={14} className="text-slate-300" />
            </div>
            <div className="bg-slate-50/50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
              {trip.members.map(member => (
                <div key={member} className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" className="w-4 h-4 rounded-lg accent-blue-600 cursor-pointer" checked={payerActive.has(member)} onChange={() => toggleActive(member, 'payer')} />
                    <span className={`text-xs font-bold ${payerActive.has(member) ? 'text-slate-900 dark:text-white' : 'text-slate-300 dark:text-slate-600'}`}>{member}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <input type="number" step="any" disabled={!payerActive.has(member)} placeholder="0" className={`w-24 text-right bg-transparent font-black text-sm outline-none ${payerLocked.has(member) ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-2 rounded' : 'text-slate-400'}`} value={payerData[member] ?? ''} onChange={e => handleManualEdit(member, e.target.value, 'payer')} />
                    <button type="button" onClick={() => setPayerLocked(prev => { const n = new Set(prev); n.has(member) ? n.delete(member) : n.add(member); return n; })} disabled={!payerActive.has(member)} className={`p-1 transition-colors ${payerLocked.has(member) ? 'text-emerald-500' : 'text-slate-200'}`}>
                      {payerLocked.has(member) ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Splitters */}
          <div className="space-y-3">
            <div className="flex items-center justify-between ml-1">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">每人分攤</label>
                  <ValidationBadge isValid={isSplitValid} current={splitSum} target={numAmount} />
                </div>
                <p className="text-[8px] text-slate-400 font-medium">點擊 ⭐ 以指定成員吸收餘數</p>
              </div>
              <Coins size={14} className="text-slate-300" />
            </div>
            <div className="bg-slate-50/50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
              {trip.members.map(member => (
                <div key={member} className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" className="w-4 h-4 rounded-lg accent-blue-600 cursor-pointer" checked={splitActive.has(member)} onChange={() => toggleActive(member, 'split')} />
                    <button type="button" onClick={() => setAdjustmentMember(member)} disabled={!splitActive.has(member)} className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border transition-all ${adjustmentMember === member ? 'bg-amber-500 text-white border-amber-500 shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-300 border-slate-200'}`}>
                      {adjustmentMember === member ? '⭐' : member.charAt(0)}
                    </button>
                    <span className={`text-xs font-bold ${splitActive.has(member) ? 'text-slate-900 dark:text-white' : 'text-slate-300 dark:text-slate-600'}`}>{member}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <input type="number" step="any" disabled={!splitActive.has(member)} placeholder="0" className={`w-24 text-right bg-transparent font-black text-sm outline-none ${splitLocked.has(member) ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 px-2 rounded' : 'text-slate-400'}`} value={splitData[member] ?? ''} onChange={e => handleManualEdit(member, e.target.value, 'split')} />
                    <button type="button" onClick={() => setSplitLocked(prev => { const n = new Set(prev); n.has(member) ? n.delete(member) : n.add(member); return n; })} disabled={!splitActive.has(member)} className={`p-1 transition-colors ${splitLocked.has(member) ? 'text-blue-500' : 'text-slate-200'}`}>
                      {splitLocked.has(member) ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Photos */}
          <div className="space-y-3">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">收據照片</label>
            <div className="flex flex-wrap gap-3">
              {/* Existing Photos */}
              {existingPhotos.map((url, idx) => (
                <div key={`ex-${idx}`} className="relative w-20 h-20 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700">
                  <img src={`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/travel-images/${url}`} className="w-full h-full object-cover" alt="existing" />
                  <button type="button" onClick={() => setExistingPhotos(prev => prev.filter((_, i) => i !== idx))} className="absolute top-1 right-1 bg-rose-500 text-white p-1 rounded-full"><X size={10} /></button>
                </div>
              ))}
              {/* New Previews */}
              {previews.map((src, idx) => (
                <div key={`new-${idx}`} className="relative w-20 h-20 rounded-xl overflow-hidden border border-blue-200">
                  <img src={src} className="w-full h-full object-cover" alt="new" />
                  <button type="button" onClick={() => { setPhotos(photos.filter((_, i) => i !== idx)); setPreviews(previews.filter((_, i) => i !== idx)); }} className="absolute top-1 right-1 bg-black/50 text-white p-1 rounded-full"><X size={10} /></button>
                </div>
              ))}
              <label className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 flex flex-col items-center justify-center text-slate-400 hover:border-blue-400 cursor-pointer">
                <Camera size={20} /><span className="text-[8px] font-bold mt-1">添加</span><input type="file" multiple accept="image/*" className="hidden" onChange={handlePhotoChange} />
              </label>
            </div>
          </div>

          {error && <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-xl flex items-center gap-3 text-red-600 dark:text-red-400 text-xs font-bold"><AlertCircle size={16} />{error}</div>}

          <button disabled={loading} type="submit" className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-black py-4 rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 mt-4">
            {loading ? <Loader2 className="animate-spin" size={20} /> : (editData ? <Save size={20} /> : <Plus size={20} strokeWidth={3} />)}
            <span>{loading ? '儲存中...' : (editData ? '儲存修改' : '確認新增支出')}</span>
          </button>
        </form>
      </div>
    </Modal>
  );
};

export default ExpenseModal;
