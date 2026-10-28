import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../api/supabase';
import { ui } from '../components/ui';
import { LiffError, LiffLoading, LiffSuccess } from '../components/LiffScreens';
import type { Trip } from '../types';
import { Loader2, AlertTriangle, Bot, Save } from 'lucide-react';

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

  if (loading) return <LiffLoading message="正在讀取偏好設定…" />;

  if (error && !trip) return <LiffError message={error} />;

  if (isSuccess) return (
    <LiffSuccess
      title="偏好已更新"
      detail="之後記帳時，耀西會參考這份設定。"
      canClose={canCloseWindow}
      onClose={closeLiffWindow}
      closedHint="已儲存，可以直接關閉這個頁面回到 LINE。"
    />
  );

  return (
    <div className="min-h-dvh bg-canvas text-ink px-4 pt-[max(24px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <div className="max-w-lg mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-navy text-accent flex items-center justify-center shrink-0"><Bot size={20} /></span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-tight">AI 記帳偏好</h1>
            <p className="text-xs text-muted mt-0.5 truncate">{trip?.name}</p>
          </div>
        </div>

        <p className="text-sm text-ink-2 leading-relaxed bg-surface border border-line rounded-xl p-4">
          耀西解析你說的話或收據時，會參考這段描述。這份設定<strong className="text-ink">整趟旅程共用</strong>，
          網頁上的旅程設定看到的也是同一份。留空代表沒有偏好。
        </p>

        <div>
          <label htmlFor="liff-pref" className={ui.label}>偏好內容</label>
          <textarea
            id="liff-pref"
            rows={7}
            placeholder={`例如：預設由${trip?.members?.[0] || '我'}付款，大家均分；日幣一律不換算`}
            className={`${ui.input} resize-none`}
            value={preference}
            onChange={e => setPreference(e.target.value)}
          />
          <p className={`${ui.hint} mt-1.5`}>
            不要寫「我是○○」：群組裡每個人看到的都是同一句，耀西會用 LINE 顯示名稱判斷「我」是誰。
          </p>
        </div>

        {error && (
          <div className={ui.errorBox} role="alert">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button onClick={handleSave} disabled={saving} className={`${ui.btnPrimary} w-full py-3.5 text-[15px]`}>
          {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
          {saving ? '儲存中…' : '儲存偏好'}
        </button>
      </div>
    </div>
  );
};

export default LiffPreference;
