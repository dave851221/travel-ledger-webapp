import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  Save,
  GripVertical
} from 'lucide-react';
import Modal from './Modal';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { calculateDistribution, getCurrencyPrecision } from '../utils/finance';
import { getLocalDateString } from '../utils/date';
import { photoUrl, RECEIPTS_BUCKET } from '../utils/storage';
import Decimal from 'decimal.js';
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
  const [date, setDate] = useState(getLocalDateString());
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
  
  // Photo State — unified ordered list for drag-to-reorder support
  type PhotoEntry =
    | { kind: 'existing'; key: string; url: string }
    | { kind: 'new'; key: string; file: File; preview: string };
  const [photoList, setPhotoList] = useState<PhotoEntry[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  const precision = getCurrencyPrecision(currency, trip.precision_config);
  const numAmount = useMemo(() => parseFloat(amount) || 0, [amount]);

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

  // 編輯模式開啟時的基準狀態。
  // 在使用者真的動到金額／成員之前，保留資料庫裡原本的分帳金額不重算；
  // 一旦有任何變動就恢復正常的自動重算。
  // （舊作法是把所有成員設成 locked，結果改金額後分攤永遠不動，
  //   使用者得逐一解鎖才會重算，非常違反直覺。）
  const payerBaselineRef = useRef<string | null>(null);
  const splitBaselineRef = useRef<string | null>(null);

  // 開啟 modal 時，複雜的分帳直接攤開，單純的就維持收合
  useEffect(() => {
    if (!isOpen) return;
    setShowPayerDetail(payerActive.size > 1);
    setShowSplitDetail(splitActive.size > 0 && splitActive.size !== trip.members.length);
    // 只在開啟的當下判斷一次，之後由使用者自己控制
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const payerSignature = `${numAmount}|${[...payerActive].sort().join(',')}`;
  const splitSignature = `${numAmount}|${[...splitActive].sort().join(',')}|${adjustmentMember ?? ''}`;

  // Auto-recalculate Payers (only if not manually locked everything)
  useEffect(() => {
    if (payerBaselineRef.current === payerSignature) return;
    if (payerLocked.size === payerActive.size && payerLocked.size > 0) return;
    const newData = runDistribution(numAmount, payerActive, payerLocked, payerData, null);
    setPayerData(prev => {
      const next = { ...prev };
      Object.keys(newData).forEach(m => {
        if (!payerLocked.has(m)) next[m] = newData[m];
      });
      return next;
    });
  }, [numAmount, payerActive, payerLocked, runDistribution, payerSignature]);

  // Auto-recalculate Splitters
  useEffect(() => {
    if (splitBaselineRef.current === splitSignature) return;
    if (splitLocked.size === splitActive.size && splitLocked.size > 0) return;
    const newData = runDistribution(numAmount, splitActive, splitLocked, splitData, adjustmentMember);
    setSplitData(prev => {
      const next = { ...prev };
      Object.keys(newData).forEach(m => {
        if (!splitLocked.has(m)) next[m] = newData[m];
      });
      return next;
    });
  }, [numAmount, splitActive, splitLocked, adjustmentMember, runDistribution, splitSignature]);

  // Initialization & Reset — declared after auto-recalc effects so that on the
  // first render, React batches the setSplitData/setPayerData from init AFTER
  // the recalc effects. Non-functional setters overwrite functional ones,
  // ensuring editData values are not zeroed out by the initial-state recalc pass.
  useEffect(() => {
    if (isOpen) {
      setError(null);
      setLoading(false);
      if (editData) {
        // --- Edit Mode ---
        setDescription(editData.description);
        setAmount(editData.amount.toString());
        setCurrency(editData.currency);
        setDate(editData.date);
        setCategory(editData.category);
        setAdjustmentMember(editData.adjustment_member);
        setPhotoList((editData.photo_urls || []).map(url => ({ kind: 'existing' as const, key: url, url })));
        setDragIndex(null);
        setDropTarget(null);

        // Set Payers (only check if amount > 0)
        const activePayers = Object.entries(editData.payer_data)
          .filter(([, v]) => (Number(v) || 0) !== 0)
          .map(([m]) => m);
        const pActive = new Set(activePayers);
        setPayerActive(pActive);
        setPayerData(editData.payer_data);
        setPayerLocked(new Set());
        payerBaselineRef.current =
          `${editData.amount}|${[...pActive].sort().join(',')}`;

        // Set Splitters (only check if amount > 0)
        const activeSplitters = Object.entries(editData.split_data)
          .filter(([, v]) => (Number(v) || 0) !== 0)
          .map(([m]) => m);
        const sActive = new Set(activeSplitters);
        setSplitActive(sActive);
        setSplitData(editData.split_data);
        setSplitLocked(new Set());
        splitBaselineRef.current =
          `${editData.amount}|${[...sActive].sort().join(',')}|${editData.adjustment_member ?? ''}`;
      } else {
        // --- New Mode ---
        setDescription('');
        setAmount('');
        setCurrency(trip.default_currency || trip.base_currency);
        setDate(getLocalDateString());
        setCategory(trip.default_category || trip.categories[0] || '其他');
        setPhotoList([]);
        setDragIndex(null);
        setDropTarget(null);

        const defaultPayers = (trip.default_payer ?? []).filter(m => trip.members.includes(m));
        const activePayers = defaultPayers.length > 0
          ? new Set(defaultPayers)
          : new Set([currentUser || trip.members[0]]);
        setPayerActive(activePayers);
        setPayerLocked(new Set());
        setPayerData({});
        payerBaselineRef.current = null;

        const defaultSplit = trip.default_split_members?.length
          ? new Set(trip.default_split_members.filter(m => trip.members.includes(m)))
          : new Set(trip.members);
        setSplitActive(defaultSplit.size > 0 ? defaultSplit : new Set(trip.members));
        setSplitLocked(new Set());
        setSplitData({});
        splitBaselineRef.current = null;

        // adjMember: 優先 currentUser（若在預設付款人中）→ 第一個預設付款人 → 第一位成員
        const adjMember = activePayers.has(currentUser || '')
          ? currentUser!
          : [...activePayers][0] ?? trip.members[0];
        setAdjustmentMember(adjMember);
      }
    }
  }, [isOpen, editData, trip.members, currentUser, trip.base_currency]);

  // 兩張成員表預設收合。以五人旅程為例，展開時光是這兩區就有 50 個控制項
  // 擋在金額欄與送出鍵之間；多數記帳其實直接套用預設值即可。
  // 只要偵測到不是「單一付款人 + 全員均分」的單純情況，就自動展開。
  const [showPayerDetail, setShowPayerDetail] = useState(false);
  const [showSplitDetail, setShowSplitDetail] = useState(false);

  const payerSummary = useMemo(() => {
    const names = [...payerActive];
    if (names.length === 0) return '尚未選擇付款人';
    if (names.length === 1) return `${names[0]} 付`;
    return `${names.length} 人分別墊付`;
  }, [payerActive]);

  const splitSummary = useMemo(() => {
    const names = [...splitActive];
    if (names.length === 0) return '尚未選擇分攤成員';
    if (names.length === trip.members.length) return '全員均分';
    if (names.length === 1) return `${names[0]} 全額負擔`;
    return `${names.length} 人分攤`;
  }, [splitActive, trip.members.length]);

  const payerSum = useMemo(() => Object.values(payerData).reduce<number>((a, b) => a + (Number(b) || 0), 0), [payerData]);
  const splitSum = useMemo(() => Object.values(splitData).reduce<number>((a, b) => a + (Number(b) || 0), 0), [splitData]);

  const isPayerValid = Math.abs(payerSum - numAmount) < 0.01;
  const isSplitValid = Math.abs(splitSum - numAmount) < 0.01;

  // Handlers
  const toggleActive = (member: string, type: 'payer' | 'split') => {
    if (type === 'payer') {
      const next = new Set(payerActive);
      const isRemoving = next.has(member);
      if (isRemoving) { next.delete(member); } else { next.add(member); }
      setPayerActive(next);

      if (isRemoving) {
        setPayerData(prev => ({ ...prev, [member]: 0 }));
        setPayerLocked(prev => { const n = new Set(prev); n.delete(member); return n; });
      }
    } else {
      const next = new Set(splitActive);
      const isRemoving = next.has(member);
      if (isRemoving) { next.delete(member); } else { next.add(member); }
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
    const newEntries: PhotoEntry[] = [];
    for (const file of files) {
      try {
        const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1280, useWebWorker: true };
        const compressed = await imageCompression(file, options);
        newEntries.push({ kind: 'new', key: `new-${crypto.randomUUID()}`, file: compressed, preview: URL.createObjectURL(compressed) });
      } catch (err) { console.error(err); }
    }
    setPhotoList(prev => [...newEntries, ...prev]);
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      setError('尚未連線到資料庫，請稍後再試');
      return;
    }
    if (!numAmount) {
      setError('請輸入金額');
      return;
    }
    if (!isPayerValid || !isSplitValid) {
      setError('金額分配與總額不符，請檢查付款或分攤明細');
      return;
    }
    // 描述留空時用分類名代入，讓「只打金額」也能成立
    const finalDescription = description.trim() || category;

    try {
      setLoading(true);
      setError(null);

      // --- LIFF 防重複：在所有操作前先佔用 nonce ---
      // 若 nonce 已被 LINE 的「確認存入」或「取消」使用，則中止，避免重複寫入
      const liffMeta = editData as (Expense & { nonce?: string; line_user_id?: string }) | null;
      if (liffMeta?.nonce && liffMeta?.line_user_id) {
        const { error: nonceErr } = await supabase.from('line_processed_actions').insert({
          nonce: liffMeta.nonce,
          line_user_id: liffMeta.line_user_id,
          action_type: 'save'
        });
        if (nonceErr) {
          showToast('此操作已處理過，請勿重複提交。', 'error');
          onClose();
          return;
        }
      }

      // 1. Upload New Photos (in photoList order), build key→serverPath map
      const newPhotoPathMap = new Map<string, string>();
      for (const item of photoList) {
        if (item.kind === 'new') {
          const ext = item.file.name.split('.').pop() || 'jpg';
          const filePath = `expenses/${trip.id}/${crypto.randomUUID()}.${ext}`;
          const { error: uErr } = await supabase.storage.from(RECEIPTS_BUCKET).upload(filePath, item.file);
          if (uErr) throw uErr;
          newPhotoPathMap.set(item.key, filePath);
        }
      }

      // Preserve drag-reordered sequence
      const finalPhotoUrls = photoList.map(item =>
        item.kind === 'existing' ? item.url : newPhotoPathMap.get(item.key)!
      );

      // Ensure all amounts are numbers before saving and filter out zeros
      const finalPayerData: Record<string, number> = {};
      Object.entries(payerData).forEach(([m, v]) => {
        const num = Number(v) || 0;
        if (num !== 0) finalPayerData[m] = num;
      });

      const finalSplitData: Record<string, number> = {};
      Object.entries(splitData).forEach(([m, v]) => {
        const num = Number(v) || 0;
        if (num !== 0) finalSplitData[m] = num;
      });

      const record = {
        trip_id: trip.id, date, category, description: finalDescription, amount: numAmount, currency,
        payer_data: finalPayerData, split_data: finalSplitData, adjustment_member: adjustmentMember,
        photo_urls: finalPhotoUrls, is_settlement: false
      };

      let savedExpenseId: string | null = null;
      if (editData && editData.id) {
        // --- Update ---
        const { error: uErr } = await supabase.from('expenses').update(record).eq('id', editData.id);
        if (uErr) throw uErr;
        savedExpenseId = editData.id;
        showToast('已更新支出紀錄！');
      } else {
        // --- Insert ---
        const { data: saved, error: iErr } = await supabase.from('expenses').insert([record]).select('id').single();
        if (iErr) throw iErr;
        savedExpenseId = saved?.id ?? null;
        showToast('已新增支出紀錄！');
      }

      // --- LIFF 通知：透過 Edge Function 讓機器人推送確認訊息 ---
      if (liffMeta?.line_user_id) {
        const { error: invokeErr } = await supabase.functions.invoke('liff-notify', {
          body: {
            line_user_id: liffMeta.line_user_id,
            expense_id: savedExpenseId,
            description: finalDescription,
            amount: numAmount,
            currency,
          }
        });
        if (invokeErr) console.error('[LIFF] notify error:', invokeErr);
      }

      onSuccess();
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setLoading(false); }
  };

  const ValidationBadge = ({ isValid, current, target }: { isValid: boolean, current: number, target: number }) => (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-black transition-all ${isValid ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400' : 'bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400 animate-pulse'}`}>
      {isValid ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
      <span>{isValid ? '符合' : `不符: ${current.toFixed(precision)} / ${target}`}</span>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editData?.id ? "編輯支出紀錄" : "新增支出紀錄"}>
      <div className="w-full max-w-lg mx-auto overflow-hidden px-1">
        <form onSubmit={handleSubmit} className="space-y-6 max-h-[75vh] overflow-y-auto no-scrollbar py-2">
          
          {/* Header Info */}
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">支出描述<span className="ml-1 normal-case tracking-normal text-slate-300">(選填)</span></label>
              <div className="relative">
                <Receipt className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
                <input type="text" placeholder={`例如：機場晚餐（留空則記為「${category}」）`} className="w-full pl-11 pr-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 outline-none transition-all font-bold text-sm" value={description} onChange={e => setDescription(e.target.value)} />
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
                <input required autoFocus type="number" step="any" inputMode="decimal" placeholder="0.00" className="flex-1 min-w-0 px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border-2 border-transparent focus:border-blue-600 outline-none transition-all font-black text-lg" value={amount} onChange={e => setAmount(e.target.value)} />
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
            <button
              type="button"
              onClick={() => setShowPayerDetail(v => !v)}
              className="w-full flex items-center justify-between ml-1 pr-1 text-left group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest shrink-0 cursor-pointer">誰付的錢？</label>
                <ValidationBadge isValid={isPayerValid} current={payerSum} target={numAmount} />
                {!showPayerDetail && (
                  <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 truncate">{payerSummary}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <CreditCard size={14} className="text-slate-300" />
                <ChevronDown size={14} className={`text-slate-400 transition-transform ${showPayerDetail ? 'rotate-180' : ''}`} />
              </div>
            </button>
            <div className={`bg-slate-50/50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 ${showPayerDetail ? '' : 'hidden'}`}>
              {trip.members.map(member => (
                <div key={member} className="flex items-center justify-between p-3 gap-2">
                  <div className="flex items-center gap-2 shrink-0">
                    <input type="checkbox" className="w-4 h-4 rounded-lg accent-blue-600 cursor-pointer" checked={payerActive.has(member)} onChange={() => toggleActive(member, 'payer')} />
                    <span className={`text-[11px] sm:text-xs font-bold truncate max-w-[60px] sm:max-w-[100px] ${payerActive.has(member) ? 'text-slate-900 dark:text-white' : 'text-slate-300 dark:text-slate-600'}`}>{member}</span>
                  </div>
                  
                  <div className="flex items-center justify-end flex-1 gap-1 sm:gap-3 min-w-0">
                    {/* Percentage Input */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <input 
                        type="number" 
                        step="0.01"
                        placeholder="0"
                        disabled={!payerActive.has(member)}
                        className={`w-11 sm:w-16 text-right bg-slate-100 dark:bg-slate-800 rounded-lg px-1.5 py-1.5 text-[10px] sm:text-xs font-black outline-none transition-all ${payerLocked.has(member) ? 'text-emerald-600 ring-1 ring-emerald-500/30' : 'text-slate-500'}`}
                        value={numAmount > 0 ? new Decimal(Number(payerData[member] || 0)).dividedBy(numAmount).times(100).toDecimalPlaces(2).toString() : ''}
                        onChange={e => {
                          const pctStr = e.target.value;
                          if (pctStr === '') {
                            handleManualEdit(member, '0', 'payer');
                            return;
                          }
                          const pct = parseFloat(pctStr);
                          const newAmt = new Decimal(numAmount).times(pct).dividedBy(100);
                          handleManualEdit(member, newAmt.toString(), 'payer');
                        }}
                      />
                      <span className="text-[9px] font-black text-slate-300">%</span>
                    </div>

                    {/* Amount Input */}
                    <div className="shrink-0">
                      <input 
                        type="number" 
                        step="any" 
                        disabled={!payerActive.has(member)} 
                        placeholder="0" 
                        className={`w-16 sm:w-28 text-right bg-transparent font-black text-[11px] sm:text-sm outline-none transition-all ${payerLocked.has(member) ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-1 sm:px-2 py-1.5 rounded-lg' : 'text-slate-400'}`} 
                        value={payerData[member] ?? ''} 
                        onChange={e => handleManualEdit(member, e.target.value, 'payer')} 
                      />
                    </div>

                    <button type="button" onClick={() => setPayerLocked(prev => { const n = new Set(prev); if (n.has(member)) { n.delete(member); } else { n.add(member); } return n; })} disabled={!payerActive.has(member)} className={`p-1 transition-colors shrink-0 ${payerLocked.has(member) ? 'text-emerald-500' : 'text-slate-200'}`}>
                      {payerLocked.has(member) ? <Lock size={13} /> : <Unlock size={13} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Splitters */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setShowSplitDetail(v => !v)}
              className="w-full flex items-center justify-between ml-1 pr-1 text-left group"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest shrink-0 cursor-pointer">每人分攤</label>
                  <ValidationBadge isValid={isSplitValid} current={splitSum} target={numAmount} />
                  {!showSplitDetail && (
                    <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 truncate">{splitSummary}</span>
                  )}
                </div>
                {showSplitDetail && (
                  <p className="text-[8px] text-slate-400 font-medium">點擊 ⭐ 以指定成員吸收餘數</p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Coins size={14} className="text-slate-300" />
                <ChevronDown size={14} className={`text-slate-400 transition-transform ${showSplitDetail ? 'rotate-180' : ''}`} />
              </div>
            </button>
            <div className={`bg-slate-50/50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 ${showSplitDetail ? '' : 'hidden'}`}>
              {trip.members.map(member => (
                <div key={member} className="flex items-center justify-between p-3 gap-2">
                  <div className="flex items-center gap-2 shrink-0">
                    <input type="checkbox" className="w-4 h-4 rounded-lg accent-blue-600 cursor-pointer" checked={splitActive.has(member)} onChange={() => toggleActive(member, 'split')} />
                    <button type="button" onClick={() => setAdjustmentMember(member)} disabled={!splitActive.has(member)} className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border transition-all ${adjustmentMember === member ? 'bg-amber-500 text-white border-amber-500 shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-300 border-slate-200'}`}>
                      {adjustmentMember === member ? '⭐' : member.charAt(0)}
                    </button>
                    <span className={`text-[11px] sm:text-xs font-bold truncate max-w-[50px] sm:max-w-[100px] ${splitActive.has(member) ? 'text-slate-900 dark:text-white' : 'text-slate-300 dark:text-slate-600'}`}>{member}</span>
                  </div>

                  <div className="flex items-center justify-end flex-1 gap-1 sm:gap-3 min-w-0">
                    {/* Percentage Input */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <input 
                        type="number" 
                        step="0.01"
                        placeholder="0"
                        disabled={!splitActive.has(member)}
                        className={`w-11 sm:w-16 text-right bg-slate-100 dark:bg-slate-800 rounded-lg px-1.5 py-1.5 text-[10px] sm:text-xs font-black outline-none transition-all ${splitLocked.has(member) ? 'text-blue-600 ring-1 ring-blue-500/30' : 'text-slate-500'}`}
                        value={numAmount > 0 ? new Decimal(Number(splitData[member] || 0)).dividedBy(numAmount).times(100).toDecimalPlaces(2).toString() : ''}
                        onChange={e => {
                          const pctStr = e.target.value;
                          if (pctStr === '') {
                            handleManualEdit(member, '0', 'split');
                            return;
                          }
                          const pct = parseFloat(pctStr);
                          const newAmt = new Decimal(numAmount).times(pct).dividedBy(100);
                          handleManualEdit(member, newAmt.toString(), 'split');
                        }}
                      />
                      <span className="text-[9px] font-black text-slate-300">%</span>
                    </div>

                    {/* Amount Input */}
                    <div className="shrink-0">
                      <input 
                        type="number" 
                        step="any" 
                        disabled={!splitActive.has(member)} 
                        placeholder="0" 
                        className={`w-16 sm:w-28 text-right bg-transparent font-black text-[11px] sm:text-sm outline-none transition-all ${splitLocked.has(member) ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1 sm:px-2 py-1.5 rounded-lg' : 'text-slate-400'}`} 
                        value={splitData[member] ?? ''} 
                        onChange={e => handleManualEdit(member, e.target.value, 'split')} 
                      />
                    </div>

                    <button type="button" onClick={() => setSplitLocked(prev => { const n = new Set(prev); if (n.has(member)) { n.delete(member); } else { n.add(member); } return n; })} disabled={!splitActive.has(member)} className={`p-1 transition-colors shrink-0 ${splitLocked.has(member) ? 'text-blue-500' : 'text-slate-200'}`}>
                      {splitLocked.has(member) ? <Lock size={13} /> : <Unlock size={13} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Photos */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 ml-1">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">收據照片</label>
              {photoList.length > 1 && (
                <span className="flex items-center gap-1 text-[9px] text-slate-400 font-medium">
                  <GripVertical size={10} />拖拉可調整順序
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              {photoList.map((item, i) => {
                const src = item.kind === 'existing'
                  ? photoUrl(item.url)
                  : item.preview;
                const isDragging = dragIndex === i;
                const isDropTarget = dropTarget === i && dragIndex !== null && dragIndex !== i;
                return (
                  <div
                    key={item.key}
                    draggable
                    onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragIndex(i); }}
                    onDragEnter={e => { e.preventDefault(); setDropTarget(i); }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault();
                      if (dragIndex !== null && dragIndex !== i) {
                        setPhotoList(prev => {
                          const next = [...prev];
                          const [moved] = next.splice(dragIndex, 1);
                          next.splice(i, 0, moved);
                          return next;
                        });
                      }
                      setDragIndex(null);
                      setDropTarget(null);
                    }}
                    onDragEnd={() => { setDragIndex(null); setDropTarget(null); }}
                    className={`relative w-20 h-20 rounded-xl overflow-hidden border cursor-move transition-all select-none
                      ${isDragging ? 'opacity-40 scale-95' : ''}
                      ${isDropTarget ? 'ring-2 ring-blue-500 border-blue-400 scale-105' : item.kind === 'new' ? 'border-blue-200' : 'border-slate-200 dark:border-slate-700'}
                    `}
                  >
                    <img src={src} className="w-full h-full object-cover pointer-events-none" alt="photo" />
                    <button
                      type="button"
                      onClick={() => setPhotoList(prev => prev.filter(p => p.key !== item.key))}
                      className="absolute top-1 right-1 bg-rose-500 text-white p-1 rounded-full z-10"
                    >
                      <X size={10} />
                    </button>
                    <div className="absolute bottom-1 left-1 bg-black/30 rounded p-0.5 pointer-events-none">
                      <GripVertical size={10} className="text-white/80" />
                    </div>
                  </div>
                );
              })}
              <label className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 flex flex-col items-center justify-center text-slate-400 hover:border-blue-400 cursor-pointer">
                <Camera size={20} /><span className="text-[8px] font-bold mt-1">添加</span><input type="file" multiple accept="image/*" capture="environment" className="hidden" onChange={handlePhotoChange} />
              </label>
            </div>
          </div>

          {error && <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-xl flex items-center gap-3 text-red-600 dark:text-red-400 text-xs font-bold"><AlertCircle size={16} />{error}</div>}

          <div className="sticky bottom-0 -mx-1 px-1 pt-3 pb-1 bg-gradient-to-t from-white via-white to-white/0 dark:from-slate-800 dark:via-slate-800 dark:to-slate-800/0">
            <button disabled={loading} type="submit" className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white font-black py-4 rounded-xl shadow-lg transition-all flex items-center justify-center gap-2">
              {loading ? <Loader2 className="animate-spin" size={20} /> : (editData ? <Save size={20} /> : <Plus size={20} strokeWidth={3} />)}
              <span>{loading ? '儲存中...' : (editData?.id ? '儲存修改' : '確認新增支出')}</span>
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};

export default ExpenseModal;
