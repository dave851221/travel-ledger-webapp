import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { RECEIPTS_BUCKET } from '../utils/storage';

/** 垃圾桶保留時間。超過就在下次載入頁面時永久刪除。 */
const TRASH_RETENTION_HOURS = 24;

export interface UseTripDataResult {
  trip: Trip | null;
  expenses: Expense[];
  deletedExpenses: Expense[];
  siblingTrips: Trip[];
  loading: boolean;
  /** 首次載入完成後回傳 localStorage 中記住的身分，沒有則為 null */
  savedUser: string | null;
  refetchTrip: () => Promise<void>;
  refetchExpenses: () => Promise<void>;
  refetchDeleted: () => Promise<void>;
}

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
          .select('*')
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

  const refetchTrip = useCallback(async () => {
    if (!supabase || !id) return;
    try {
      const { data, error } = await supabase.from('trips').select('*').eq('id', id).single();
      if (error) throw error;
      setTrip(data);
      fetchSiblingTrips(data?.category, id);
    } catch (err) {
      console.error(err);
      onMissingRef.current();
    }
  }, [id, fetchSiblingTrips]);

  const refetchExpenses = useCallback(async () => {
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
    } catch (err) {
      console.error(err);
    }
  }, [id]);

  const refetchDeleted = useCallback(async () => {
    if (!supabase || !id) return;
    try {
      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .eq('trip_id', id)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
      if (error) throw error;

      const now = new Date();
      const validDeleted: Expense[] = [];
      const expiredIds: string[] = [];
      const expiredPhotoUrls: string[] = [];

      (data || []).forEach((exp: Expense) => {
        if (!exp.deleted_at) return;
        const hoursDiff = (now.getTime() - new Date(exp.deleted_at).getTime()) / (1000 * 60 * 60);
        if (hoursDiff <= TRASH_RETENTION_HOURS) {
          validDeleted.push(exp);
        } else {
          expiredIds.push(exp.id);
          (exp.photo_urls || []).forEach((url) => { if (url) expiredPhotoUrls.push(url); });
        }
      });

      if (expiredIds.length > 0 && !purgeDoneRef.current) {
        purgeDoneRef.current = true;
        if (expiredPhotoUrls.length > 0) {
          await supabase.storage.from(RECEIPTS_BUCKET).remove(expiredPhotoUrls);
        }
        await supabase.from('expenses').delete().in('id', expiredIds);
      }

      setDeletedExpenses(validDeleted);
    } catch (err) {
      console.error(err);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const init = async () => {
      setLoading(true);
      await Promise.all([refetchTrip(), refetchExpenses(), refetchDeleted()]);
      if (cancelled) return;
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
