import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, TRIP_COLUMNS } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { RECEIPTS_BUCKET } from '../utils/storage';
import { isNotFoundError } from '../utils/supabaseErrors';

export interface UseTripDataResult {
  trip: Trip | null;
  expenses: Expense[];
  deletedExpenses: Expense[];
  siblingTrips: Trip[];
  loading: boolean;
  /** 首次載入完成後回傳 localStorage 中記住的身分，沒有則為 null */
  savedUser: string | null;
  refetchTrip: () => Promise<boolean>;
  refetchExpenses: () => Promise<boolean>;
  refetchDeleted: () => Promise<void>;
}

/**
 * 上次成功載入的旅程與帳目，存在這支手機上。
 * 離線時直接打開 App 也看得到帳、也能記帳（記的會排進 offlineQueue）。
 */
const cacheKey = (id: string) => `trip_cache_${id}`;

const readCache = (id: string): { trip?: Trip; expenses?: Expense[] } => {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(id)) || '{}');
  } catch {
    return {};
  }
};

const writeCache = (id: string, patch: { trip?: Trip; expenses?: Expense[] }) => {
  try {
    localStorage.setItem(cacheKey(id), JSON.stringify({ ...readCache(id), ...patch }));
  } catch {
    // 隱私模式或空間不足：只是少了離線備份，不影響線上使用
  }
};

/**
 * 旅程主資料的載入與即時同步。
 *
 * 訂閱兩件事：
 *   - expenses 的任何變動 → 重抓帳目與垃圾桶
 *   - 這筆 trip 的 UPDATE → 重抓旅程設定（否則別人改完成員/匯率，這邊要重新整理才看得到）
 *
 * 找不到旅程時會導回首頁。
 */
export const useTripData = (
  id: string | undefined,
  onTripMissing: () => void,
): UseTripDataResult => {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [deletedExpenses, setDeletedExpenses] = useState<Expense[]>([]);
  const [siblingTrips, setSiblingTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [savedUser, setSavedUser] = useState<string | null>(null);

  // 逾期垃圾桶紀錄的清理，每次載入頁面只執行一次。
  // fetchDeleted 也會被 realtime 事件呼叫，若每次都清理，多個裝置同時開著
  // 會重複對同一批 id 與照片下刪除指令。
  const purgeDoneRef = useRef(false);

  // 導頁 callback 放進 ref，避免它成為 effect 的相依而讓訂閱重建
  const onMissingRef = useRef(onTripMissing);
  onMissingRef.current = onTripMissing;

  const fetchSiblingTrips = useCallback(
    async (category: string | null | undefined, currentId: string) => {
      if (!supabase) { setSiblingTrips([]); return; }
      const trimmed = (category || '').trim();
      if (!trimmed) { setSiblingTrips([]); return; }
      try {
        const { data, error } = await supabase
          .from('trips')
          .select(TRIP_COLUMNS)
          .eq('category', trimmed)
          .neq('id', currentId)
          .order('created_at', { ascending: false });
        if (error) throw error;
        setSiblingTrips(data || []);
      } catch (err) {
        console.error(err);
        setSiblingTrips([]);
      }
    },
    [],
  );

  const refetchTrip = useCallback(async (): Promise<boolean> => {
    if (!supabase || !id) return false;
    try {
      // 已經通過通行碼關卡，`*` 含 access_code（設定頁要顯示）。其他地方一律用 TRIP_COLUMNS
      const { data, error } = await supabase.from('trips').select('*').eq('id', id).single();
      if (error) throw error;
      setTrip(data);
      writeCache(id, { trip: data });
      fetchSiblingTrips(data?.category, id);
      return true;
    } catch (err) {
      console.error(err);
      // 只有真的查無此旅程才導回首頁；網路暫時不通時保留畫面上的舊資料，
      // 等下一次 realtime 事件或回到前景再重抓
      if (isNotFoundError(err)) onMissingRef.current();
      return false;
    }
  }, [id, fetchSiblingTrips]);

  const refetchExpenses = useCallback(async (): Promise<boolean> => {
    if (!supabase || !id) return false;
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
      writeCache(id, { expenses: data || [] });
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }, [id]);

  const refetchDeleted = useCallback(async () => {
    if (!supabase || !id) return;
    try {
      // 保留期的 24 小時一律交給資料庫的時鐘判斷（RPC 裡用 now()），
      // 以前拿瀏覽器時間相減，裝置時間不準就會提早清空或永遠不清。
      const { data, error } = await supabase.rpc('list_trip_trash', { p_trip_id: id });
      if (error) throw error;
      setDeletedExpenses((data || []) as Expense[]);

      if (purgeDoneRef.current) return;

      const { data: expired, error: expiredError } = await supabase
        .rpc('list_expired_trash', { p_trip_id: id });
      if (expiredError) throw expiredError;
      // 查過一次就好：之後每個 realtime 事件都會呼叫這裡，沒必要每次都多打一支 RPC
      purgeDoneRef.current = true;

      const expiredRows = (expired || []) as { id: string; photo_urls: string[] | null }[];
      if (expiredRows.length === 0) return;

      const expiredPhotoUrls = expiredRows
        .flatMap((row) => row.photo_urls || [])
        .filter((url) => !!url);

      // 順序不能換：紀錄一消失就查不出該刪哪些照片
      if (expiredPhotoUrls.length > 0) {
        await supabase.storage.from(RECEIPTS_BUCKET).remove(expiredPhotoUrls);
      }
      // 兩次呼叫之間可能有人把紀錄還原，還原過的不能硬刪
      await supabase
        .from('expenses')
        .delete()
        .in('id', expiredRows.map((row) => row.id))
        .not('deleted_at', 'is', null);
    } catch (err) {
      console.error(err);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const init = async () => {
      setLoading(true);
      const [tripOk, expensesOk] = await Promise.all([refetchTrip(), refetchExpenses(), refetchDeleted()]);
      if (cancelled) return;
      // 連不上就拿上次存在手機上的那份（離線也能看、也能記）
      if (!tripOk || !expensesOk) {
        const cached = readCache(id);
        if (!tripOk && cached.trip) setTrip(cached.trip);
        if (!expensesOk && cached.expenses) setExpenses(cached.expenses);
      }
      setSavedUser(localStorage.getItem(`me_${id}`));
      setLoading(false);
    };
    init();

    if (!supabase) return () => { cancelled = true; };

    const channel = supabase
      .channel(`trip_changes_${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'expenses', filter: `trip_id=eq.${id}` },
        () => { refetchExpenses(); refetchDeleted(); },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${id}` },
        () => { refetchTrip(); },
      )
      .subscribe();

    // 回到前景時重新抓一次。
    // 手機把分頁切到背景或鎖螢幕時，realtime 的 websocket 會被中斷，
    // 期間發生的變更不會補送，光靠訂閱會一直顯示舊資料。
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refetchTrip();
        refetchExpenses();
        refetchDeleted();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      supabase.removeChannel(channel);
    };
  }, [id, refetchTrip, refetchExpenses, refetchDeleted]);

  return {
    trip,
    expenses,
    deletedExpenses,
    siblingTrips,
    loading,
    savedUser,
    refetchTrip,
    refetchExpenses,
    refetchDeleted,
  };
};
