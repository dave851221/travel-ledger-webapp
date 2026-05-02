import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import ExpenseModal from '../components/ExpenseModal';
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

const closeLiffWindow = () => {
  try {
    const liff = (window as any).liff;
    if (liff?.closeWindow) {
      liff.closeWindow();
    } else {
      window.close();
    }
  } catch {
    window.close();
  }
};

const LiffEdit: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [initialData, setInitialData] = useState<Expense | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        // --- 0. 初始化 LIFF ---
        const liff = (window as any).liff;
        if (liff) {
          await liff.init({ liffId: import.meta.env.VITE_LIFF_ID || '' });
          if (!liff.isLoggedIn()) {
            liff.login();
            return;
          }
        }

        const tripId = searchParams.get('tripId');
        const dataStr = searchParams.get('data');

        if (!tripId || !dataStr) throw new Error('缺少必要參數');

        // 1. 解碼 (Base64 -> JSON)
        // 容錯處理：將 URL 安全的 Base64 轉回標準格式，並補齊填充符
        let base64 = dataStr.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        
        // 使用 TextDecoder 處理 UTF-8 字串
        const decodedStr = new TextDecoder().decode(bytes);
        const decoded = JSON.parse(decodedStr);

        // 2. 獲取旅程
        const { data: tripData, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).single();
        if (tripErr) throw tripErr;
        
        // 確保 precision_config 存在，避免 ExpenseModal 崩潰
        if (!tripData.precision_config) tripData.precision_config = {};
        setTrip(tripData);

        // 3. 處理照片 (關鍵修復：提取相對路徑)
        const rawIds = decoded.pi || decoded.photo_ids || decoded.photo_urls || [];
        const photoPathIds = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(id => {
            const idStr = String(id);
            // 如果傳進來的是完整的 URL，我們必須截斷它，只保留 travel-images/ 之後的部分
            if (idStr.includes('travel-images/')) {
                const markerIdx = idStr.lastIndexOf('travel-images/');
                return idStr.substring(markerIdx + 'travel-images/'.length);
            }
            // 否則補上路徑字串
            return idStr.includes('/') ? idStr : `expenses/${tripId}/${idStr}.jpg`;
        });
        // 4. 準備 InitialData (強型別轉換，對接 split_data)
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
          photo_urls: photoPathIds, // 相對路徑
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
      <button onClick={() => closeLiffWindow()} className="mt-10 bg-emerald-600 text-white px-10 py-4 rounded-2xl font-bold w-full">返回 LINE</button>
    </div>
  );

  return (
    <div className="liff-shell-container min-h-screen bg-white">
      {/* 這裡不再放置任何 UI，完全交給 ExpenseModal 渲染，避免 z-index 衝突 */}
      {trip && initialData && (
        <ExpenseModal 
          isOpen={true}
          onClose={() => closeLiffWindow()} 
          trip={trip}
          currentUser={trip.members[0]} 
          onSuccess={() => setIsSuccess(true)}
          showToast={(m) => console.log('[Toast]', m)}
          editData={initialData}
        />
      )}
    </div>
  );
};

export default LiffEdit;
