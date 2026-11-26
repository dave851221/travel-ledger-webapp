import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, Check, Loader2, UserPlus } from 'lucide-react';
import { supabase } from '../api/supabase';
import { ui } from '../components/ui';
import MemberAvatar from '../features/dashboard/MemberAvatar';
import BrandMark from '../components/BrandMark';
import SignInPanel from '../features/auth/SignInPanel';
import { useSession } from '../features/auth/session';
import { PRODUCT_NAME } from '../config/mode';

/**
 * 開放版的邀請頁：#/join/{tripId}/{inviteToken}
 *
 * 1. 沒登入也先看得到旅程名稱與成員（app.invite_preview，只回這兩樣）
 * 2. 選「我是誰」：認領已經在清單上的名字，或用新名字加入
 * 3. 要加入時才請他登入，登入完回到這一頁按「加入」
 * 加入由 app.accept_invite 在資料庫裡檢查邀請碼，前端不做任何權限判斷。
 */
const JoinTrip: React.FC = () => {
  const { id, token } = useParams<{ id: string; token: string }>();
  const navigate = useNavigate();
  const { session, loading: sessionLoading } = useSession();
  const [preview, setPreview] = useState<{ name: string; members: string[] } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>(() => (id && token ? 'loading' : 'invalid'));
  // 選好「我是誰」再去登入，回來時要記得剛剛選的（登入會整頁跳走），存在這個分頁的 sessionStorage
  const choiceKey = `tlb:join_choice_${id}`;
  const savedChoice = (() => {
    try { return JSON.parse(sessionStorage.getItem(choiceKey) || 'null') as { picked: string | null; newName: string } | null; } catch { return null; }
  })();
  const [picked, setPickedState] = useState<string | null>(savedChoice?.picked ?? null);
  const [newName, setNewNameState] = useState(savedChoice?.newName ?? '');
  const remember = (p: string | null, n: string) => {
    try { sessionStorage.setItem(choiceKey, JSON.stringify({ picked: p, newName: n })); } catch { /* 隱私模式：回來再選一次 */ }
  };
  const choose = (p: string | null, n: string) => { setPickedState(p); setNewNameState(n); remember(p, n); };
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || !token) return;
    let alive = true;
    supabase.rpc('invite_preview', { p_trip_id: id, p_token: token }).then(({ data, error: err }) => {
      if (!alive) return;
      if (err || !data) { setState('invalid'); return; }
      setPreview(data as { name: string; members: string[] });
      setState('ready');
    });
    return () => { alive = false; };
  }, [id, token]);

  useEffect(() => {
    if (preview) document.title = `加入「${preview.name}」 · ${PRODUCT_NAME}`;
  }, [preview]);

  const chosenName = (picked ?? newName).trim();

  const join = async () => {
    if (!id || !token || !chosenName) return;
    setJoining(true);
    setError(null);
    const { error: err } = await supabase.rpc('accept_invite', { p_trip_id: id, p_token: token, p_member_name: chosenName });
    setJoining(false);
    if (err) {
      setError(err.message.includes('invalid_name') ? '名字要 1～20 個字'
        : err.message.includes('too_many_members') ? '這趟旅程的成員已經滿了'
        : err.message.includes('invalid_invite') ? '這個邀請連結已經失效，請向建立者要新的連結'
        : '加入失敗，請再試一次');
      return;
    }
    try { sessionStorage.removeItem(choiceKey); } catch { /* ignore */ }
    navigate(`/trip/${id}/dashboard`, { replace: true });
  };

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <main className="w-full max-w-md mx-auto px-4 pt-[max(16px,env(safe-area-inset-top))] pb-10">
        <header className="flex items-center gap-3 py-4">
          <BrandMark />
          <span className="text-lg font-bold">{PRODUCT_NAME}</span>
        </header>

        {state === 'loading' && (
          <div className="flex justify-center py-20 text-muted"><Loader2 className="animate-spin" size={24} /></div>
        )}

        {state === 'invalid' && (
          <div className={`${ui.card} px-6 py-10 text-center`}>
            <AlertCircle className="mx-auto text-neg mb-3" size={28} />
            <h1 className="text-lg font-bold">邀請連結無效</h1>
            <p className="text-sm text-muted mt-1.5">可能已經被重新產生，請向建立旅程的人要新的連結。</p>
          </div>
        )}

        {state === 'ready' && preview && (
          <div className="space-y-5">
            <div className={`${ui.card} px-5 py-5`}>
              <p className="text-xs text-muted">邀請你加入</p>
              <h1 className="text-xl font-bold mt-1">{preview.name}</h1>

              <p className={`${ui.label} mt-5`}>你是哪一位？</p>
              <div className="grid grid-cols-2 gap-2">
                {preview.members.map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => choose(m, '')}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm ${picked === m ? 'border-ink bg-sunk' : 'border-line hover:bg-sunk'}`}
                  >
                    <MemberAvatar name={m} size={26} isMe={picked === m} />
                    <span className="truncate flex-1">{m}</span>
                    {picked === m && <Check size={16} className="shrink-0" />}
                  </button>
                ))}
              </div>
              <label htmlFor="join-new-name" className={`${ui.label} mt-4`}>不在名單上？用新名字加入</label>
              <input
                id="join-new-name"
                className={ui.input}
                maxLength={20}
                placeholder="例如：小美"
                value={newName}
                onChange={e => choose(null, e.target.value)}
              />
            </div>

            {sessionLoading ? null : session ? (
              <>
                {error && (
                  <div className={ui.errorBox}><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>
                )}
                <button
                  type="button"
                  disabled={!chosenName || joining}
                  onClick={join}
                  className={`${ui.btnPrimary} w-full py-3.5 text-[15px]`}
                >
                  {joining ? <Loader2 className="animate-spin" size={18} /> : <UserPlus size={18} />}
                  {chosenName ? `以「${chosenName}」加入` : '先選你是哪一位'}
                </button>
              </>
            ) : (
              <SignInPanel
                returnTo={`/join/${id}/${token}`}
                title="登入後加入這趟旅程"
                hint="登入後就能一起記帳，之後換手機也找得回來。"
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default JoinTrip;
