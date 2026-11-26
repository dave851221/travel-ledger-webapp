/**
 * 開放版：我在這趟旅程裡是誰（app.trip_members 我自己那一列）。
 *
 * 舊版的「我是誰」記在 localStorage 的 me_{tripId}；開放版以資料庫為準，
 * 讀到之後也寫一份到 me_{tripId}，讓沿用那個鍵的地方（設定頁改名、快取）照常運作。
 * 切換成其他成員走 app.set_my_member（資料庫檢查名字在成員清單裡）。
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../api/supabase';
import { IS_PUBLIC } from '../../config/mode';

export interface Membership {
  memberName: string;
  role: 'owner' | 'editor';
}

export function useMyMembership(tripId: string | undefined, userId: string | null) {
  const [membership, setMembership] = useState<Membership | null>(null);

  const load = useCallback(async (): Promise<Membership | null> => {
    if (!IS_PUBLIC || !tripId || !userId) return null;
    const { data } = await supabase
      .from('trip_members')
      .select('member_name, role')
      .eq('trip_id', tripId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) return null;
    try { localStorage.setItem(`me_${tripId}`, data.member_name); } catch { /* ignore */ }
    return { memberName: data.member_name, role: data.role };
  }, [tripId, userId]);

  const refresh = useCallback(async () => { setMembership(await load()); }, [load]);

  useEffect(() => {
    let alive = true;
    load().then(m => { if (alive) setMembership(m); });
    return () => { alive = false; };
  }, [load]);

  const switchMember = useCallback(async (name: string): Promise<boolean> => {
    if (!tripId) return false;
    const { error } = await supabase.rpc('set_my_member', { p_trip_id: tripId, p_member_name: name });
    if (error) return false;
    await refresh();
    return true;
  }, [tripId, refresh]);

  return { membership, refresh, switchMember };
}
