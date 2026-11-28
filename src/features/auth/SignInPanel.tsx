import React, { useState } from 'react';
import { AlertCircle, Loader2, Mail } from 'lucide-react';
import { ui } from '../../components/ui';
import { signInWithDevEmail, signInWithGoogle } from './session';
import { lineLoginAvailable, startLineLogin } from './lineLogin';

/**
 * 開放版的登入按鈕：LINE、Google。
 * 本機開發（npm run dev 連本機 Supabase）多一個 Email 一次性登入，正式建置不會出現。
 */
const SignInPanel: React.FC<{ returnTo: string; title?: string; hint?: string }> = ({ returnTo, title, hint }) => {
  const [busy, setBusy] = useState<'line' | 'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const devEmail = import.meta.env.DEV;

  const run = async (kind: 'line' | 'google' | 'email', fn: () => Promise<void> | void) => {
    setError(null);
    setBusy(kind);
    try {
      await fn();
      if (kind === 'email') setEmailSent(true);
    } catch {
      setError('登入沒有成功，請再試一次');
    } finally {
      // LINE／Google 會跳離這一頁；沒跳走就是失敗，把按鈕還原
      setBusy(null);
    }
  };

  return (
    <div className={`${ui.card} px-5 py-6 sm:px-7 sm:py-7 max-w-sm w-full mx-auto`}>
      <h2 className="text-lg font-bold text-center">{title ?? '登入旅行小本本'}</h2>
      {hint && <p className="text-sm text-muted text-center mt-1.5">{hint}</p>}
      <div className="mt-5 space-y-2.5">
        {lineLoginAvailable() && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => run('line', () => startLineLogin(returnTo))}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl py-3 text-[15px] font-bold text-white bg-[#06C755] hover:brightness-95 disabled:opacity-60"
          >
            {busy === 'line' && <Loader2 className="animate-spin" size={18} />}用 LINE 登入
          </button>
        )}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => run('google', () => signInWithGoogle(returnTo))}
          className={`${ui.btnSecondary} w-full py-3 text-[15px]`}
        >
          {busy === 'google' && <Loader2 className="animate-spin" size={18} />}用 Google 登入
        </button>
      </div>

      {devEmail && (
        <form
          className="mt-5 pt-4 border-t border-line space-y-2"
          onSubmit={e => { e.preventDefault(); if (email.trim()) run('email', () => signInWithDevEmail(email.trim(), returnTo)); }}
        >
          <p className="text-xs text-muted">本機開發專用：Email 一次性登入（信件在 http://localhost:54324）</p>
          <input type="email" className={ui.input} placeholder="test@example.com" value={email} onChange={e => setEmail(e.target.value)} />
          <button type="submit" disabled={!!busy} className={`${ui.btnSecondary} w-full`}>
            {busy === 'email' ? <Loader2 className="animate-spin" size={16} /> : <Mail size={16} />}寄登入連結
          </button>
          {emailSent && <p className="text-xs text-pos">已寄出，到本機信箱點連結就會登入</p>}
        </form>
      )}

      {error && (
        <div className={`${ui.errorBox} mt-4`}>
          <AlertCircle size={16} className="shrink-0 mt-0.5" />{error}
        </div>
      )}
      <p className="text-[11px] text-muted text-center mt-5 leading-relaxed">
        登入即表示你同意<a href="#/terms" className="underline">服務條款</a>與<a href="#/privacy" className="underline">隱私權政策</a>。我們只會取得你的名稱，用來在帳上顯示是誰。
      </p>
    </div>
  );
};

export default SignInPanel;
