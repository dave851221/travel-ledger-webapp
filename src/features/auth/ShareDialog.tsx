import React, { useState } from 'react';
import { Check, Copy, Eye, Loader2, UserPlus } from 'lucide-react';
import { supabase } from '../../api/supabase';
import Modal from '../../components/Modal';
import { ui } from '../../components/ui';
import type { Trip } from '../../types';
import { useMyMembership } from './membership';
import { siteRootUrl, useSession } from './session';

const LinkRow: React.FC<{ url: string; copied: boolean; onCopy: () => void }> = ({ url, copied, onCopy }) => (
  <div className="flex gap-2">
    <input readOnly className={`${ui.input} text-xs`} value={url} onFocus={e => e.target.select()} aria-label="連結" />
    <button type="button" onClick={onCopy} className={`${ui.btnPrimary} px-4 shrink-0`}>
      {copied ? <Check size={16} /> : <Copy size={16} />}{copied ? '已複製' : '複製'}
    </button>
  </div>
);

/**
 * ⋯ 選單的「分享」（David 2026-11-27）：兩種連結分開
 *  · 邀請一起記帳：成員都能複製
 *  · 分享給別人看（只能看）：旅程已經開放「有連結就能看」才出現；
 *    還沒開放時，管理員可以在這裡一鍵開放，一般成員看不到這一項
 * 權限在資料庫（set_trip_visibility 只有管理員能改）。
 */
const ShareDialog: React.FC<{ trip: Trip; isOpen: boolean; onClose: () => void; onChanged: () => void }> = ({
  trip, isOpen, onClose, onChanged,
}) => {
  const { session } = useSession();
  const { membership } = useMyMembership(trip.id, session?.user.id ?? null);
  const canAdmin = membership?.role === 'owner' || membership?.role === 'admin';
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = siteRootUrl();
  const inviteUrl = trip.invite_token ? `${base}#/join/${trip.id}/${trip.invite_token}` : '';
  const shareUrl = trip.share_token ? `${base}#/s/${trip.id}/${trip.share_token}` : '';
  const viewable = trip.visibility === 'link' || trip.visibility === 'password';

  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const openSharing = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('set_trip_visibility', { p_trip_id: trip.id, p_visibility: 'link', p_password: null });
    setBusy(false);
    if (err) { setError('開放失敗，請再試一次'); return; }
    onChanged();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="分享">
      <div className="space-y-4">
        <section className={`${ui.card} p-4 space-y-2`}>
          <p className="text-sm font-bold flex items-center gap-2"><UserPlus size={16} className="text-accent" />邀請一起記帳</p>
          <p className="text-xs text-muted">對方登入後就能加入、一起記帳</p>
          {inviteUrl && <LinkRow url={inviteUrl} copied={copied === 'invite'} onCopy={() => copy('invite', inviteUrl)} />}
        </section>

        {(viewable || canAdmin) && (
          <section className={`${ui.card} p-4 space-y-2`}>
            <p className="text-sm font-bold flex items-center gap-2"><Eye size={16} className="text-ink-2" />分享給別人看</p>
            <p className="text-xs text-muted">
              {viewable
                ? `對方只能看，不能記帳${trip.visibility === 'password' ? '・要輸入密碼' : ''}`
                : '目前只有成員看得到。開放後，拿到連結的人不用登入就能看（不能記帳）'}
            </p>
            {viewable
              ? shareUrl && <LinkRow url={shareUrl} copied={copied === 'share'} onCopy={() => copy('share', shareUrl)} />
              : (
                <button type="button" disabled={busy} onClick={openSharing} className={`${ui.btnSecondary} w-full`}>
                  {busy && <Loader2 size={16} className="animate-spin" />}開放「有連結就能看」
                </button>
              )}
          </section>
        )}
        {error && <p className="text-sm text-neg">{error}</p>}
      </div>
    </Modal>
  );
};

export default ShareDialog;
