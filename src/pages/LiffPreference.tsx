import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../api/supabase';
import type { Trip } from '../types';
import { Loader2, AlertTriangle, CheckCircle2, Bot, Save } from 'lucide-react';

/**
 * 在 LINE 裡編輯「這趟旅程的 AI 記帳偏好」。
 *
 * 從 LINE 的「⚙️ 記帳偏好」快速回覆按鈕開啟（`#/liff/preference?tripId=...`）。
 * 偏好存在 `trips.ai_preference`，整趟旅程共用一份 ——
 * 網頁的旅程設定頁編輯的是同一個欄位。
 *
 * 這頁只覆寫單一欄位，重複送出沒有副作用，
 * 所以不需要 LiffEdit 那套 nonce／postback／liff-notify 的機制。
 *
 * ⚠️ 它是前端，改完要 push `main` 才會生效（見 CLAUDE.md 的部署一節）。
 */
const LiffPreference: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [preference, setPreference] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);

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

  useEffect(() => {
    const init = async () => {
      try {
        // --- 0. 動態載入 LIFF SDK（若尚未注入）---
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

        const tripId = searchParams.get('tripId');
        if (!tripId) throw new Error('缺少必要參數 tripId');

        if (!supabase) throw new Error('資料庫連線尚未設定');
        const { data: tripData, error: tripErr } = await supabase
          .from('trips').select('*').eq('id', tripId).single();
        if (tripErr) throw tripErr;

        setTrip(tripData);
        setPreference(tripData.ai_preference || '');
        setLoading(false);
      } catch (err) {
        console.error('[LIFF_PREFERENCE] Error:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };
    init();
  }, [searchParams]);

  const handleSave = async () => {
    if (!trip || !supabase) return;
    setSaving(true);
    setError(null);
    try {
      // 留空即代表沒有偏好；與 access_code 同樣的正規化慣例，統一存成 NULL
      const { error: updateErr } = await supabase
        .from('trips')
        .update({ ai_preference: preference.trim() || null })
        .eq('id', trip.id);
      if (updateErr) throw updateErr;

      setIsSuccess(true);
      if (canCloseWindow) setTimeout(closeLiffWindow, 900);
    } catch (err) {
      console.error('[LIFF_PREFERENCE] Save error:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white">
      <Loader2 className="animate-spin text-blue-500 mb-4" size={40} />
      <div className="text-slate-400 font-bold text-xs uppercase tracking-widest">Yoshi! 正在讀取偏好設定...</div>
    </div>
  );

  if (error && !trip) return (
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
      <h2 className="text-2xl font-black text-slate-900">偏好已更新！</h2>
      <p className="mt-3 text-sm font-bold text-slate-400">之後記帳時耀西會參考這份設定。</p>

      {canCloseWindow ? (
        <button
          onClick={closeLiffWindow}
          className="mt-10 bg-emerald-600 text-white px-10 py-4 rounded-2xl font-bold w-full"
        >
          返回 LINE
        </button>
      ) : (
        <p className="mt-6 text-sm font-bold text-slate-500 leading-relaxed">
          已儲存，可直接關閉此頁面回到 LINE。
        </p>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-white px-5 py-8">
      <div className="max-w-lg mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-violet-100 text-violet-600 rounded-xl"><Bot size={22} /></div>
          <div>
            <h1 className="text-lg font-black text-slate-900 leading-none">AI 記帳偏好</h1>
            <p className="text-[11px] text-slate-400 font-bold mt-1.5">{trip?.name}</p>
          </div>
        </div>

        <p className="text-xs text-slate-500 font-medium leading-relaxed bg-slate-50 rounded-xl p-4">
          耀西在解析你說的話或收據時會參考這段描述。
          <strong className="text-slate-700">整趟旅程共用一份</strong>，網頁的旅程設定頁看到的是同一份。
          留空即代表沒有偏好。
        </p>

        <div className="space-y-2">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">偏好內容</label>
          <textarea
            rows={7}
            placeholder={`例如：預設由${trip?.members?.[0] || '我'}付款，大家均分；日幣一律不換算`}
            className="w-full px-4 py-3 rounded-xl bg-slate-50 border-2 border-transparent focus:border-violet-600 outline-none transition-all font-bold text-sm resize-none"
            value={preference}
            onChange={e => setPreference(e.target.value)}
          />
          <p className="text-[10px] text-slate-400 px-1 leading-relaxed">
            不要寫「我是○○」—— 群組裡每個人看到的都是同一句，耀西已經會用 LINE 顯示名稱判斷「我」是誰。
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-rose-600 text-xs font-bold bg-rose-50 rounded-xl p-3">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 bg-violet-600 disabled:bg-slate-300 text-white py-4 rounded-2xl font-black transition-all active:scale-95"
        >
          {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
          <span>{saving ? '儲存中...' : '儲存偏好'}</span>
        </button>
      </div>
    </div>
  );
};

export default LiffPreference;
