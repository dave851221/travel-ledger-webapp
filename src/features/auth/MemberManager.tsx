import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Crown, Loader2, LogOut, Shield, UserMinus } from 'lucide-react';
import { supabase } from '../../api/supabase';
import { ui } from '../../components/ui';
import type { Trip } from '../../types';
import Modal from '../../components/Modal';
import LoginBadges from './LoginBadges';
import type { LoginInfo } from './loginInfo';

type Role = 'owner' | 'admin' | 'editor';
interface Row { user_id: string; member_name: string; role: Role; logins: LoginInfo[] }

const ROLE_LABEL: Record<Role, string> = { owner: '建立者', admin: '管理員', editor: '成員' };

/**
 * 開放版：登入了這趟旅程的帳號（app.trip_members），與它們的權限。
 *  · 建立者：指定／取消管理員、移除任何人
 *  · 管理員：移除一般成員
 *  · 每個人都可以自己離開（建立者要先轉移才能離開，資料庫會擋）
 * 權限都在資料庫檢查（set_member_role、trip_members 的 RLS），這裡只決定按鈕要不要出現。
 */
const MemberManager: React.FC<{ trip: Trip; myUserId: string | null; myRole: Role | null; onLeft: () => void }> = ({
  trip, myUserId, myRole, onLeft,
}) => {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ row: Row; leave: boolean } | null>(null);

  const load = useCallback(async () => {
    // 帳號資訊（登入方式、LINE／Google 名稱、遮過的 email）由資料庫組好，不直接讀 auth 的資料
    const { data } = await supabase.rpc('trip_member_accounts', { p_trip_id: trip.id });
    return (data ?? []) as Row[];
  }, [trip.id]);

  useEffect(() => {
    let alive = true;
    load().then(r => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [load]);

  const refresh = async () => setRows(await load());

  const setRole = async (row: Row, role: 'admin' | 'editor') => {
    setBusy(row.user_id);
    setError(null);
    const { error: err } = await supabase.rpc('set_member_role', { p_trip_id: trip.id, p_user_id: row.user_id, p_role: role });
    setBusy(null);
    if (err) { setError('變更失敗，請再試一次'); return; }
    void refresh();
  };

  const remove = async (row: Row, leave: boolean) => {
    setBusy(row.user_id);
    setError(null);
    const { error: err, count } = await supabase.from('trip_members').delete({ count: 'exact' })
      .eq('trip_id', trip.id).eq('user_id', row.user_id);
    setBusy(null);
    setConfirm(null);
    if (err) {
      setError(err.message.includes('last_owner') ? '建立者要先把旅程轉給別人才能離開' : '移除失敗，請再試一次');
      return;
    }
    if (!count) { setError('沒有權限移除這位成員'); return; }
    if (leave) { onLeft(); return; }
    void refresh();
  };

  const canRemove = (row: Row) => row.user_id !== myUserId
    && (myRole === 'owner' || (myRole === 'admin' && row.role === 'editor'));

  return (
    <div className="space-y-2">
      <p className="text-sm font-bold">登入的成員 <span className="text-xs font-normal text-muted">· 用邀請連結加入的帳號</span></p>
      {rows === null ? (
        <div className="flex justify-center py-4 text-muted"><Loader2 className="animate-spin" size={18} /></div>
      ) : (
        <ul className="rounded-2xl border border-line divide-y divide-line">
          {rows.map(row => {
            const me = row.user_id === myUserId;
            const hasActions = (myRole === 'owner' && row.role !== 'owner') || canRemove(row) || (me && row.role !== 'owner');
            const actions = (
              <>
                {myRole === 'owner' && row.role !== 'owner' && (
                  <button
                    type="button"
                    disabled={busy === row.user_id}
                    onClick={() => setRole(row, row.role === 'admin' ? 'editor' : 'admin')}
                    className="text-xs text-ink-2 hover:text-ink rounded-lg border border-line px-2 py-1"
                  >
                    {row.role === 'admin' ? '取消管理員' : '設為管理員'}
                  </button>
                )}
                {canRemove(row) && (
                  <button type="button" onClick={() => setConfirm({ row, leave: false })} className="text-xs text-muted hover:text-neg inline-flex items-center gap-1 px-1 py-0.5">
                    <UserMinus size={13} />移除
                  </button>
                )}
                {me && row.role !== 'owner' && (
                  <button type="button" onClick={() => setConfirm({ row, leave: true })} className="text-xs text-neg hover:underline inline-flex items-center gap-1 px-1 py-0.5">
                    <LogOut size={13} />離開
                  </button>
            )}
              </>
            );
            return (
              // 一列一個帳號：左邊名字＋角色，下面是登入方式（跟「我的帳號」同一套排法），右邊是操作
              <li key={row.user_id} className="flex items-start gap-3 px-3 py-3">
                <span className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${
                  row.role === 'owner' ? 'bg-accent/20 text-ink' : 'bg-sunk text-ink-2'}`} aria-hidden>
                  {row.role === 'owner' ? <Crown size={16} className="text-accent" />
                    : row.role === 'admin' ? <Shield size={16} />
                    : (row.member_name.trim()[0] ?? '?')}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium">{row.member_name}</span>
                    {me && <span className="shrink-0 text-xs text-muted">（你）</span>}
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4 ${
                      row.role === 'editor' ? 'bg-sunk text-muted' : 'bg-accent/15 text-ink font-medium'}`}>{ROLE_LABEL[row.role]}</span>
                  </span>
                  <LoginBadges logins={row.logins ?? []} />
                  {/* 手機：操作放在名字下面一排，不跟登入資訊搶寬度；電腦放右邊 */}
                  {hasActions && <span className="sm:hidden flex flex-wrap items-center gap-2 mt-2">{actions}</span>}
                </span>
                {hasActions && <span className="hidden sm:flex shrink-0 flex-col items-end gap-1.5 pt-0.5">{actions}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <p className={ui.hint}>建立者可以指定管理員。管理員能改旅程名稱、隱私與成員；一般成員能記帳、改預設值、匯率和分類。</p>
      {error && <div className={ui.errorBox}><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>}

      <Modal isOpen={!!confirm} onClose={() => setConfirm(null)} title={confirm?.leave ? '離開這趟旅程？' : '移除這位成員？'}>
        {confirm && (
          <div className="space-y-4">
            <p className="text-sm text-ink-2">
              {confirm.leave
                ? '離開後就看不到這趟旅程了，要再加入需要新的邀請連結。帳目裡你的名字會留著。'
                : `「${confirm.row.member_name}」的帳號會被移出這趟旅程，帳目裡的名字會留著。`}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirm(null)} className={`${ui.btnSecondary} flex-1`}>取消</button>
              <button type="button" disabled={busy !== null} onClick={() => remove(confirm.row, confirm.leave)} className={`${ui.btnPrimary} flex-1`}>
                {busy && <Loader2 size={16} className="animate-spin" />}{confirm.leave ? '離開' : '移除'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default MemberManager;
