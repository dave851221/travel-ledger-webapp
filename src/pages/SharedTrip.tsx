import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, ArrowRight, Lock, Loader2 } from 'lucide-react';
import { supabase } from '../api/supabase';
import { ui } from '../components/ui';
import BrandMark from '../components/BrandMark';
import type { Expense, Trip } from '../types';
import { calculateMemberBalances, getCurrencyPrecision } from '../utils/finance';
import { calculateSettlements } from '../utils/settlement';
import { formatMoney } from '../utils/money';
import { PRODUCT_NAME } from '../config/mode';

type Snapshot = { trip: Trip; expenses: Expense[] };

/**
 * 開放版的分享頁：#/s/{tripId}/{shareToken}，給沒登入的人「只看不改」。
 *
 * 資料只從 app.get_trip_snapshot 來（資料庫檢查分享設定、連結與密碼），
 * 不會碰任何需要登入的查詢。照片不在這裡顯示：私有 bucket 的簽名網址只發給成員。
 */
const SharedTrip: React.FC = () => {
  const { id, token } = useParams<{ id: string; token: string }>();
  const [state, setState] = useState<'loading' | 'ready' | 'password' | 'invalid'>(() => (id && token ? 'loading' : 'invalid'));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [password, setPassword] = useState('');
  const [wrongPassword, setWrongPassword] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = async (pw: string | null) => {
    if (!id || !token) return;
    const { data, error } = await supabase.rpc('get_trip_snapshot', { p_trip_id: id, p_token: token, p_password: pw });
    if (error) {
      if (error.message.includes('wrong_password')) {
        setWrongPassword(pw !== null);
        setState('password');
      } else {
        setState('invalid');
      }
      return;
    }
    setSnapshot(data as Snapshot);
    setState('ready');
  };

  useEffect(() => {
    if (!id || !token) return;
    let alive = true;
    supabase.rpc('get_trip_snapshot', { p_trip_id: id, p_token: token, p_password: null }).then(({ data, error }) => {
      if (!alive) return;
      if (error) { setState(error.message.includes('wrong_password') ? 'password' : 'invalid'); return; }
      setSnapshot(data as Snapshot);
      setState('ready');
    });
    return () => { alive = false; };
  }, [id, token]);

  useEffect(() => {
    if (snapshot) document.title = `${snapshot.trip.name} · ${PRODUCT_NAME}`;
  }, [snapshot]);

  const summary = useMemo(() => {
    if (!snapshot) return null;
    const { trip, expenses } = snapshot;
    const balances = calculateMemberBalances(expenses, trip.members, trip.rates, trip.base_currency);
    const settlements = calculateSettlements(balances.grandTotal, getCurrencyPrecision(trip.base_currency, trip.precision_config));
    const spending = expenses.filter(e => !e.is_settlement);
    return { balances, settlements, spending };
  }, [snapshot]);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setChecking(true);
    await load(password);
    setChecking(false);
  };

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <main className="w-full max-w-2xl mx-auto px-4 pt-[max(16px,env(safe-area-inset-top))] pb-10">
        <header className="flex items-center gap-3 py-4">
          <BrandMark />
          <span className="text-lg font-bold">{PRODUCT_NAME}</span>
          <span className="ml-auto text-xs text-muted">分享檢視 · 只能看不能改</span>
        </header>

        {state === 'loading' && (
          <div className="flex justify-center py-20 text-muted"><Loader2 className="animate-spin" size={24} /></div>
        )}

        {state === 'invalid' && (
          <div className={`${ui.card} px-6 py-10 text-center`}>
            <AlertCircle className="mx-auto text-neg mb-3" size={28} />
            <h1 className="text-lg font-bold">這個分享連結無法使用</h1>
            <p className="text-sm text-muted mt-1.5">可能已經關閉分享或重新產生了連結，請向旅程成員要新的連結。</p>
          </div>
        )}

        {state === 'password' && (
          <form onSubmit={submitPassword} className={`${ui.card} px-6 py-8 max-w-sm mx-auto space-y-3`}>
            <Lock className="mx-auto text-muted" size={26} />
            <h1 className="text-lg font-bold text-center">這趟旅程需要密碼</h1>
            <input
              type="password"
              autoComplete="current-password"
              aria-label="密碼"
              className={ui.input}
              value={password}
              onChange={e => { setPassword(e.target.value); setWrongPassword(false); }}
            />
            {wrongPassword && <p className="text-sm text-neg">密碼不對，再試一次</p>}
            <button type="submit" disabled={!password || checking} className={`${ui.btnPrimary} w-full`}>
              {checking && <Loader2 className="animate-spin" size={16} />}查看
            </button>
          </form>
        )}

        {state === 'ready' && snapshot && summary && (
          <div className="space-y-6">
            <h1 className="text-2xl font-bold">{snapshot.trip.name}</h1>

            <section className={`${ui.card} p-4`}>
              <h2 className="text-sm font-bold mb-3">建議結清</h2>
              {summary.settlements.length === 0 ? (
                <p className="text-sm text-muted">目前沒有需要結清的款項</p>
              ) : (
                <ul className="space-y-2">
                  {summary.settlements.map((s, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{s.from}</span>
                      <ArrowRight size={14} className="text-muted" />
                      <span className="font-medium">{s.to}</span>
                      <span className="ml-auto num font-bold">
                        {formatMoney(s.amount, snapshot.trip.base_currency, snapshot.trip.precision_config)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={`${ui.card} overflow-hidden`}>
              <h2 className="text-sm font-bold px-4 pt-4 pb-2">帳目（{summary.spending.length} 筆）</h2>
              <ul className="divide-y divide-line">
                {summary.spending.map(e => (
                  <li key={e.id} className="px-4 py-3 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{e.description}</p>
                      <p className="text-xs text-muted mt-0.5">
                        <span className="num">{e.date}</span> · {e.category} · {Object.keys(e.payer_data || {}).join('、')} 付
                      </p>
                    </div>
                    <span className="num text-sm font-bold shrink-0">
                      {formatMoney(Number(e.amount), e.currency, snapshot.trip.precision_config)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </main>
    </div>
  );
};

export default SharedTrip;
