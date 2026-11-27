import React, { useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { supabase } from '../../api/supabase';
import Modal from '../../components/Modal';
import { ui } from '../../components/ui';
import { clearUserStorage } from '../../config/mode';
import { removeTripPhotos } from '../../utils/tripPhotos';

interface TripRef { id: string; name: string; owner?: boolean }
interface Preview { delete: TripRef[]; leave: TripRef[] }

const CONFIRM_WORD = '刪除帳號';

/**
 * 刪除帳號（David 2026-11-27）：LINE／Google 已經自己變成另一個帳號時，刪掉它就能連到主帳號。
 * 防誤觸：要先看完會發生什麼（哪些旅程會整趟刪掉）、勾選「無法復原」、再自己打「刪除帳號」四個字，
 * 資料庫也會再檢查這四個字（app.delete_my_account）。
 */
const DeleteAccount: React.FC<{ onDeleted: () => void }> = ({ onDeleted }) => {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    supabase.rpc('account_deletion_preview').then(({ data }) => { if (alive && data) setPreview(data as Preview); });
    return () => { alive = false; };
  }, [open]);

  const close = () => { setOpen(false); setUnderstood(false); setTyped(''); setError(null); };
  const ready = !!preview && understood && typed.trim() === CONFIRM_WORD && !busy;

  const run = async () => {
    if (!ready || !preview) return;
    setBusy(true);
    setError(null);
    try {
      for (const t of preview.delete) await removeTripPhotos(t.id);
      const { error: err } = await supabase.rpc('delete_my_account', { p_confirm: CONFIRM_WORD });
      if (err) throw err;
      clearUserStorage();
      await supabase.auth.signOut().catch(() => {});
      onDeleted();
    } catch {
      setError('刪除沒有成功，帳號還在。請再試一次。');
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="w-full text-center text-xs text-muted hover:text-neg underline-offset-2 hover:underline py-1">
        刪除帳號
      </button>
      <Modal isOpen={open} onClose={close} title="刪除帳號" dirty={typed.length > 0}>
        <div className="space-y-4">
          <div className={`${ui.errorBox} items-start`}>
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <span>刪除後<b>無法復原</b>，也沒辦法找回。用同一個 LINE／Google 再登入會是一個全新的帳號。</span>
          </div>

          {preview === null ? (
            <div className="flex justify-center py-4 text-muted"><Loader2 className="animate-spin" size={18} /></div>
          ) : (
            <div className="space-y-3 text-sm">
              {preview.delete.length > 0 && (
                <div>
                  <p className="font-bold text-neg">這些旅程只有你一個人，會整趟刪掉（帳和照片都不見）：</p>
                  <ul className="mt-1 list-disc pl-5 text-ink-2">{preview.delete.map(t => <li key={t.id}>{t.name}</li>)}</ul>
                </div>
              )}
              {preview.leave.length > 0 && (
                <div>
                  <p className="font-bold">這些旅程會留給其他人，帳都還在：</p>
                  <ul className="mt-1 list-disc pl-5 text-ink-2">
                    {preview.leave.map(t => <li key={t.id}>{t.name}{t.owner && <span className="text-muted">（建立者會交給下一位管理員或成員）</span>}</li>)}
                  </ul>
                </div>
              )}
              {preview.delete.length === 0 && preview.leave.length === 0 && <p className="text-ink-2">這個帳號沒有任何旅程。</p>}
              <p className="text-xs text-muted">連到這個帳號的 LINE、Google 會一起解除，之後可以連到別的帳號。免費建立旅程的次數不會因為重新註冊而重算。</p>
            </div>
          )}

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={understood} onChange={e => setUnderstood(e.target.checked)} />
            <span>我了解刪除後無法復原</span>
          </label>
          <div className="space-y-1">
            <p className="text-xs text-ink-2">請輸入「{CONFIRM_WORD}」確認</p>
            <input className={ui.input} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" aria-label="輸入刪除帳號確認" />
          </div>

          {error && <div className={ui.errorBox}><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>}

          <div className="flex gap-2">
            <button type="button" onClick={close} className={`${ui.btnSecondary} flex-1`}>取消</button>
            <button type="button" disabled={!ready} onClick={run}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white bg-neg disabled:opacity-40">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}永久刪除
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default DeleteAccount;
