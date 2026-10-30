import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Lock, Loader2, ChevronLeft, AlertCircle } from 'lucide-react';
import { supabase } from '../api/supabase';
import { ui } from '../components/ui';

const TripPortal: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tripName, setTripName] = useState('');
  // 進入畫面前需先確認此旅程是否設有密碼，確認完成前不顯示密碼表單
  const [checking, setChecking] = useState(true);
  // 旅程被刪除或連結打錯時，trip_requires_code 會回 TRUE（fail closed），
  // 不另外判斷的話使用者會看到一個永遠輸入不對的密碼欄
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const enterDashboard = () => {
      localStorage.setItem(`auth_${id}`, 'true');
      navigate(`/trip/${id}/dashboard`, { replace: true });
    };

    const bootstrap = async () => {
      // 1. 已驗證過就直接進入
      if (localStorage.getItem(`auth_${id}`)) {
        navigate(`/trip/${id}/dashboard`, { replace: true });
        return;
      }

      if (!supabase || !id) { setChecking(false); return; }

      // maybeSingle：查無資料時回 null 而不是 406 錯誤
      const { data, error: tripError } = await supabase.from('trips').select('name').eq('id', id).maybeSingle();
      if (cancelled) return;
      if (data) setTripName(data.name);
      // 只有「確定查無此旅程」才擋下；網路錯誤時照舊顯示密碼欄讓使用者重試
      if (!data && !tripError) {
        setNotFound(true);
        setChecking(false);
        return;
      }

      // 2. 免密碼旅程直接放行；RPC 失敗時保守地要求輸入密碼
      const { data: needsCode, error: rpcError } = await supabase
        .rpc('trip_requires_code', { p_trip_id: id });
      if (cancelled) return;

      if (!rpcError && needsCode === false) {
        enterDashboard();
        return;
      }
      setChecking(false);
    };

    bootstrap();
    return () => { cancelled = true; };
  }, [id, navigate]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { data: isValid, error } = await supabase
        .rpc('verify_trip_code', { p_trip_id: id, p_code: code.trim() });

      if (error) throw error;

      if (isValid) {
        localStorage.setItem(`auth_${id}`, 'true');
        navigate(`/trip/${id}/dashboard`, { replace: true });
      } else {
        setError('密碼錯誤，請再試一次。');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError('驗證時發生錯誤：' + msg);
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-6 text-ink-2">
        <Loader2 className="animate-spin text-ink mb-3" size={28} />
        <p className="text-sm">正在確認旅程權限…</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-canvas text-ink flex flex-col items-center justify-center gap-4 p-6 text-center">
        <span className="inline-flex w-12 h-12 rounded-2xl bg-sunk text-muted items-center justify-center"><AlertCircle size={24} /></span>
        <div>
          <p className="text-base font-bold">找不到這趟旅程</p>
          <p className="text-sm text-ink-2 mt-1">連結可能打錯了，或這趟旅程已經被刪除。</p>
        </div>
        <button onClick={() => navigate('/')} className={ui.btnPrimary}>回到所有旅程</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink flex items-center justify-center px-4 py-10">
      <div className="max-w-sm w-full">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1 text-sm text-ink-2 hover:text-ink transition-colors mb-5 -ml-1"
        >
          <ChevronLeft size={18} />
          所有旅程
        </button>

        <div className="bg-surface border border-line rounded-2xl overflow-hidden">
          <div className="bg-navy text-navy-fg px-6 pt-6 pb-5">
            <span className="inline-flex w-10 h-10 rounded-xl bg-accent text-on-accent items-center justify-center mb-3">
              <Lock size={18} strokeWidth={2.2} />
            </span>
            <p className="text-xs text-navy-sub">這趟旅程需要密碼</p>
            <h1 className="text-xl font-bold mt-0.5 text-balance">{tripName || '旅程'}</h1>
          </div>

          <form onSubmit={handleVerify} className="p-6 space-y-4">
            <div>
              <label htmlFor="portal-code" className={ui.label}>進入密碼</label>
              <input
                id="portal-code"
                type="password"
                autoComplete="current-password"
                maxLength={6}
                placeholder="請輸入密碼"
                className={`${ui.input} text-center text-xl tracking-[0.4em] placeholder:tracking-normal placeholder:text-sm py-3.5`}
                value={code}
                onChange={e => setCode(e.target.value)}
                autoFocus
              />
            </div>

            {error && (
              <div className={ui.errorBox}>
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* 建立旅程與設定頁都沒有限制最短長度，這裡若要求至少 4 碼，設了短密碼的人會完全進不去 */}
            <button
              disabled={loading || !code.trim()}
              className={`${ui.btnPrimary} w-full py-3.5 text-[15px]`}
            >
              {loading ? <Loader2 className="animate-spin" size={18} /> : '進入旅程'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default TripPortal;
