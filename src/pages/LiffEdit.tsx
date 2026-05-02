import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import ExpenseModal from '../components/ExpenseModal';
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

const LiffEdit: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [initialData, setInitialData] = useState<Expense | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [toast, setToast] = useState<{ msg: string; isError: boolean } | null>(null);

  // 儲存 init 完成後的 liff 實例，確保 closeWindow 使用已初始化的物件
  const liffRef = useRef<any>(null);

  const closeLiffWindow = useCallback(() => {
    const liff = liffRef.current ?? (window as any).liff;
    try {
      if (liff?.closeWindow) {
        liff.closeWindow();
      }
    } catch (e) {
      console.error('[LIFF] closeWindow error:', e);
    }
    // 補底：若 liff.closeWindow() 無反應，300ms 後嘗試 window.close()
    setTimeout(() => {
      try { window.close(); } catch { /* ignore */ }
    }, 300);
  }, []);

  const showToast = useCallback((msg: string, type?: string) => {
    setToast({ msg, isError: type === 'error' });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleSuccess = useCallback(() => {
    setIsSuccess(true);
    // 顯示成功畫面後嘗試自動關閉；若不成功，使用者可按「返回 LINE」
    setTimeout(closeLiffWindow, 800);
  }, [closeLiffWindow]);

  useEffect(() => {
    const init = async () => {
      try {
        // --- 0. 初始化 LIFF ---
        const liff = (window as any).liff;
        if (liff) {
          await liff.init({ liffId: import.meta.env.VITE_LIFF_ID || '' });
          liffRef.current = liff; // 儲存已初始化的實例
          if (!liff.isLoggedIn()) {
            liff.login();
            return;
          }
        }

        const tripId = searchParams.get('tripId');
        const dataStr = searchParams.get('data');

        if (!tripId || !dataStr) throw new Error('缺少必要參數');

        // 1. 解碼 (Base64 -> JSON)
        let base64 = dataStr.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';

        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const decodedStr = new TextDecoder().decode(bytes);
        const decoded = JSON.parse(decodedStr);

        // 2. 獲取旅程
        const { data: tripData, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).single();
        if (tripErr) throw tripErr;

        if (!tripData.precision_config) tripData.precision_config = {};
        setTrip(tripData);

        // 3. 處理照片（提取相對路徑）
        const rawIds = decoded.pi || decoded.photo_ids || decoded.photo_urls || [];
        const photoPathIds = (Array.isArray(rawIds) ? rawIds : [rawIds]).map((id: any) => {
          const idStr = String(id);
          if (idStr.includes('travel-images/')) {
            const markerIdx = idStr.lastIndexOf('travel-images/');
            return idStr.substring(markerIdx + 'travel-images/'.length);
          }
          return idStr.includes('/') ? idStr : `expenses/${tripId}/${idStr}.jpg`;
        });

        // 4. 準備 InitialData
        const finalData: any = {
          id: decoded.id || '',
          trip_id: tripId,
          description: String(decoded.d || decoded.description || ''),
          amount: Number(decoded.a ?? decoded.amount ?? 0),
          currency: String(decoded.c || decoded.currency || tripData.base_currency),
          date: String(decoded.dt || decoded.date || new Date().toISOString().split('T')[0]),
          category: String(decoded.cat || decoded.category || tripData.categories[0]),
          payer_data: decoded.p || decoded.payer_data || {},
          split_data: decoded.s || decoded.split_data || decoded.split_details || {},
          adjustment_member: decoded.adjustment_member || Object.keys(decoded.s || decoded.split_details || {})[0] || tripData.members[0],
          photo_urls: photoPathIds,
          is_settlement: !!(decoded.is_settlement),
          deleted_at: null,
          nonce: decoded.n || decoded.nonce,
          line_user_id: decoded.u || decoded.line_user_id
        };

        setInitialData(finalData);
        setLoading(false);

      } catch (err: any) {
        console.error('[LIFF] Error:', err);
        setError(err.message);
        setLoading(false);
      }
    };
    init();
  }, [searchParams]);

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white">
      <Loader2 className="animate-spin text-blue-500 mb-4" size={40} />
      <div className="text-slate-400 font-bold text-xs uppercase tracking-widest">Yoshi! 正在準備資料...</div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen p-10 flex flex-col items-center justify-center bg-white text-center">
      <AlertTriangle className="text-rose-500 mb-4" size={60} />
      <h2 className="text-xl font-bold text-slate-900">載入失敗</h2>
      <p className="text-slate-500 text-sm mt-2">{error}</p>
      <button onClick={() => window.location.reload()} className="mt-8 bg-slate-900 text-white px-8 py-3 rounded-xl font-bold">重試</button>
    </div>
  );

  if (isSuccess) return (
    <div className="min-h-screen p-10 flex flex-col items-center justify-center bg-white text-center">
      <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-6 text-emerald-600">
        <CheckCircle2 size={40} />
      </div>
      <h2 className="text-2xl font-black text-slate-900">記帳成功！</h2>
      <button onClick={closeLiffWindow} className="mt-10 bg-emerald-600 text-white px-10 py-4 rounded-2xl font-bold w-full">返回 LINE</button>
    </div>
  );

  return (
    <div className="liff-shell-container min-h-screen bg-white">
      {toast && (
        <div className={`fixed top-4 left-4 right-4 px-4 py-3 rounded-xl font-bold text-sm z-50 text-white shadow-lg ${toast.isError ? 'bg-rose-500' : 'bg-emerald-500'}`}>
          {toast.msg}
        </div>
      )}
      {trip && initialData && (
        <ExpenseModal
          isOpen={true}
          onClose={closeLiffWindow}
          trip={trip}
          currentUser={trip.members[0]}
          onSuccess={handleSuccess}
          showToast={showToast}
          editData={initialData}
        />
      )}
    </div>
  );
};

export default LiffEdit;
