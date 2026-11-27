import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { completeLineSignIn, hasPendingLineSignIn, LINE_LINK_RESULT_KEY, pendingLineIsLink } from './lineLogin';
import { GOOGLE_LINK_KEY, takeReturnTo, useSession } from './session';
import { AUTH_ERROR_KEY } from './lineCallback';

interface Notice { ok: boolean; text: string }

/** 登入／連結的結果代碼 → 給人看的話 */
function noticeFor(code: string, linking: boolean): Notice {
  switch (code) {
    case 'ok': return { ok: true, text: 'LINE 已經連到這個帳號' };
    case 'line_already_linked': return { ok: false, text: '這個 LINE 已經是另一個帳號了。要連到這裡，請先用它登入，到「帳號」刪除那個帳號後再連。' };
    case 'identity_already_exists': return { ok: false, text: '這個 Google 已經是另一個帳號了。要連到這裡，請先用它登入，到「帳號」刪除那個帳號後再連。' };
    case 'not_signed_in': return { ok: false, text: '請先登入再連結' };
    default: return { ok: false, text: linking ? '連結沒有成功，請再試一次' : '登入沒有成功，請再試一次' };
  }
}

function takeSession(key: string): string | null {
  try { const v = sessionStorage.getItem(key); sessionStorage.removeItem(key); return v; } catch { return null; }
}

/** 剛剛按了「連結 Google」（15 分鐘內）。只讀不清（state 初始值在開發模式會跑兩次），清在 effect 裡 */
function googleLinkPending(): boolean {
  try {
    const at = Number(localStorage.getItem(GOOGLE_LINK_KEY) || 0);
    return !!at && Date.now() - at < 15 * 60 * 1000;
  } catch {
    return false;
  }
}

function peekSession(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

/**
 * 開放版：登入回來之後的收尾（舊版不會掛這個元件）。
 *  · LINE 網頁登入回來：把收起來的 code 交給 auth-line 換成 session
 *  · 任何登入方式完成後：回到登入前那一頁（rememberReturnTo 記的）
 */
const AuthBootstrap: React.FC = () => {
  const navigate = useNavigate();
  const { session } = useSession();
  const [lineBusy, setLineBusy] = useState(hasPendingLineSignIn);
  const [linking] = useState(pendingLineIsLink);
  const [googleLink] = useState(googleLinkPending);
  const [googleOkDismissed, setGoogleOkDismissed] = useState(false);
  // 登入失敗，或 Google 等登入／連結回來時帶著錯誤（lineCallback.ts 記下來的）
  const [notice, setNotice] = useState<Notice | null>(() => {
    const code = peekSession(AUTH_ERROR_KEY);
    return code ? noticeFor(code, googleLinkPending()) : null;
  });

  useEffect(() => {
    try { sessionStorage.removeItem(AUTH_ERROR_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(GOOGLE_LINK_KEY); } catch { /* ignore */ }
  }, []);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !hasPendingLineSignIn()) return;
    started.current = true;
    completeLineSignIn()
      .then(() => {
        const r = takeSession(LINE_LINK_RESULT_KEY);
        if (r) setNotice(noticeFor(r, true));
      })
      .catch(() => setNotice(noticeFor('signin_failed', false)))
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
        <p className="text-sm">{linking ? '正在連結 LINE…' : '正在用 LINE 登入…'}</p>
      </div>
    );
  }
  // 連結 Google 回來：沒帶錯誤、帳號上也真的多了 Google，就說一聲
  const googleOk = googleLink && !googleOkDismissed && !!session?.user.identities?.some(i => i.provider === 'google');
  const shown: Notice | null = notice ?? (googleOk ? { ok: true, text: 'Google 已經連到這個帳號' } : null);
  const dismiss = () => { setNotice(null); setGoogleOkDismissed(true); };

  if (shown) {
    return (
      <div role={shown.ok ? 'status' : 'alert'} className={`fixed top-[max(16px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[90] w-max max-w-[min(calc(100vw-32px),32rem)] bg-surface border border-line rounded-xl shadow-xl px-4 py-2.5 text-sm flex items-center gap-2 ${shown.ok ? 'text-pos' : 'text-neg'}`}>
        {shown.ok ? <CheckCircle2 size={16} className="shrink-0" /> : <AlertCircle size={16} className="shrink-0" />}{shown.text}
        <button className="ml-2 underline text-ink-2 shrink-0" onClick={dismiss}>關閉</button>
      </div>
    );
  }
  return null;
};

export default AuthBootstrap;
