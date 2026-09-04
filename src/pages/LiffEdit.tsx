import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import ExpenseModal from '../components/ExpenseModal';
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getLocalDateString } from '../utils/date';

const LiffEdit: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [initialData, setInitialData] = useState<Expense | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [toast, setToast] = useState<{ msg: string; isError: boolean } | null>(null);

  // 儲存 init 完成後的 liff 實例
  const liffRef = useRef<LiffSDK | null>(null);

  // liff.closeWindow() 只有在 liff.init() 成功之後才有作用，而 init 需要
  // VITE_LIFF_ID。沒設定時視窗關不掉，window.close() 也會被瀏覽器封鎖 ——
  // 與其放一顆按不動的按鈕，不如直接告訴使用者可以自己關掉這一頁。
  const [canCloseWindow, setCanCloseWindow] = useState(false);

  const closeLiffWindow = useCallback(() => {
    const liff = liffRef.current;
    if (liff?.closeWindow) {
      try {
        liff.closeWindow();
        return;
      } catch (e) {
        console.error('[LIFF] closeWindow error:', e);
      }
    }
    // 桌機瀏覽器：只有由 script 開啟的視窗才關得掉，多數情況會無效
    window.close();
  }, []);

  const showToast = useCallback((msg: string, type?: string) => {
    setToast({ msg, isError: type === 'error' });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleSuccess = useCallback(() => {
    setIsSuccess(true);
    // 關不掉的話就別嘗試，避免使用者看到畫面閃一下卻什麼都沒發生
    if (canCloseWindow) setTimeout(closeLiffWindow, 800);
  }, [closeLiffWindow, canCloseWindow]);

  useEffect(() => {
    const init = async () => {
      try {
        // --- 0. 動態載入 LIFF SDK（若尚未注入）---
        // LINE 只在以 liff.line.me URL 開啟時自動注入 SDK；
        // 直接以 GitHub Pages 網址開啟時需手動載入才能使用 closeWindow()
        if (!window.liff) {
          await new Promise<void>((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
            script.onload = () => resolve();
            script.onerror = () => resolve(); // 載入失敗也繼續，後續以 window.close() 補底
            document.head.appendChild(script);
          });
        }

        // --- 1. 初始化 LIFF ---
        const liff = window.liff;
        const liffId = import.meta.env.VITE_LIFF_ID;
        if (liff && liffId) {
          await liff.init({ liffId });
          liffRef.current = liff;
          setCanCloseWindow(typeof liff.closeWindow === 'function');
          if (!liff.isLoggedIn()) {
            liff.login();
            return;
          }
        }

        // --- 2. 決定資料來源 ---
        // 三種進入方式，優先序 id > n > data：
        //   ?id=<expenseId>  既有支出：每次開啟都直接查 DB，拿到的一定是最新內容
        //   ?n=<nonce>       尚未確認的草稿：從 line_chat_history 的 pending 列取回
        //   ?data=<base64>   舊格式，整筆資料凍結在網址裡
        //
        // ⚠️ 舊格式**必須保留**：已經發出去的 LINE 卡片與清單訊息還帶著 data=，
        //    拿掉的話那些按鈕會全部壞掉。
        //    改用 id/n 的原因是 data= 的內容在訊息送出的那一刻就凍結了 ——
        //    從清單改完金額再按同一顆「編輯」，表單填的還是修改前的值；
        //    而且 LINE 的 uri action 上限 1000 字，多成員長描述時整張清單會發不出去。
        const tripId = searchParams.get('tripId');
        const expenseId = searchParams.get('id');
        const nonce = searchParams.get('n');
        const sourceId = searchParams.get('u');
        const dataStr = searchParams.get('data');
        if (!tripId) throw new Error('缺少必要參數');
        if (!expenseId && !nonce && !dataStr) throw new Error('缺少必要參數');

        // 3. 獲取旅程
        const { data: tripData, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).single();
        if (tripErr) throw tripErr;
        if (!tripData.precision_config) tripData.precision_config = {};
        setTrip(tripData);

        // 把各種來源整理成同一份 payload（欄位縮寫與草稿卡片一致），
        // 下面的欄位對應對三種來源共用
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let decoded: any;

        if (expenseId) {
          const { data: row, error: expErr } = await supabase.from('expenses')
            .select('*').eq('id', expenseId).maybeSingle();
          if (expErr) throw expErr;
          if (!row || row.deleted_at) throw new Error('這筆支出已被刪除或不存在。');
          decoded = { ...row, u: sourceId ?? undefined };
        } else if (nonce) {
          // 草稿：內容存在 line_chat_history 的 pending 列，卡片只帶 nonce。
          // RLS 對匿名完全開放（見 supabase/schema/05_policies.sql），前端讀得到。
          const [{ data: used }, { data: rows }] = await Promise.all([
            supabase.from('line_processed_actions').select('nonce').eq('nonce', nonce).maybeSingle(),
            supabase.from('line_chat_history')
              .select('content')
              .eq('line_user_id', sourceId ?? '')
              .eq('role', 'pending')
              .order('created_at', { ascending: false })
              .limit(10),
          ]);
          // 已按過確認／取消，或被更新的建議取代 —— 不要讓表單開起來重複寫入
          if (used) throw new Error('這張卡片已處理過。');

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let draft: any = null;
          for (const row of rows ?? []) {
            try {
              const parsed = JSON.parse(row.content);
              if (parsed?.n === nonce) { draft = parsed; break; }
            } catch { /* skip malformed */ }
          }
          if (!draft) throw new Error('這張卡片已過期，請重新記帳。');
          // pending 列的結構是 { n, exp: {d,a,c,dt,cat,p,s}, p: 照片, tid }
          decoded = { ...draft.exp, pi: draft.p, n: draft.n, u: sourceId ?? undefined };
        } else {
          // 舊格式：Base64 -> JSON
          if (!dataStr) throw new Error('缺少必要參數');
          let base64 = dataStr.replace(/-/g, '+').replace(/_/g, '/');
          while (base64.length % 4) base64 += '=';
          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          decoded = JSON.parse(new TextDecoder().decode(bytes));
        }

        // 4. 處理照片（提取相對路徑）
        const rawIds = decoded.pi || decoded.photo_ids || decoded.photo_urls || [];
        const photoPathIds = (Array.isArray(rawIds) ? rawIds : [rawIds]).map((id: unknown) => {
          const idStr = String(id);
          if (idStr.includes('travel-images/')) {
            return idStr.substring(idStr.lastIndexOf('travel-images/') + 'travel-images/'.length);
          }
          return idStr.includes('/') ? idStr : `expenses/${tripId}/${idStr}.jpg`;
        });

        // 5. 準備 InitialData (草稿資料；created_at 由 DB 寫入時補上)
        const finalData: Expense & { nonce?: string; line_user_id?: string } = {
          created_at: '',
          id: decoded.id || '',
          trip_id: tripId,
          description: String(decoded.d || decoded.description || ''),
          amount: Number(decoded.a ?? decoded.amount ?? 0),
          currency: String(decoded.c || decoded.currency || tripData.base_currency),
          date: String(decoded.dt || decoded.date || getLocalDateString()),
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

      } catch (err) {
        console.error('[LIFF] Error:', err);
        setError(err instanceof Error ? err.message : String(err));
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

      {canCloseWindow ? (
        <button
          onClick={closeLiffWindow}
          className="mt-10 bg-emerald-600 text-white px-10 py-4 rounded-2xl font-bold w-full"
        >
          返回 LINE
        </button>
      ) : (
        <p className="mt-6 text-sm font-bold text-slate-500 leading-relaxed">
          已存入帳目，可直接關閉此頁面回到 LINE。
        </p>
      )}
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
