import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Loader2 } from 'lucide-react';
import { completeLineSignIn, hasPendingLineSignIn } from './lineLogin';
import { takeReturnTo, useSession } from './session';
import { AUTH_ERROR_KEY } from './lineCallback';

/**
 * 開放版：登入回來之後的收尾（舊版不會掛這個元件）。
 *  · LINE 網頁登入回來：把收起來的 code 交給 auth-line 換成 session
 *  · 任何登入方式完成後：回到登入前那一頁（rememberReturnTo 記的）
 */
const AuthBootstrap: React.FC = () => {
  const navigate = useNavigate();
  const { session } = useSession();
  const [lineBusy, setLineBusy] = useState(hasPendingLineSignIn);
  // LINE 登入失敗，或 Google 等登入回來時帶著錯誤（lineCallback.ts 記下來的）
  const [lineError, setLineError] = useState(() => {
    try {
      const had = !!sessionStorage.getItem(AUTH_ERROR_KEY);
      sessionStorage.removeItem(AUTH_ERROR_KEY);
      return had;
    } catch {
      return false;
    }
  });
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !hasPendingLineSignIn()) return;
    started.current = true;
    completeLineSignIn()
      .catch(() => setLineError(true))
      .finally(() => setLineBusy(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    const back = takeReturnTo();
    if (back) navigate(back, { replace: true });
  }, [session, navigate]);

  if (lineBusy) {
    return (
      <div className="fixed inset-0 z-[90] bg-canvas/90 flex flex-col items-center justify-center gap-3 text-ink">
        <Loader2 className="animate-spin" size={28} />
        <p className="text-sm">正在用 LINE 登入…</p>
      </div>
    );
  }
  if (lineError) {
    return (
      <div role="alert" className="fixed top-[max(16px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[90] bg-surface border border-line rounded-xl shadow-xl px-4 py-2.5 text-sm text-neg flex items-center gap-2">
        <AlertCircle size={16} />登入沒有成功，請再試一次
        <button className="ml-2 underline text-ink-2" onClick={() => setLineError(false)}>關閉</button>
      </div>
    );
  }
  return null;
};

export default AuthBootstrap;
