import React, { useEffect, useState } from 'react';
import { AlertCircle, Gauge, Link2, Loader2, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../api/supabase';
import Modal from '../../components/Modal';
import { ui } from '../../components/ui';
import { type LoginInfo, providerLabel } from './loginInfo';
import { lineLoginAvailable, startLineLogin } from './lineLogin';
import { linkGoogle } from './session';
import DeleteAccount from './DeleteAccount';

/**
 * 開放版「我的帳號」：這個帳號用哪些方式登入，並可以把 LINE／Google 連到同一個帳號。
 * 連好之後用哪一種登入都是同一個人、看到同樣的旅程。
 * 登入方式的清單由資料庫的 my_logins 組好（名稱、遮過的 email），前端不讀 auth 的原始資料。
 */
const AccountModal: React.FC<{ isOpen: boolean; onClose: () => void; onSignOut: () => void }> = ({ isOpen, onClose, onSignOut }) => {
  const [logins, setLogins] = useState<LoginInfo[] | null>(null);
  const [busy, setBusy] = useState<'line' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 開發者才看得到後台入口（權限仍由資料庫判斷）
  const [isAdmin, setIsAdmin] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    // 每次打開重新讀一次（剛連結完回來就會看到新的）
    supabase.rpc('my_logins').then(({ data }) => { if (alive) setLogins((data ?? []) as LoginInfo[]); });
    supabase.rpc('is_site_admin').then(({ data }) => { if (alive) setIsAdmin(data === true); });
    return () => { alive = false; };
  }, [isOpen]);

  const has = (p: LoginInfo['provider']) => !!logins?.some(l => l.provider === p);
  const returnTo = window.location.hash.replace(/^#/, '') || '/';

  const link = async (p: 'line' | 'google') => {
    setError(null);
    setBusy(p);
    try {
      if (p === 'line') startLineLogin(returnTo, 'link');
      else await linkGoogle(returnTo);
    } catch {
      setError('沒辦法開始連結，請再試一次');
      setBusy(null);
    }
  };

  const canLinkLine = lineLoginAvailable() && !has('line');
  const canLinkGoogle = !has('google');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="我的帳號">
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-bold">登入方式</p>
          {logins === null ? (
            <div className="flex justify-center py-4 text-muted"><Loader2 className="animate-spin" size={18} /></div>
          ) : (
            <ul className="rounded-2xl border border-line divide-y divide-line">
              {logins.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">其他方式登入</li>}
              {logins.map((l, i) => (
                // 兩種登入方式排成一樣的兩行（名稱／帳號），標籤同寬，高度一致
                <li key={i} className="flex items-center gap-3 px-3 py-2.5 min-w-0 min-h-[60px]">
                  <span className={`shrink-0 w-16 text-center rounded-md py-1 text-xs font-bold ${l.provider === 'line' ? 'text-pos bg-pos/10' : 'text-ink-2 bg-sunk'}`}>
                    {providerLabel(l.provider)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{l.name || '（沒有名稱）'}</span>
                    <span className="block truncate text-xs text-muted">{l.account || (l.provider === 'line' ? 'LINE 帳號' : '')}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {logins !== null && (canLinkLine || canLinkGoogle) && (
          <div className="space-y-2">
            {canLinkLine && (
              <button type="button" disabled={!!busy} onClick={() => link('line')} className={`${ui.btnSecondary} w-full`}>
                {busy === 'line' ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}連結 LINE
              </button>
            )}
            {canLinkGoogle && (
              <button type="button" disabled={!!busy} onClick={() => link('google')} className={`${ui.btnSecondary} w-full`}>
                {busy === 'google' ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}連結 Google
              </button>
            )}
            <p className={ui.hint}>
              連結後，用 LINE 或 Google 登入都是這個帳號，看到一樣的旅程。
              如果那個 LINE／Google 已經自己登入過、變成另一個帳號，要先用它登入並刪除那個帳號，才能連到這裡。
            </p>
          </div>
        )}

        {error && <div className={ui.errorBox}><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>}

        {isAdmin && (
          <button type="button" onClick={() => { onClose(); navigate('/admin'); }} className={`${ui.btnSecondary} w-full`}>
            <Gauge size={16} />開發者後台
          </button>
        )}
        <button type="button" onClick={onSignOut} className={`${ui.btnSecondary} w-full text-neg`}>
          <LogOut size={16} />登出
        </button>
        <DeleteAccount onDeleted={onSignOut} />
      </div>
    </Modal>
  );
};

export default AccountModal;
