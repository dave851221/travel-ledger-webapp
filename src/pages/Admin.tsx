import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Ban, Check, Loader2, MessageCircle, Search } from 'lucide-react';
import { supabase } from '../api/supabase';
import { ui } from '../components/ui';
import LoginBadges from '../features/auth/LoginBadges';
import type { LoginInfo } from '../features/auth/loginInfo';
import { useSession } from '../features/auth/session';

/**
 * 開放版的開發者後台（David 2026-11-27）。
 * 權限全部在資料庫：每支 admin_* RPC 都先檢查 app.site_admins，這頁只是畫面。
 * 看得到統計、旅程名稱、遮過的帳號資訊；看不到帳目內容與照片。
 */

interface PlanRow { plan: string; max_entries: number; max_ai_calls: number; max_photos: number }
interface Overview {
  accounts: number; paid_accounts: number; trips: number; paid_trips: number; expenses: number;
  ai_today: number; ai_7d: number; ai_total: number; photos: number; line_chats: number;
  ai_by_day: { day: string; calls: number }[];
  settings: { ai_enabled: boolean; free_trip_creations: number };
  plans: PlanRow[];
}
interface Limits { max_entries: number; max_ai_calls: number; max_photos: number }
interface TripRow {
  id: string; name: string; created_at: string; is_archived: boolean; plan: string;
  extra_entries: number; extra_ai_calls: number; extra_photos: number; ai_suspended: boolean;
  members: number; accounts: number; owner: LoginInfo[] | null; line_bound: boolean; last_entry: string | null;
  limits: Limits; entries: number; ai_calls: number; photos: number;
}
interface AccountRow {
  id: string; created_at: string; last_sign_in_at: string | null; logins: LoginInfo[];
  paid: boolean; admin: boolean; trips: number; ai_calls: number;
  allowance: { created: number; limit: number; paid: boolean };
}

type Tab = 'overview' | 'trips' | 'accounts';
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) : '—');
const meterTone = (used: number, limit: number) => (limit > 0 && used >= limit ? 'text-neg font-bold' : limit > 0 && used >= limit * 0.8 ? 'text-warn font-bold' : 'text-ink-2');

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className={`${ui.card} px-4 py-3`}>
    <p className="text-xs text-muted">{label}</p>
    <p className="text-xl font-bold num mt-0.5">{value}</p>
  </div>
);

const Admin: React.FC = () => {
  const navigate = useNavigate();
  const { session, loading: sessionLoading } = useSession();
  const [adminCheck, setAdminCheck] = useState<boolean | null>(null);
  const allowed = sessionLoading ? null : !session ? false : adminCheck;
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<TripRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_overview');
    if (err) setError('讀不到總覽'); else setOverview(data as Overview);
  }, []);
  const loadTrips = useCallback(async (q: string) => {
    const { data, error: err } = await supabase.rpc('admin_trips', { p_search: q || null, p_limit: 100 });
    if (err) setError('讀不到旅程'); else setTrips(data as TripRow[]);
  }, []);
  const loadAccounts = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_accounts', { p_limit: 200 });
    if (err) setError('讀不到帳號'); else setAccounts(data as AccountRow[]);
  }, []);

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
    if (k === 'trips' && trips === null) void loadTrips('');
    if (k === 'accounts' && accounts === null) void loadAccounts();
  };

  const run = async (label: string, fn: () => PromiseLike<{ error: unknown }>, after: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    const { error: err } = await fn();
    setBusy(false);
    if (err) { setError(`${label}失敗`); return; }
    setNotice(`${label}完成`);
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

        {error && <div className={ui.errorBox}><AlertCircle size={16} className="shrink-0 mt-0.5" />{error}</div>}
        {notice && <div className="flex items-center gap-2 rounded-xl bg-pos/10 text-pos px-3 py-2.5 text-sm"><Check size={16} />{notice}</div>}

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

            {overview.ai_by_day.length > 0 && (
              <section className={`${ui.card} p-4`}>
                <p className="text-sm font-bold mb-2">最近 14 天的 AI 次數</p>
                <div className="flex items-end gap-1 h-24">
                  {overview.ai_by_day.map(d => {
                    const max = Math.max(...overview.ai_by_day.map(x => x.calls), 1);
                    return (
                      <div key={d.day} className="flex-1 flex flex-col items-center gap-1" title={`${d.day}：${d.calls} 次`}>
                        <div className="w-full rounded-t bg-accent" style={{ height: `${(d.calls / max) * 80}px` }} />
                        <span className="text-[10px] text-muted">{d.day.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <SettingsCard overview={overview} busy={busy}
              onSave={(aiEnabled, freeTrips) => run('全站設定', () => supabase.rpc('admin_update_settings', { p_ai_enabled: aiEnabled, p_free_trip_creations: freeTrips }), loadOverview)}
              onSavePlan={p => run(`${p.plan === 'paid' ? '解鎖' : '免費'}方案`, () => supabase.rpc('admin_update_plan', {
                p_plan: p.plan, p_max_entries: p.max_entries, p_max_ai_calls: p.max_ai_calls, p_max_photos: p.max_photos,
              }), loadOverview)}
            />
          </div>
        ))}

        {tab === 'trips' && (
          <div className="space-y-3">
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void loadTrips(search.trim()); }}>
              <input className={ui.input} placeholder="旅程名稱或 id" value={search} onChange={e => setSearch(e.target.value)} />
              <button type="submit" className={`${ui.btnSecondary} px-3`} aria-label="搜尋"><Search size={16} /></button>
            </form>
            {trips === null ? <Loader2 className="animate-spin text-muted" /> : trips.length === 0 ? <p className="text-sm text-muted">沒有旅程</p> : (
              <ul className={`${ui.card} divide-y divide-line`}>
                {trips.map(t => (
                  <li key={t.id} className="px-4 py-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold truncate flex-1 min-w-0">{t.name}</span>
                      {t.plan === 'paid' && <span className="text-[11px] font-bold text-accent">已解鎖</span>}
                      {t.ai_suspended && <span className="text-[11px] font-bold text-neg">AI 暫停</span>}
                      {t.line_bound && <MessageCircle size={14} className="text-pos" aria-label="已綁定 LINE" />}
                      <button className="text-xs text-accent font-medium hover:underline" onClick={() => setEditing(t)}>調整</button>
                    </div>
                    <div className="text-xs text-muted flex flex-wrap gap-x-3 gap-y-0.5 num">
                      <span>建立 {day(t.created_at)}・最後記帳 {day(t.last_entry)}</span>
                      <span>成員 {t.members}・帳號 {t.accounts}</span>
                      <span className={meterTone(t.entries, t.limits.max_entries)}>記帳 {t.entries}/{t.limits.max_entries}</span>
                      <span className={meterTone(t.ai_calls, t.limits.max_ai_calls)}>AI {t.ai_calls}/{t.limits.max_ai_calls}</span>
                      <span className={meterTone(t.photos, t.limits.max_photos)}>照片 {t.photos}/{t.limits.max_photos}</span>
                    </div>
                    {t.owner && <LoginBadges logins={t.owner} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'accounts' && (accounts === null ? <Loader2 className="animate-spin text-muted" /> : (
          <ul className={`${ui.card} divide-y divide-line`}>
            {accounts.map(a => (
              <li key={a.id} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <LoginBadges logins={a.logins} />
                  <p className="text-xs text-muted num">
                    註冊 {day(a.created_at)}・上次登入 {day(a.last_sign_in_at)}・旅程 {a.trips}・建立 {a.allowance.created}
                    {a.allowance.paid ? '' : `/${a.allowance.limit}`}・AI {a.ai_calls}{a.admin ? '・管理員' : ''}
                  </p>
                </div>
                <label className="flex items-center gap-1.5 text-xs shrink-0">
                  <input type="checkbox" checked={a.paid} disabled={busy}
                    onChange={e => run(e.target.checked ? '標記付費' : '取消付費', () => supabase.rpc('admin_set_paid', { p_user_id: a.id, p_paid: e.target.checked }), loadAccounts)} />
                  付費
                </label>
              </li>
            ))}
          </ul>
        ))}
      </main>

      {editing && (
        <TripEditor trip={editing} busy={busy} onClose={() => setEditing(null)}
          onSave={v => run('調整旅程', () => supabase.rpc('admin_update_trip', {
            p_trip_id: editing.id, p_plan: v.plan, p_extra_entries: v.extra_entries, p_extra_ai_calls: v.extra_ai_calls,
            p_extra_photos: v.extra_photos, p_ai_suspended: v.ai_suspended,
          }), async () => { setEditing(null); await loadTrips(search.trim()); })}
        />
      )}
    </div>
  );
};

const NumField: React.FC<{ label: string; value: number; onChange: (n: number) => void }> = ({ label, value, onChange }) => (
  <label className="block">
    <span className={ui.label}>{label}</span>
    <input type="number" min={0} className={ui.input} value={value} onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))} />
  </label>
);

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
