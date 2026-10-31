import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  X,
  ImagePlus,
  Lock,
  Unlock,
  AlertCircle,
  Loader2,
  Plus,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  Save,
  GripVertical,
  Star,
  Receipt,
  ShoppingBag
} from 'lucide-react';
import Modal from './Modal';
import { ui } from './ui';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { calculateDistribution, getCurrencyPrecision } from '../utils/finance';
import { getLocalDateString } from '../utils/date';
import { getDefaultCategory, getDefaultCurrency } from '../utils/tripDefaults';
import { photoUrl, RECEIPTS_BUCKET } from '../utils/storage';
import { insertExpenseOrQueue } from '../utils/offlineQueue';
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
  
  // Photo State — unified ordered list for drag-to-reorder support.
  // `receipt` decides which half of the album the photo lands in (receipts vs item photos).
  type PhotoEntry =
    | { kind: 'existing'; key: string; url: string; receipt: boolean }
    | { kind: 'new'; key: string; file: File; preview: string; receipt: boolean };
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

  // 兩張成員表預設收合。以五人旅程為例，展開時光是這兩區就有 50 個控制項
  // 擋在金額欄與送出鍵之間；多數記帳其實直接套用預設值即可。
  // 只要偵測到不是「單一付款人 + 全員均分」的單純情況，就自動展開。
  // 判斷寫在下面的初始化 effect 裡：這裡若另開一個 effect 讀 payerActive／splitActive，
  // 讀到的會是「上一次開啟」留下的舊值（初始化的 setState 還沒生效）。
  const [showPayerDetail, setShowPayerDetail] = useState(false);
  const [showSplitDetail, setShowSplitDetail] = useState(false);

  const payerSignature = `${numAmount}|${[...payerActive].sort().join(',')}`;
  const splitSignature = `${numAmount}|${[...splitActive].sort().join(',')}|${adjustmentMember ?? ''}`;

  // Auto-recalculate Payers (only if not manually locked everything).
  // The locked amounts are read from `prev` inside the updater: listing payerData as a
  // dependency would re-run this effect on every write it makes.
  useEffect(() => {
    if (payerBaselineRef.current === payerSignature) return;
    if (payerLocked.size === payerActive.size && payerLocked.size > 0) return;
    setPayerData(prev => {
      const newData = runDistribution(numAmount, payerActive, payerLocked, prev, null);
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
    setSplitData(prev => {
      const newData = runDistribution(numAmount, splitActive, splitLocked, prev, adjustmentMember);
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
  //
  // 只在「開啟的那一刻」或「換了一筆要編輯的資料」時灌入初始值。
  // Dashboard 在回到前景（手機開相機／相簿選照片回來就會觸發）與別人存設定時都會重抓 trip，
  // trip.members 每次都是新陣列；若跟著它重設，使用者填到一半的內容會整個被清掉。
  const initializedFor = useRef<{ editData: Expense | null | undefined } | null>(null);
  useEffect(() => {
    if (!isOpen) {
      initializedFor.current = null;
      return;
    }
    if (initializedFor.current && initializedFor.current.editData === editData) return;
    initializedFor.current = { editData };
    setError(null);
    setLoading(false);
    if (editData) {
      // --- Edit Mode ---
      // LINE 的照片記帳草稿還沒有金額（以 0 占位）：金額欄留空讓人直接輸入，
      // 參與者改看「有沒有列在名單上」—— 每個人都是 0，照「金額不是 0」判斷會一個都勾不到
      const noAmountYet = !(Number(editData.amount) > 0);
      const participants = (data: Record<string, number>) => Object.entries(data)
        .filter(([, v]) => noAmountYet || (Number(v) || 0) !== 0)
        .map(([m]) => m);
      setDescription(editData.description);
      setAmount(noAmountYet ? '' : editData.amount.toString());
      setCurrency(editData.currency);
      setDate(editData.date);
      setCategory(editData.category);
      setAdjustmentMember(editData.adjustment_member);
      const receipts = new Set(editData.receipt_photo_urls ?? []);
      setPhotoList((editData.photo_urls || []).map(url => ({ kind: 'existing' as const, key: url, url, receipt: receipts.has(url) })));
      setDragIndex(null);
      setDropTarget(null);

      // Set Payers (who is listed — see noAmountYet above)
      const pActive = new Set(participants(editData.payer_data));
      setPayerActive(pActive);
      setPayerData(editData.payer_data);
      setPayerLocked(new Set());
      // 還沒有金額時沒有「原本的分帳」要保留，一輸入金額就照名單重新分配
      payerBaselineRef.current = noAmountYet ? null
        : `${editData.amount}|${[...pActive].sort().join(',')}`;

      // Set Splitters (who is listed — see noAmountYet above)
      const sActive = new Set(participants(editData.split_data));
      setSplitActive(sActive);
      setSplitData(editData.split_data);
      setSplitLocked(new Set());
      splitBaselineRef.current = noAmountYet ? null
        : `${editData.amount}|${[...sActive].sort().join(',')}|${editData.adjustment_member ?? ''}`;

      setShowPayerDetail(pActive.size > 1);
      setShowSplitDetail(sActive.size > 0 && sActive.size !== trip.members.length);
    } else {
      // --- New Mode ---
      setDescription('');
      setAmount('');
      setCurrency(getDefaultCurrency(trip));
      setDate(getLocalDateString());
      setCategory(getDefaultCategory(trip));
      setPhotoList([]);
      setDragIndex(null);
      setDropTarget(null);

      const defaultPayers = (trip.default_payer ?? []).filter(m => trip.members.includes(m));
      // currentUser 可能是已被改名或移除的舊名字，不是成員就不能當付款人（與 quickAdd 一致）
      const activePayers = defaultPayers.length > 0
        ? new Set(defaultPayers)
        : new Set([currentUser && trip.members.includes(currentUser) ? currentUser : trip.members[0]]);
      setPayerActive(activePayers);
      setPayerLocked(new Set());
      setPayerData({});
      payerBaselineRef.current = null;

      const defaultSplit = trip.default_split_members?.length
        ? new Set(trip.default_split_members.filter(m => trip.members.includes(m)))
        : new Set(trip.members);
      const activeSplit = defaultSplit.size > 0 ? defaultSplit : new Set(trip.members);
      setSplitActive(activeSplit);
      setSplitLocked(new Set());
      setSplitData({});
      splitBaselineRef.current = null;

      setShowPayerDetail(activePayers.size > 1);
      setShowSplitDetail(activeSplit.size !== trip.members.length);

      // adjMember: 優先 currentUser（若在預設付款人中）→ 第一個預設付款人 → 第一位成員
      const adjMember = activePayers.has(currentUser || '')
        ? currentUser!
        : [...activePayers][0] ?? trip.members[0];
      setAdjustmentMember(adjMember);
    }
  }, [isOpen, editData, trip, currentUser]);

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
    if (names.length === 1) return `只有${names[0]}`;
    return `${names.length} 人分攤`;
  }, [splitActive, trip.members.length]);

  const payerSum = useMemo(() => Object.values(payerData).reduce<number>((a, b) => a + (Number(b) || 0), 0), [payerData]);
  const splitSum = useMemo(() => Object.values(splitData).reduce<number>((a, b) => a + (Number(b) || 0), 0), [splitData]);

  const isPayerValid = Math.abs(payerSum - numAmount) < 0.01;
  const isSplitValid = Math.abs(splitSum - numAmount) < 0.01;

  // Handlers
  const toggleActive = (member: string, type: 'payer' | 'split') => {
    // 勾掉再勾回來時 signature 會變回基準值，不清掉的話自動重算會被略過
    (type === 'payer' ? payerBaselineRef : splitBaselineRef).current = null;
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

  const isAllActive = (type: 'payer' | 'split') => {
    const active = type === 'payer' ? payerActive : splitActive;
    return trip.members.every(m => active.has(m));
  };

  // 全選；已經全選時改成全部取消。全選時鎖定的金額照舊保留，其餘的人分掉剩下的
  const toggleAll = (type: 'payer' | 'split') => {
    const allActive = isAllActive(type);
    (type === 'payer' ? payerBaselineRef : splitBaselineRef).current = null;
    if (type === 'payer') {
      setPayerActive(allActive ? new Set() : new Set([...payerActive, ...trip.members]));
      if (allActive) {
        setPayerData({});
        setPayerLocked(new Set());
      }
    } else {
      setSplitActive(allActive ? new Set() : new Set([...splitActive, ...trip.members]));
      if (allActive) {
        setSplitData({});
        setSplitLocked(new Set());
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

  // 百分比欄的值是從金額反算的；正在輸入的那一格改顯示使用者打的原字串，
  // 否則打到「33.」時會被重算成「33」，小數點就打不出來
  const [pctDraft, setPctDraft] = useState<{ key: string; value: string } | null>(null);

  const pctValue = (member: string, type: 'payer' | 'split') => {
    const key = `${type}:${member}`;
    if (pctDraft?.key === key) return pctDraft.value;
    const data = type === 'payer' ? payerData : splitData;
    return numAmount > 0
      ? new Decimal(Number(data[member]) || 0).dividedBy(numAmount).times(100).toDecimalPlaces(2).toString()
      : '';
  };

  const handlePctChange = (member: string, pctStr: string, type: 'payer' | 'split') => {
    setPctDraft({ key: `${type}:${member}`, value: pctStr });
    if (pctStr === '') {
      handleManualEdit(member, '0', type);
      return;
    }
    const pct = parseFloat(pctStr);
    if (!isFinite(pct)) return;
    handleManualEdit(member, new Decimal(numAmount).times(pct).dividedBy(100).toString(), type);
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    // 清掉 input 的值：否則刪掉一張照片後再選同一張，onChange 不會觸發
    e.target.value = '';
    if (files.length === 0) return;
    setLoading(true);
    const newEntries: PhotoEntry[] = [];
    for (const file of files) {
      try {
        const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1280, useWebWorker: true };
        const compressed = await imageCompression(file, options);
        // 自己上傳的照片預設是商品照片；是收據的話點縮圖下方切換
        newEntries.push({ kind: 'new', key: `new-${crypto.randomUUID()}`, file: compressed, preview: URL.createObjectURL(compressed), receipt: false });
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
    // 日期欄可以被清空，送出去只會得到資料庫看不懂的英文錯誤
    if (!date) {
      setError('請選擇日期');
      return;
    }
    if (!isPayerValid || !isSplitValid) {
      setError('金額分配與總額不符，請檢查付款或分攤明細');
      return;
    }
    // 描述留空時用分類名代入，讓「只打金額」也能成立
    const finalDescription = description.trim() || category;

    const liffMeta = editData as (Expense & { nonce?: string; line_user_id?: string }) | null;
    // 離線時只能新增（排進 offlineQueue）。照片要上傳、修改要對照資料庫，都得等連線
    if (!navigator.onLine) {
      if (editData?.id || liffMeta?.nonce) {
        setError('目前離線，無法修改既有的支出，恢復連線後再試一次');
        return;
      }
      if (photoList.some(p => p.kind === 'new')) {
        setError('目前離線，無法上傳照片。可以先拿掉照片存起來，連線後再編輯補上');
        return;
      }
    }
    let nonceLocked = false;
    // 這次存檔上傳的照片。存檔失敗時要刪掉，不然會變成 Storage 裡沒人用的檔案
    const uploadedPaths: string[] = [];
    try {
      setLoading(true);
      setError(null);

      // --- LIFF 防重複：在所有操作前先佔用 nonce ---
      // 若 nonce 已被 LINE 的「確認存入」或「取消」使用，則中止，避免重複寫入
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
        nonceLocked = true;
      }

      // 1. Upload New Photos (in photoList order), build key→serverPath map
      const newPhotoPathMap = new Map<string, string>();
      for (const item of photoList) {
        if (item.kind === 'new') {
          const ext = item.file.name.split('.').pop() || 'jpg';
          const filePath = `expenses/${trip.id}/${crypto.randomUUID()}.${ext}`;
          const { error: uErr } = await supabase.storage.from(RECEIPTS_BUCKET).upload(filePath, item.file);
          if (uErr) throw uErr;
          uploadedPaths.push(filePath);
          newPhotoPathMap.set(item.key, filePath);
        }
      }

      // Preserve drag-reordered sequence
      const finalPhotoUrls = photoList.map(item =>
        item.kind === 'existing' ? item.url : newPhotoPathMap.get(item.key)!
      );
      const finalReceiptUrls = finalPhotoUrls.filter((_, i) => photoList[i].receipt);

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
        // 結清紀錄也可能被編輯（例如從 LINE 的編輯清單開進來）。
        // 硬寫 false 會把它變成一般支出，統計立刻失真。
        photo_urls: finalPhotoUrls, receipt_photo_urls: finalReceiptUrls,
        is_settlement: editData?.is_settlement ?? false
      };

      let savedExpenseId: string | null = null;
      if (editData && editData.id) {
        // --- Update ---
        const { error: uErr } = await supabase.from('expenses').update(record).eq('id', editData.id);
        if (uErr) throw uErr;
        savedExpenseId = editData.id;
        // 編輯時被移除的舊照片：資料已經更新成功，才去刪 Storage 裡的檔案
        // （順序不能反，否則更新失敗時紀錄會指向已刪掉的照片）
        const removedPhotos = (editData.photo_urls || []).filter(url => url && !finalPhotoUrls.includes(url));
        if (removedPhotos.length > 0) {
          const { error: rmErr } = await supabase.storage.from(RECEIPTS_BUCKET).remove(removedPhotos);
          if (rmErr) console.error('[PHOTO] failed to remove replaced photos:', rmErr);
        }
        showToast('已更新支出紀錄！');
      } else {
        // --- Insert --- 連不上時排進離線佇列（LIFF 草稿除外：它要通知機器人，得真的寫進去）
        if (liffMeta?.line_user_id) {
          const { data: saved, error: iErr } = await supabase.from('expenses').insert([record]).select('id').single();
          if (iErr) throw iErr;
          savedExpenseId = saved?.id ?? null;
          showToast('已新增支出紀錄！');
        } else {
          const { id: savedId, queued } = await insertExpenseOrQueue(record);
          savedExpenseId = savedId;
          showToast(queued ? '目前離線，已先存在手機，恢復連線後會自動上傳' : '已新增支出紀錄！');
        }
      }

      // --- LIFF 通知：透過 Edge Function 讓機器人推送確認訊息 ---
      // ⚠️ 一定要帶 mode（M11）。少了它，liff-notify 會把「編輯既有支出」也記成
      //    一筆 `saved`，使用者接著說「取消上一筆」就會刪掉那筆剛編輯好的舊支出，
      //    而不是最近新增的那一筆；推播文字也會謊稱「已存入」。
      if (liffMeta?.line_user_id) {
        const { error: invokeErr } = await supabase.functions.invoke('liff-notify', {
          body: {
            line_user_id: liffMeta.line_user_id,
            expense_id: savedExpenseId,
            description: finalDescription,
            amount: numAmount,
            currency,
            mode: editData?.id ? 'update' : 'insert',
          }
        });
        if (invokeErr) console.error('[LIFF] notify error:', invokeErr);
      }

      onSuccess();
      onClose();
    } catch (err) {
      if (uploadedPaths.length > 0) {
        await supabase.storage.from(RECEIPTS_BUCKET).remove(uploadedPaths).catch(() => {});
      }
      // 上傳或寫入失敗時把 nonce 鎖放掉，否則那張 LINE 卡片之後再也存不進去
      if (nonceLocked && liffMeta?.nonce) {
        await supabase.from('line_processed_actions').delete().eq('nonce', liffMeta.nonce);
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  };

  const ValidationBadge = ({ isValid, current, target }: { isValid: boolean, current: number, target: number }) => (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium ${isValid ? 'bg-pos/10 text-pos' : 'bg-neg/10 text-neg'}`}>
      {isValid ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
      <span className="num">{isValid ? '金額相符' : `${current.toFixed(precision)} / ${target}`}</span>
    </span>
  );

  // 付款與分攤兩張成員表的共用畫法；兩邊的差別只在資料來源與「吸收尾差」的星號
  const renderMemberRows = (type: 'payer' | 'split') => {
    const active = type === 'payer' ? payerActive : splitActive;
    const locked = type === 'payer' ? payerLocked : splitLocked;
    const data = type === 'payer' ? payerData : splitData;
    const setLocked = type === 'payer' ? setPayerLocked : setSplitLocked;
    return (
      <ul className="border border-line rounded-xl divide-y divide-line">
        {trip.members.map(member => {
          const on = active.has(member);
          const isLocked = locked.has(member);
          return (
            <li key={member} className="flex items-center gap-2 pl-2.5 pr-1.5 py-2">
              <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-[18px] h-[18px] rounded accent-[var(--app-primary)] cursor-pointer shrink-0"
                  checked={on}
                  onChange={() => toggleActive(member, type)}
                />
                <span className={`text-sm truncate ${on ? 'text-ink' : 'text-muted'}`}>{member}</span>
              </label>
              {type === 'split' && (
                <button
                  type="button"
                  onClick={() => setAdjustmentMember(member)}
                  disabled={!on}
                  aria-label={`由 ${member} 吸收尾差`}
                  aria-pressed={adjustmentMember === member}
                  className={`p-1 shrink-0 transition-colors disabled:opacity-30 ${adjustmentMember === member ? 'text-accent' : 'text-line hover:text-muted'}`}
                >
                  <Star size={15} className={adjustmentMember === member ? 'fill-accent' : ''} />
                </button>
              )}
              <div className="flex items-center gap-0.5 shrink-0">
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`${member} 百分比`}
                  disabled={!on}
                  className={`num w-[58px] text-right rounded-lg bg-sunk border px-1.5 py-1.5 text-base sm:text-xs outline-none transition disabled:opacity-40 ${isLocked ? 'border-ink-2 text-ink' : 'border-transparent text-ink-2'}`}
                  value={pctValue(member, type)}
                  onChange={e => handlePctChange(member, e.target.value, type)}
                  onBlur={() => setPctDraft(null)}
                />
                <span className="text-[11px] text-muted">%</span>
              </div>
              <input
                type="number"
                step="any"
                inputMode="decimal"
                placeholder="0"
                aria-label={`${member} 金額`}
                disabled={!on}
                className={`num w-[86px] sm:w-28 text-right rounded-lg border px-2 py-1.5 text-base sm:text-sm font-bold outline-none transition disabled:opacity-40 shrink-0 ${isLocked ? 'bg-accent/10 border-accent/40 text-ink' : 'bg-transparent border-transparent text-ink-2'}`}
                value={data[member] ?? ''}
                onChange={e => handleManualEdit(member, e.target.value, type)}
              />
              <button
                type="button"
                onClick={() => setLocked(prev => { const n = new Set(prev); if (n.has(member)) { n.delete(member); } else { n.add(member); } return n; })}
                disabled={!on}
                aria-label={isLocked ? `解除鎖定 ${member} 的金額` : `鎖定 ${member} 的金額`}
                aria-pressed={isLocked}
                className={`p-1.5 shrink-0 transition-colors disabled:opacity-30 ${isLocked ? 'text-ink' : 'text-muted/60 hover:text-muted'}`}
              >
                {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  const sectionHeader = (type: 'payer' | 'split', title: string, open: boolean, toggle: () => void, valid: boolean, sum: number, summary: string) => (
    <div className="relative">
      <button type="button" onClick={toggle} aria-expanded={open} className="w-full flex items-center gap-2 py-1 text-left">
        <span className="text-sm font-bold text-ink shrink-0">{title}</span>
        <ValidationBadge isValid={valid} current={sum} target={numAmount} />
        {!open && <span className="text-sm text-ink-2 truncate min-w-0">{summary}</span>}
        <ChevronDown size={16} className={`ml-auto shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* 標題列本身是按鈕，不能巢狀，所以疊在上面 */}
      {open && (
        <button
          type="button"
          onClick={() => toggleAll(type)}
          className="absolute right-6 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg bg-sunk text-xs font-medium text-ink-2 hover:text-ink transition-colors"
        >
          {isAllActive(type) ? '全部取消' : '全選'}
        </button>
      )}
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editData?.id ? '編輯支出' : '新增支出'} maxWidth="sm:max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="flex gap-2">
          <div className="relative w-[104px] shrink-0">
            <select
              aria-label="幣別"
              className={`${ui.select} num font-bold appearance-none pr-8 h-full`}
              value={currency}
              onChange={e => setCurrency(e.target.value)}
            >
              {[...new Set([...Object.keys(trip.rates), currency].filter(Boolean))].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" size={14} />
          </div>
          <input
            required
            autoFocus
            type="number"
            step="any"
            inputMode="decimal"
            placeholder="0"
            aria-label="金額"
            className={`${ui.input} num flex-1 min-w-0 text-2xl sm:text-2xl font-extrabold py-2.5`}
            value={amount}
            onChange={e => setAmount(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="exp-desc" className={ui.label}>項目 <span className="text-muted font-normal">· 選填，留空會記成「{category}」</span></label>
          <input id="exp-desc" type="text" placeholder="例如：機場晚餐" className={ui.input} value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="exp-date" className={ui.label}>日期</label>
            <input id="exp-date" type="date" className={`${ui.input} num`} value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="exp-cat" className={ui.label}>分類</label>
            <select id="exp-cat" className={ui.select} value={category} onChange={e => setCategory(e.target.value)}>
              {/* 編輯「結清」或已從清單移除的分類時，原值也要顯示，否則畫面與實際存入的值不一致 */}
              {[...new Set([...trip.categories, category].filter(Boolean))].map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </div>
        </div>

        <section className="space-y-2">
          {sectionHeader('payer', '誰付錢', showPayerDetail, () => setShowPayerDetail(v => !v), isPayerValid, payerSum, payerSummary)}
          {showPayerDetail && renderMemberRows('payer')}
        </section>

        <section className="space-y-2">
          {sectionHeader('split', '怎麼分', showSplitDetail, () => setShowSplitDetail(v => !v), isSplitValid, splitSum, splitSummary)}
          {showSplitDetail && (
            <>
              {renderMemberRows('split')}
              <p className={ui.hint}>除不盡的尾差由 <Star size={11} className="inline fill-accent text-accent -mt-0.5" /> 標記的人吸收；鎖定的金額不會被重新分配。</p>
            </>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold">照片</span>
            {photoList.length > 0 && <span className="text-xs text-muted">點標籤切換收據／商品</span>}
            {photoList.length > 1 && (
              <span className="flex items-center gap-1 text-xs text-muted"><GripVertical size={12} />拖拉可調整順序</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2.5">
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
                  className={`relative w-20 h-20 rounded-xl overflow-hidden border cursor-move transition select-none
                    ${isDragging ? 'opacity-40 scale-95' : ''}
                    ${isDropTarget ? 'ring-2 ring-accent border-accent scale-105' : 'border-line'}
                  `}
                >
                  <img src={src} className="w-full h-full object-cover pointer-events-none" alt={`照片 ${i + 1}`} />
                  <button
                    type="button"
                    aria-pressed={item.receipt}
                    aria-label={item.receipt ? '收據照片，點一下改成商品照片' : '商品照片，點一下改成收據照片'}
                    onClick={() => setPhotoList(prev => prev.map(p => p.key === item.key ? { ...p, receipt: !p.receipt } : p))}
                    className={`absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-1 py-1 text-[11px] font-medium
                      ${item.receipt ? 'bg-accent text-on-accent' : 'bg-black/60 text-white'}`}
                  >
                    {item.receipt ? <Receipt size={11} /> : <ShoppingBag size={11} />}
                    {item.receipt ? '收據' : '商品'}
                  </button>
                  <button
                    type="button"
                    aria-label="移除這張照片"
                    onClick={() => setPhotoList(prev => prev.filter(p => p.key !== item.key))}
                    className="absolute top-1 right-1 bg-black/60 text-white p-1 rounded-full z-10"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
            <label className="w-20 h-20 rounded-xl border border-dashed border-ink-2/40 flex flex-col items-center justify-center text-ink-2 hover:bg-sunk cursor-pointer transition-colors">
              <ImagePlus size={20} /><span className="text-[11px] mt-1">加照片</span>
              <input type="file" multiple accept="image/*" className="hidden" onChange={handlePhotoChange} />
            </label>
          </div>
        </section>

        {error && <div className={ui.errorBox} role="alert"><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>}

        <div className="sticky bottom-0 -mx-5 px-5 pt-3 -mb-1 bg-gradient-to-t from-surface from-70% to-transparent">
          <button disabled={loading} type="submit" className={`${ui.btnPrimary} w-full py-3.5 text-[15px]`}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : (editData?.id ? <Save size={18} /> : <Plus size={18} strokeWidth={2.6} />)}
            {loading ? '儲存中…' : (editData?.id ? '儲存修改' : '新增支出')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default ExpenseModal;
