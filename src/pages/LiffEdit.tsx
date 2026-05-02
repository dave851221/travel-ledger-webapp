import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
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

  // 儲存 init 完成後的 liff 實例
  const liffRef = useRef<any>(null);

  const closeLiffWindow = useCallback(() => {
    // 嘗試 liff.closeWindow()（需有 LIFF ID 才有效）
    const liff = liffRef.current ?? (window as any).liff;
    try {
      if (liff?.closeWindow) {
        liff.closeWindow();
        return;
      }
    } catch (e) {
      console.error('[LIFF] closeWindow error:', e);
    }
    // 桌機瀏覽器 fallback
    window.close();
  }, []);

  const showToast = useCallback((msg: string, type?: string) => {
    setToast({ msg, isError: type === 'error' });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleSuccess = useCallback(() => {
    setIsSuccess(true);
    setTimeout(closeLiffWindow, 800);
  }, [closeLiffWindow]);

  useEffect(() => {
    const init = async () => {
      try {
        // --- 0. 動態載入 LIFF SDK（若尚未注入）---
        // LINE 只在以 liff.line.me URL 開啟時自動注入 SDK；
        // 直接以 GitHub Pages 網址開啟時需手動載入才能使用 closeWindow()
        if (!(window as any).liff) {
          await new Promise<void>((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
            script.onload = () => resolve();
            script.onerror = () => resolve(); // 載入失敗也繼續，後續以 window.close() 補底
            document.head.appendChild(script);
          });
        }

        // --- 1. 初始化 LIFF ---
        const liff = (window as any).liff;
        const liffId = import.meta.env.VITE_LIFF_ID;
        if (liff && liffId) {
          await liff.init({ liffId });
          liffRef.current = liff;
          if (!liff.isLoggedIn()) {
            liff.login();
            return;
          }
        }

        const tripId = searchParams.get('tripId');
        const dataStr = searchParams.get('data');
        if (!tripId || !dataStr) throw new Error('缺少必要參數');

        // 2. 解碼 (Base64 -> JSON)
        let base64 = dataStr.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const decodedStr = new TextDecoder().decode(bytes);
        const decoded = JSON.parse(decodedStr);

        // 3. 獲取旅程
        const { data: tripData, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).single();
        if (tripErr) throw tripErr;
        if (!tripData.precision_config) tripData.precision_config = {};
        setTrip(tripData);

        // 4. 處理照片（提取相對路徑）
        const rawIds = decoded.pi || decoded.photo_ids || decoded.photo_urls || [];
        const photoPathIds = (Array.isArray(rawIds) ? rawIds : [rawIds]).map((id: any) => {
          const idStr = String(id);
          if (idStr.includes('travel-images/')) {
            return idStr.substring(idStr.lastIndexOf('travel-images/') + 'travel-images/'.length);
          }
          return idStr.includes('/') ? idStr : `expenses/${tripId}/${idStr}.jpg`;
        });

        // 5. 準備 InitialData
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

  // Toast 以 Portal 渲染到 body，完全脫離 modal 的 z-index / backdrop-blur 影響
  const toastPortal = toast
    ? createPortal(
        <div
          className={`fixed top-4 left-4 right-4 px-4 py-3 rounded-xl font-bold text-sm text-white shadow-xl ${toast.isError ? 'bg-rose-500' : 'bg-emerald-500'}`}
          style={{ zIndex: 99999 }}
        >
          {toast.msg}
        </div>,
        document.body
      )
    : null;

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
      {toastPortal}
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
