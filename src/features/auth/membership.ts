/**
 * 開放版：我在這趟旅程裡是誰（app.trip_members 我自己那一列）。
 *
 * 舊版的「我是誰」只記在這台裝置（meKey）；開放版以資料庫為準，
 * 讀到之後也寫一份到 meKey，讓沿用那個鍵的地方（設定頁改名、離線打開）照常運作。
 * 切換成其他成員走 app.set_my_member（資料庫檢查名字在成員清單裡）。
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../api/supabase';
import { IS_PUBLIC, meKey } from '../../config/mode';

export interface Membership {
  memberName: string;
  role: 'owner' | 'editor';
}

/**
 * @param membersKey 成員清單有變（有人改名）時重抓 —— 我的名字可能被一起改掉了
 */
export function useMyMembership(tripId: string | undefined, userId: string | null, membersKey = '') {
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
    try { localStorage.setItem(meKey(tripId), data.member_name); } catch { /* ignore */ }
    return { memberName: data.member_name, role: data.role };
  }, [tripId, userId]);

  const refresh = useCallback(async () => {
    const m = await load().catch(() => null);
    if (m) setMembership(m);
  }, [load]);

  useEffect(() => {
    let alive = true;
    // 查不到（離線、網路斷）時保留上一次的結果，不要把「我是誰」清掉
    const run = () => { load().then(m => { if (alive && m) setMembership(m); }).catch(() => {}); };
    run();
    // 離線打開、或切到背景時別人改了名字：恢復連線、回到前景時再對一次
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, membersKey]);

  const switchMember = useCallback(async (name: string): Promise<boolean> => {
    if (!tripId) return false;
    const { error } = await supabase.rpc('set_my_member', { p_trip_id: tripId, p_member_name: name });
    if (error) return false;
    await refresh();
    return true;
  }, [tripId, refresh]);

  return { membership, refresh, switchMember };
}
