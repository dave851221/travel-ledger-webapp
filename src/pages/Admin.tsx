import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Ban, Loader2 } from 'lucide-react';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { supabase } from '../api/supabase';
import { ui } from '../components/ui';
import TripsPanel from '../features/admin/TripsPanel';
import AccountsPanel from '../features/admin/AccountsPanel';
import type { AdminAccountRow, AdminTripRow } from '../features/admin/types';
import { useSession } from '../features/auth/session';

/**
 * 開放版的開發者後台（David 2026-11-27）。
 * 權限全部在資料庫：每支 admin_* RPC 都先檢查 app.site_admins，這頁只是畫面。
 * 看得到統計、旅程名稱、遮過的帳號資訊；看不到帳目內容與照片。
 */

interface PlanRow { plan: string; max_entries: number; max_ai_calls: number; max_photos: number }
interface Overview {
  accounts: number; paid_accounts: number; trips: number; paid_trips: number; expenses: number;
  ai_today: number; ai_7d: number; ai_total: number; ai_30d: number; ai_kind_30d: Record<string, number>; photos: number; photo_bytes?: number; line_chats: number;
  ai_by_day: { day: string; calls: number }[];
  settings: { ai_enabled: boolean; free_trip_creations: number };
  plans: PlanRow[];
}
/** 每次 AI 大約多少錢（11/21 正式環境量的，Haiku 5.5）：文字 NT$0.07、收據 NT$0.04 */
const COST_PER_CALL: Record<string, number> = { text: 0.07, receipt: 0.04, voice: 0.01, search: 0.35, other: 0.07 };
const estimateCost = (kinds: Record<string, number>) =>
  Math.round(Object.entries(kinds ?? {}).reduce((sum, [k, n]) => sum + (COST_PER_CALL[k] ?? 0.07) * n, 0));

type TripRow = AdminTripRow;
type AccountRow = AdminAccountRow;

type Tab = 'overview' | 'trips' | 'accounts';

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className={`${ui.card} px-4 py-3`}>
    <p className="text-xs text-muted">{label}</p>
    <p className="text-xl font-bold num mt-0.5">{value}</p>
  </div>
);

/** Cloudflare R2 免費方案的儲存空間 */
const R2_FREE_BYTES = 10 * 1024 ** 3;

const formatBytes = (n: number): string =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`;

/** 照片空間：已用多少、離 R2 免費 10 GB 還有多遠 */
const PhotoStorage: React.FC<{ bytes: number; photos: number }> = ({ bytes, photos }) => {
  const pct = Math.min(100, (bytes / R2_FREE_BYTES) * 100);
  const avg = photos > 0 ? bytes / photos : 0;
  const tone = pct >= 90 ? 'bg-neg' : pct >= 70 ? 'bg-accent' : 'bg-primary';
  return (
    <section className={`${ui.card} p-4 space-y-2`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold">照片空間（Cloudflare R2）</p>
        <p className="text-sm num"><span className="font-bold">{formatBytes(bytes)}</span><span className="text-muted"> / 10 GB 免費</span></p>
      </div>
      <div className="h-2 rounded-full bg-sunk overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(pct, bytes > 0 ? 1 : 0)}%` }} />
      </div>
      <p className="text-xs text-muted">
        {photos > 0 ? `平均一張 ${Math.round(avg / 1024)} KB，免費空間大約還能放 ${Math.max(0, Math.floor((R2_FREE_BYTES - bytes) / avg)).toLocaleString()} 張。` : '還沒有照片。'}
        超過後每 GB 每月 0.015 美元。
      </p>
    </section>
  );
};

const Admin: React.FC = () => {
  const navigate = useNavigate();
  const { session, loading: sessionLoading } = useSession();
  const [adminCheck, setAdminCheck] = useState<boolean | null>(null);
  const allowed = sessionLoading ? null : !session ? false : adminCheck;
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [editing, setEditing] = useState<TripRow | null>(null);
  const [busy, setBusy] = useState(false);
  // 成功／失敗用浮動的 toast，不插在版面裡（David 2026-11-27：通知一出現下面整排會跳動）
  const { toast, showToast, dismissToast } = useToast();

  const loadOverview = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_overview');
    if (err) showToast('讀不到總覽', 'error'); else setOverview(data as Overview);
  }, [showToast]);
  const loadTrips = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_trips', { p_search: null, p_limit: 200 });
    if (err) showToast('讀不到旅程', 'error'); else setTrips(data as TripRow[]);
  }, [showToast]);
  const loadAccounts = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_accounts', { p_limit: 200 });
    if (err) showToast('讀不到帳號', 'error'); else setAccounts(data as AccountRow[]);
  }, [showToast]);

  // 確認是管理員之後才讀總覽；其他分頁點下去才讀
  useEffect(() => {
    if (!session) return;
    let alive = true;
    supabase.rpc('is_site_admin').then(({ data }) => {
      if (!alive) return;
      setAdminCheck(data === true);
      if (data === true) void loadOverview();
    });
    return () => { alive = false; };
  }, [session, loadOverview]);

  const openTab = (k: Tab) => {
    setTab(k);
    if (k === 'overview') void loadOverview();
    if (k === 'trips' && trips === null) void loadTrips();
    if (k === 'accounts' && accounts === null) void loadAccounts();
  };

  const run = async (label: string, fn: () => PromiseLike<{ error: unknown }>, after: () => Promise<void>) => {
    setBusy(true);
    const { error: err } = await fn();
    setBusy(false);
    if (err) { showToast(`${label}失敗`, 'error'); return; }
    showToast(`${label}完成`);
    await after();
  };

  if (allowed === null) return <div className="min-h-screen flex items-center justify-center text-muted"><Loader2 className="animate-spin" /></div>;
  if (!allowed) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-ink-2 px-6 text-center">
        <Ban size={28} />
        <p>這個頁面只有開發者可以使用。</p>
        <button className={ui.btnSecondary} onClick={() => navigate('/')}>回首頁</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <main className="w-full max-w-5xl mx-auto px-4 sm:px-8 pt-[max(16px,env(safe-area-inset-top))] pb-10 space-y-4">
        <header className="flex items-center gap-2 py-2">
          <button className={ui.iconBtn} aria-label="回首頁" onClick={() => navigate('/')}><ArrowLeft size={18} /></button>
          <h1 className="text-lg font-bold">開發者後台</h1>
        </header>

        <div className="flex gap-1.5" role="tablist">
          {([['overview', '總覽與設定'], ['trips', '旅程'], ['accounts', '帳號']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => openTab(k)} className={`${ui.chip} ${tab === k ? ui.chipOn : ui.chipOff}`}>{label}</button>
          ))}
        </div>


        {tab === 'overview' && (overview === null ? <Loader2 className="animate-spin text-muted" /> : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="帳號" value={overview.accounts} />
              <Stat label="付費帳號" value={overview.paid_accounts} />
              <Stat label="旅程（已解鎖）" value={`${overview.trips}（${overview.paid_trips}）`} />
              <Stat label="帳目" value={overview.expenses} />
              <Stat label="AI 今天" value={overview.ai_today} />
              <Stat label="AI 7 天" value={overview.ai_7d} />
              <Stat label="照片" value={overview.photos} />
              <Stat label="綁定的 LINE 聊天" value={overview.line_chats} />
            </div>

            <PhotoStorage bytes={overview.photo_bytes ?? 0} photos={overview.photos} />

            <section className={`${ui.card} p-4 space-y-3`}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-bold">最近 14 天的 AI 次數</p>
                <p className="text-xs text-muted num">近 30 天 {overview.ai_30d} 次・估計 NT${estimateCost(overview.ai_kind_30d)}</p>
              </div>
              <div className="flex items-end gap-1 h-28">
                {overview.ai_by_day.map(d => {
                  const max = Math.max(...overview.ai_by_day.map(x => x.calls), 1);
                  return (
                    <div key={d.day} className="flex-1 min-w-0 flex flex-col items-center justify-end gap-0.5 h-full" title={`${d.day}：${d.calls} 次`}>
                      {d.calls > 0 && <span className="text-[10px] num font-bold text-ink-2">{d.calls}</span>}
                      <div className={`w-full rounded-t ${d.calls > 0 ? 'bg-accent' : 'bg-sunk'}`} style={{ height: `${Math.max((d.calls / max) * 72, 2)}px` }} />
                      <span className="text-[9px] text-muted num">{Number(d.day.slice(8))}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted">
                Anthropic 不提供用 API 查剩餘儲值，餘額請看 Console；這裡的花費是用每次約 NT$0.07（文字）／0.04（收據）估的。
              </p>
            </section>

            <SettingsCard overview={overview} busy={busy}
              onSave={(aiEnabled, freeTrips) => run('全站設定', () => supabase.rpc('admin_update_settings', { p_ai_enabled: aiEnabled, p_free_trip_creations: freeTrips }), loadOverview)}
              onSavePlan={p => run(`${p.plan === 'paid' ? '解鎖' : '免費'}方案`, () => supabase.rpc('admin_update_plan', {
                p_plan: p.plan, p_max_entries: p.max_entries, p_max_ai_calls: p.max_ai_calls, p_max_photos: p.max_photos,
              }), loadOverview)}
            />
          </div>
        ))}

        {tab === 'trips' && (trips === null ? <Loader2 className="animate-spin text-muted" /> : (
          <TripsPanel trips={trips} onEdit={setEditing} />
        ))}

        {tab === 'accounts' && (accounts === null ? <Loader2 className="animate-spin text-muted" /> : (
          <AccountsPanel accounts={accounts} busy={busy}
            onSetPaid={(a, paid) => run(paid ? '標記付費' : '取消付費', () => supabase.rpc('admin_set_paid', { p_user_id: a.id, p_paid: paid }), loadAccounts)} />
        ))}
      </main>

      {editing && (
        <TripEditor trip={editing} busy={busy} onClose={() => setEditing(null)}
          onSave={v => run('調整旅程', () => supabase.rpc('admin_update_trip', {
            p_trip_id: editing.id, p_plan: v.plan, p_extra_entries: v.extra_entries, p_extra_ai_calls: v.extra_ai_calls,
            p_extra_photos: v.extra_photos, p_ai_suspended: v.ai_suspended,
          }), async () => { setEditing(null); await loadTrips(); })}
        />
      )}
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
};

/**
 * 數字欄位：打字時留著使用者看到的字（可以整個刪掉，不會卡在 0、打成「060」），
 * 只把合法的數字往外送；離開欄位時空白就回到 0。
 */
const NumField: React.FC<{ label: string; value: number; onChange: (n: number) => void }> = ({ label, value, onChange }) => {
  const [text, setText] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  // 外面的值變了（例如重新讀取）才跟著換，打字中不打斷
  if (value !== lastValue) { setLastValue(value); setText(String(value)); }
  return (
    <label className="block">
      <span className={ui.label}>{label}</span>
      <input type="text" inputMode="numeric" className={`${ui.input} num`} value={text}
        onChange={e => {
          const t = e.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
          setText(t);
          if (t !== '') { const n = Number(t); setLastValue(n); onChange(n); }
        }}
        onBlur={() => { if (text === '') { setText('0'); setLastValue(0); onChange(0); } }} />
    </label>
  );
};

const SettingsCard: React.FC<{
  overview: Overview; busy: boolean;
  onSave: (aiEnabled: boolean, freeTrips: number) => void;
  onSavePlan: (p: PlanRow) => void;
}> = ({ overview, busy, onSave, onSavePlan }) => {
  const [aiEnabled, setAiEnabled] = useState(overview.settings.ai_enabled);
  const [freeTrips, setFreeTrips] = useState(overview.settings.free_trip_creations);
  const [plans, setPlans] = useState(overview.plans);
  const setPlan = (i: number, patch: Partial<PlanRow>) => setPlans(ps => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <section className={`${ui.card} p-4 space-y-4`}>
      <p className="text-sm font-bold">全站設定</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={aiEnabled} onChange={e => setAiEnabled(e.target.checked)} />
        AI 開著（關掉＝所有旅程的 AI 立刻停，緊急時用）
      </label>
      <div className="max-w-xs"><NumField label="沒付過費的帳號最多建立幾趟" value={freeTrips} onChange={setFreeTrips} /></div>
      <button className={ui.btnPrimary} disabled={busy} onClick={() => onSave(aiEnabled, freeTrips)}>儲存全站設定</button>

      <div className="space-y-3 pt-2 border-t border-line">
        <p className="text-sm font-bold">方案上限（每趟）</p>
        {plans.map((p, i) => (
          <div key={p.plan} className="grid grid-cols-3 sm:grid-cols-[6rem_1fr_1fr_1fr_auto] gap-2 items-end">
            <span className="col-span-3 sm:col-span-1 text-sm font-medium pb-2.5">{p.plan === 'paid' ? '解鎖' : '免費'}</span>
            <NumField label="記帳筆數" value={p.max_entries} onChange={n => setPlan(i, { max_entries: n })} />
            <NumField label="AI 次數" value={p.max_ai_calls} onChange={n => setPlan(i, { max_ai_calls: n })} />
            <NumField label="照片" value={p.max_photos} onChange={n => setPlan(i, { max_photos: n })} />
            <button className={`${ui.btnSecondary} col-span-3 sm:col-span-1`} disabled={busy} onClick={() => onSavePlan(p)}>儲存</button>
          </div>
        ))}
      </div>
    </section>
  );
};

const TripEditor: React.FC<{
  trip: TripRow; busy: boolean; onClose: () => void;
  onSave: (v: Pick<TripRow, 'plan' | 'extra_entries' | 'extra_ai_calls' | 'extra_photos' | 'ai_suspended'>) => void;
}> = ({ trip, busy, onClose, onSave }) => {
  const [v, setV] = useState({
    plan: trip.plan, extra_entries: trip.extra_entries, extra_ai_calls: trip.extra_ai_calls,
    extra_photos: trip.extra_photos, ai_suspended: trip.ai_suspended,
  });
  return (
    <div className="fixed inset-0 z-50 bg-scrim flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <p className="font-bold truncate">調整「{trip.name}」</p>
        <label className="block">
          <span className={ui.label}>方案</span>
          <select className={ui.select} value={v.plan} onChange={e => setV({ ...v, plan: e.target.value })}>
            <option value="free">免費</option>
            <option value="paid">解鎖</option>
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <NumField label="加記帳筆數" value={v.extra_entries} onChange={n => setV({ ...v, extra_entries: n })} />
          <NumField label="加 AI 次數" value={v.extra_ai_calls} onChange={n => setV({ ...v, extra_ai_calls: n })} />
          <NumField label="加照片" value={v.extra_photos} onChange={n => setV({ ...v, extra_photos: n })} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.ai_suspended} onChange={e => setV({ ...v, ai_suspended: e.target.checked })} />
          暫停這趟的 AI（帳還是能在網頁記）
        </label>
        <div className="flex gap-2">
          <button className={`${ui.btnSecondary} flex-1`} onClick={onClose}>取消</button>
          <button className={`${ui.btnPrimary} flex-1`} disabled={busy} onClick={() => onSave(v)}>
            {busy && <Loader2 size={16} className="animate-spin" />}儲存
          </button>
        </div>
      </div>
    </div>
  );
};

export default Admin;
