import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { supabase } from '../../api/supabase';
import Modal from '../../components/Modal';
import { ui } from '../../components/ui';
import type { Trip } from '../../types';
import { removeTripPhotos } from '../../utils/tripPhotos';

/**
 * 開放版：建立者刪除整趟旅程（帳、照片、成員都刪掉；免費旅程的名額會空出來，David 2026-11-27）。
 * 防誤觸：要自己打出旅程名稱。權限在資料庫（trips_delete：只有 owner）。
 */
const DeleteTrip: React.FC<{ trip: Trip; onDeleted: () => void }> = ({ trip, onDeleted }) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = typed.trim() === trip.name.trim() && !busy;

  const run = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    // 先刪資料再清照片：刪除失敗時旅程與照片都還在（以前先清照片，失敗就留下一趟照片全破的旅程）
    const { error: err, count } = await supabase.from('trips').delete({ count: 'exact' }).eq('id', trip.id);
    if (err || !count) { setBusy(false); setError('刪除沒有成功，請再試一次'); return; }
    await removeTripPhotos(trip.id).catch(() => {});
    setBusy(false);
    onDeleted();
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${ui.btnDanger} w-full`}>
        <Trash2 size={16} />刪除這趟旅程
      </button>
      <Modal isOpen={open} onClose={() => { setOpen(false); setTyped(''); setError(null); }} title="刪除旅程" dirty={typed.length > 0}>
        <div className="space-y-4">
          <div className={ui.errorBox}>
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <span>所有帳、照片和成員都會刪掉，<b>無法復原</b>。</span>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-ink-2">請輸入旅程名稱「{trip.name}」確認</p>
            <input className={ui.input} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" aria-label="輸入旅程名稱確認" />
          </div>
          {error && <div className={ui.errorBox}><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>}
          <button type="button" disabled={!ready} onClick={run}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white bg-neg disabled:opacity-40">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}永久刪除
          </button>
        </div>
      </Modal>
    </>
  );
};

export default DeleteTrip;
