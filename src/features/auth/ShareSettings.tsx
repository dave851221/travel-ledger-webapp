import React, { useState } from 'react';
import { AlertCircle, Check, Copy, Link2, Loader2, RefreshCw, UserPlus } from 'lucide-react';
import { supabase } from '../../api/supabase';
import { ui } from '../../components/ui';
import type { Trip } from '../../types';
import { siteRootUrl, useSession } from './session';
import { useMyMembership } from './membership';

type Visibility = 'members' | 'link' | 'password';

const VISIBILITY_OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: 'members', label: '只有成員', hint: '' },
  { value: 'link', label: '有連結就能看', hint: '不用登入' },
  { value: 'password', label: '連結＋密碼', hint: '要輸入密碼' },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 開放版旅程設定的「邀請與分享」（取代舊版的進入密碼）。
 *  · 邀請連結：拿到的人登入後就能加入記帳。所有成員都看得到、可以轉傳；只有 owner 能重設
 *  · 分享給沒登入的人看：只有 owner 能改
 * 權限都在資料庫檢查（app.set_trip_visibility／app.rotate_trip_token），這裡只是畫面。
 */
const ShareSettings: React.FC<{ trip: Trip; onChanged: () => void }> = ({ trip, onChanged }) => {
  const { session } = useSession();
  const { membership } = useMyMembership(trip.id, session?.user.id ?? null);
  // 隱私與連結：建立者與管理員可以改（資料庫的 set_trip_visibility／rotate_trip_token 用 is_admin 檢查）
  const isOwner = membership?.role === 'owner' || membership?.role === 'admin';

  const [visibility, setVisibility] = useState<Visibility>(trip.visibility ?? 'members');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = siteRootUrl();
  const inviteUrl = trip.invite_token ? `${base}#/join/${trip.id}/${trip.invite_token}` : '';
  const shareUrl = trip.share_token ? `${base}#/s/${trip.id}/${trip.share_token}` : '';

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const rotate = async (kind: 'invite' | 'share') => {
    setBusy(kind);
    setError(null);
    const { error: err } = await supabase.rpc('rotate_trip_token', { p_trip_id: trip.id, p_kind: kind });
    setBusy(null);
    if (err) { setError('重設失敗，請再試一次'); return; }
    onChanged();
  };

  const saveVisibility = async () => {
    if (visibility === 'password' && trip.visibility !== 'password' && password.length < 4) {
      setError('密碼至少 4 個字');
      return;
    }
    setBusy('visibility');
    setError(null);
    const { error: err } = await supabase.rpc('set_trip_visibility', {
      p_trip_id: trip.id,
      p_visibility: visibility,
      p_password: visibility === 'password' && password ? password : null,
    });
    setBusy(null);
    if (err) { setError(err.message.includes('invalid_password') ? '密碼要 4～64 個字' : '儲存失敗，請再試一次'); return; }
    setPassword('');
    onChanged();
  };

  const visibilityDirty = visibility !== (trip.visibility ?? 'members') || (visibility === 'password' && password.length > 0);

  return (
    <section className="rounded-2xl border border-line p-4 space-y-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-sunk text-ink-2 flex items-center justify-center shrink-0"><UserPlus size={18} /></span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold">邀請旅伴</p>
          <p className="text-xs text-muted mt-0.5">旅伴登入後就能一起記帳</p>
        </div>
      </div>
      <div className="flex gap-2">
        <input readOnly aria-label="邀請連結" className={`${ui.input} text-xs`} value={inviteUrl} onFocus={e => e.target.select()} />
        <button type="button" onClick={() => copy('invite', inviteUrl)} aria-label="複製邀請連結" className={`${ui.btnSecondary} px-4 shrink-0`}>
          {copied === 'invite' ? <Check size={18} className="text-pos" /> : <Copy size={18} />}
        </button>
      </div>
      {isOwner && (
        <button type="button" disabled={!!busy} onClick={() => rotate('invite')} className="text-xs text-ink-2 inline-flex items-center gap-1 hover:underline">
          {busy === 'invite' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}換一個新連結（舊的失效）
        </button>
      )}

      <div className="pt-4 border-t border-line space-y-3">
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-xl bg-sunk text-ink-2 flex items-center justify-center shrink-0"><Link2 size={18} /></span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold">分享給別人看</p>
            <p className="text-xs text-muted mt-0.5">{isOwner ? '對方只能看，不能記帳' : '對方只能看・由管理員設定'}</p>
          </div>
        </div>
        <div className="space-y-2" role="radiogroup" aria-label="分享設定">
          {VISIBILITY_OPTIONS.map(o => (
            <label key={o.value} className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${visibility === o.value ? 'border-ink bg-sunk' : 'border-line'} ${isOwner ? 'cursor-pointer' : 'opacity-70'}`}>
              <input
                type="radio"
                name="trip-visibility"
                className="mt-1"
                disabled={!isOwner}
                checked={visibility === o.value}
                onChange={() => setVisibility(o.value)}
              />
              <span>
                <span className="text-sm font-medium block">{o.label}</span>
                <span className="text-xs text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {isOwner && visibility === 'password' && (
          <input
            type="password"
            autoComplete="new-password"
            className={ui.input}
            placeholder={trip.visibility === 'password' ? '輸入新密碼（留空沿用原本的）' : '設定密碼（至少 4 個字）'}
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        )}
        {isOwner && visibilityDirty && (
          <button type="button" disabled={!!busy} onClick={saveVisibility} className={`${ui.btnPrimary} w-full`}>
            {busy === 'visibility' && <Loader2 size={16} className="animate-spin" />}儲存分享設定
          </button>
        )}
        {(trip.visibility === 'link' || trip.visibility === 'password') && shareUrl && (
          <>
            <div className="flex gap-2">
              <input readOnly aria-label="分享連結" className={`${ui.input} text-xs`} value={shareUrl} onFocus={e => e.target.select()} />
              <button type="button" onClick={() => copy('share', shareUrl)} aria-label="複製分享連結" className={`${ui.btnSecondary} px-4 shrink-0`}>
                {copied === 'share' ? <Check size={18} className="text-pos" /> : <Copy size={18} />}
              </button>
            </div>
            {isOwner && (
              <button type="button" disabled={!!busy} onClick={() => rotate('share')} className="text-xs text-ink-2 inline-flex items-center gap-1 hover:underline">
                {busy === 'share' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}換一個新連結（舊的失效）
              </button>
            )}
          </>
        )}
      </div>

      {error && <div className={ui.errorBox}><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>}
    </section>
  );
};

export default ShareSettings;
