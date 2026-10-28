import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Save, 
  Trash2, 
  Plus, 
  Lock,
  Unlock, 
  AlertCircle,
  Loader2,
  Archive,
  Download,
  Copy,
  Check,
  MessageCircle,
  Bot
} from 'lucide-react';
import Modal from './Modal';
import { ui } from './ui';
import { supabase } from '../api/supabase';
import type { Trip, Expense } from '../types';
import { exportExpensesToCSV } from '../utils/finance';
import { isSubmitEnter } from '../utils/keyboard';
import Decimal from 'decimal.js';

/**
 * 旅程時區的候選清單（M4）。
 *
 * 刻意只列常去的地方而不是完整的 IANA 清單 —— 幾百個選項在手機上根本選不到。
 * 需要別的時區時可以直接改資料庫，Edge Function 會驗證字串是不是 Intl 認得的。
 */
const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Asia/Taipei', label: '台北 (Asia/Taipei)' },
  { value: 'Asia/Tokyo', label: '東京 (Asia/Tokyo)' },
  { value: 'Asia/Seoul', label: '首爾 (Asia/Seoul)' },
  { value: 'Asia/Hong_Kong', label: '香港 (Asia/Hong_Kong)' },
  { value: 'Asia/Shanghai', label: '上海 (Asia/Shanghai)' },
  { value: 'Asia/Singapore', label: '新加坡 (Asia/Singapore)' },
  { value: 'Asia/Bangkok', label: '曼谷 (Asia/Bangkok)' },
  { value: 'Asia/Kuala_Lumpur', label: '吉隆坡 (Asia/Kuala_Lumpur)' },
  { value: 'Asia/Ho_Chi_Minh', label: '胡志明市 (Asia/Ho_Chi_Minh)' },
  { value: 'Asia/Jakarta', label: '雅加達 (Asia/Jakarta)' },
  { value: 'Asia/Manila', label: '馬尼拉 (Asia/Manila)' },
  { value: 'Asia/Dubai', label: '杜拜 (Asia/Dubai)' },
  { value: 'Australia/Sydney', label: '雪梨 (Australia/Sydney)' },
  { value: 'Pacific/Auckland', label: '奧克蘭 (Pacific/Auckland)' },
  { value: 'Europe/London', label: '倫敦 (Europe/London)' },
  { value: 'Europe/Paris', label: '巴黎 (Europe/Paris)' },
  { value: 'Europe/Zurich', label: '蘇黎世 (Europe/Zurich)' },
  { value: 'America/New_York', label: '紐約 (America/New_York)' },
  { value: 'America/Los_Angeles', label: '洛杉磯 (America/Los_Angeles)' },
  { value: 'America/Toronto', label: '多倫多 (America/Toronto)' },
  { value: 'UTC', label: 'UTC' },
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  trip: Trip;
  onSuccess: () => void;
  expenses: Expense[];
}

type TabType = 'basic' | 'members' | 'finance' | 'categories';

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, trip, onSuccess, expenses }) => {
  const [activeTab, setActiveTab] = useState<TabType>('basic');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form States
  const [name, setName] = useState(trip.name);
  const [accessCode, setAccessCode] = useState(trip.access_code || '');
  const [isArchived, setIsArchived] = useState(trip.is_archived);
  const [members, setMembers] = useState<string[]>([...trip.members]);
  const [categories, setCategories] = useState<string[]>([...trip.categories]);
  const [tripCategory, setTripCategory] = useState<string>(trip.category || '');
  const [knownTripCategories, setKnownTripCategories] = useState<string[]>([]);
  const [lineBotId, setLineBotId] = useState<string>('');
  const [aiPreference, setAiPreference] = useState(trip.ai_preference || '');
  const [copied, setCopied] = useState(false);
  
  // 每一列成員在資料庫裡的原名（新加的成員是 null），與 members 同索引。
  // ⚠️ 不能拿 trip.members[index] 當原名：刪掉前面的成員後索引就錯位了，
  //    改名會套到別人的支出 JSONB 上。
  const [memberOrigins, setMemberOrigins] = useState<(string | null)[]>([...trip.members]);
  
  const [ratesStr, setRatesStr] = useState<Record<string, string>>({});
  const [precisionStr, setPrecisionStr] = useState<Record<string, string>>({});
  const [baseCurrency, setBaseCurrency] = useState(trip.base_currency);
  const [timezone, setTimezone] = useState(trip.timezone || '');
  const [defaultCurrency, setDefaultCurrency] = useState(trip.default_currency || trip.base_currency);
  const [defaultCategory, setDefaultCategory] = useState(trip.default_category || trip.categories[0] || '');
  const [defaultPayer, setDefaultPayer] = useState<string[]>(trip.default_payer || []);
  const [defaultSplitMembers, setDefaultSplitMembers] = useState<string[]>(trip.default_split_members || []);

  const [newMember, setNewMember] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newCurrency, setNewCurrency] = useState('');

  // 只在「關閉 → 開啟」的瞬間灌入表單初始值。trips 現在有 realtime 訂閱，
  // 若隨著 trip 物件變動就重設，別人存檔時會把使用者正在編輯的內容清掉。
  const wasOpen = useRef(false);

  useEffect(() => {
    const justOpened = isOpen && !wasOpen.current;
    wasOpen.current = isOpen;

    if (justOpened) {
      setName(trip.name);
      setAccessCode(trip.access_code || '');
      setIsArchived(trip.is_archived);
      setMembers([...trip.members]);
      setCategories([...trip.categories]);
      setTripCategory(trip.category || '');
      setAiPreference(trip.ai_preference || '');
      setBaseCurrency(trip.base_currency);
      setTimezone(trip.timezone || '');
      setDefaultCurrency(trip.default_currency || trip.base_currency);
      setDefaultCategory(trip.default_category || trip.categories[0] || '');
      setDefaultPayer(trip.default_payer || []);
      setDefaultSplitMembers(trip.default_split_members || []);
      setMemberOrigins([...trip.members]);

      const rStr: Record<string, string> = {};
      Object.keys(trip.rates).forEach(k => rStr[k] = trip.rates[k].toString());
      setRatesStr(rStr);

      const pStr: Record<string, string> = {};
      Object.keys(trip.precision_config).forEach(k => pStr[k] = trip.precision_config[k].toString());
      setPrecisionStr(pStr);

      // Fetch LineBot ID
      const fetchLineBotId = async () => {
        if (!supabase) return;
        const { data, error: fetchErr } = await supabase
          .from('line_trip_id_mapping')
          .select('linebot_id')
          .eq('trip_id', trip.id)
          .single();

        if (!fetchErr && data) {
          setLineBotId(data.linebot_id);
        }
      };
      fetchLineBotId();

      // Fetch existing distinct categories for datalist suggestions.
      const fetchKnownCategories = async () => {
        if (!supabase) return;
        const { data, error: fetchErr } = await supabase
          .from('trips')
          .select('category')
          .not('category', 'is', null);
        if (!fetchErr && data) {
          const set = new Set<string>();
          data.forEach((row: { category: string | null }) => {
            const c = (row.category || '').trim();
            if (c) set.add(c);
          });
          setKnownTripCategories(Array.from(set).sort());
        }
      };
      fetchKnownCategories();
    }
  }, [isOpen, trip]);

  const handleCopy = () => {
    if (lineBotId) {
      const fullId = `ID:${lineBotId}`;
      // Primary method: modern clipboard API
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(fullId).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => {
          // Fallback if it fails
          fallbackCopy(fullId);
        });
      } else {
        // Fallback for non-secure contexts or older browsers
        fallbackCopy(fullId);
      }
    }
  };

  const fallbackCopy = (text: string) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
  };

  const handleMemberRename = (index: number, newName: string) => {
    const prevName = members[index];
    const updatedMembers = [...members];
    updatedMembers[index] = newName;
    setMembers(updatedMembers);
    // 預設付款人／分攤存的也是名字，要跟著改，否則存檔後預設值會默默消失
    const follow = (list: string[]) => list.map(x => (x === prevName ? newName : x));
    setDefaultPayer(follow);
    setDefaultSplitMembers(follow);
  };

  const handleSave = async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);

    const finalRates: Record<string, number> = {};
    const finalPrecision: Record<string, number> = {};

    try {
      const finalName = name.trim();
      if (!finalName) throw new Error('旅程名稱不能是空白');

      Object.keys(ratesStr).forEach(k => {
        const val = parseFloat(ratesStr[k]);
        if (isNaN(val) || val <= 0) throw new Error(`${k} 的匯率必須為大於 0 的數字`);
        finalRates[k] = val;
      });

      Object.keys(precisionStr).forEach(k => {
        const val = parseInt(precisionStr[k]);
        if (isNaN(val) || val < 0) throw new Error(`${k} 的精度必須為大於或等於 0 的整數`);
        finalPrecision[k] = val;
      });

      // 成員名稱是支出 JSONB 的 key：空白或重複的名字會讓兩個人的帳混在一起
      const finalMembers = members.map(m => m.trim());
      if (finalMembers.some(m => !m)) throw new Error('成員名稱不能是空白');
      if (new Set(finalMembers).size !== finalMembers.length) throw new Error('成員名稱不能重複');

      const renamePairs: [string, string][] = [];
      memberOrigins.forEach((origin, i) => {
        if (origin && origin !== finalMembers[i]) renamePairs.push([origin, finalMembers[i]]);
      });
      const onlyMembers = (list: string[]) => list.map(m => m.trim()).filter(m => finalMembers.includes(m));

      // 預設幣別／分類必須還存在，否則新增的支出會記在沒有匯率的幣別上（統計以 1:1 換算）
      const finalDefaultCurrency = defaultCurrency === baseCurrency || finalRates[defaultCurrency] !== undefined
        ? defaultCurrency
        : baseCurrency;
      const finalDefaultCategory = categories.includes(defaultCategory) ? defaultCategory : (categories[0] ?? null);

      // 改名要把成員清單與所有支出 JSONB 的 key 一起改，必須在同一個 transaction 裡完成：
      // 以前是前端先存 trips 再一筆一筆改支出，中途斷線就會留下一半舊名字的支出，
      // 那些錢從結算裡消失（calculateMemberBalances 只算成員清單裡的人）。
      if (renamePairs.length > 0) {
        const { error: renameErr } = await supabase.rpc('rename_trip_members', {
          p_trip_id: trip.id,
          p_members: finalMembers,
          p_renames: Object.fromEntries(renamePairs),
        });
        if (renameErr) throw renameErr;

        // 改名已經落地。下面的設定若存失敗、使用者再按一次儲存時，
        // 不能再套一次同樣的改名（A、B 互換名字時會被換回去）
        setMemberOrigins(finalMembers);

        const savedMe = localStorage.getItem(`me_${trip.id}`);
        const renamedMe = savedMe ? renamePairs.find(([oldN]) => oldN === savedMe)?.[1] : undefined;
        if (renamedMe) localStorage.setItem(`me_${trip.id}`, renamedMe);
      }

      const { error: updateError } = await supabase
        .from('trips')
        .update({
          name: finalName,
          // 留空即代表移除密碼；統一存成 NULL，避免出現兩種「無密碼」表示法
          access_code: accessCode.trim() || null,
          is_archived: isArchived,
          members: finalMembers,
          categories,
          category: tripCategory.trim() || null,
          // 留空即代表沒有偏好；與 access_code 同樣的正規化慣例，統一存成 NULL
          ai_preference: aiPreference.trim() || null,
          rates: finalRates,
          precision_config: finalPrecision,
          base_currency: baseCurrency,
          // 留空 = 自動（依幣別推測）；與 access_code 同樣的正規化慣例，統一存成 NULL
          timezone: timezone.trim() || null,
          default_currency: finalDefaultCurrency,
          default_category: finalDefaultCategory,
          default_payer: onlyMembers(defaultPayer),
          default_split_members: onlyMembers(defaultSplitMembers)
        })
        .eq('id', trip.id);

      if (updateError) throw updateError;

      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const addMember = () => {
    const name = newMember.trim();
    if (name && !members.includes(name)) {
      setMembers([...members, name]);
      setMemberOrigins([...memberOrigins, null]);
      setNewMember('');
    }
  };

  // 移除仍出現在支出裡的成員，他的付款與分攤會從結算中消失（calculateMemberBalances 只算成員），
  // 其他人的帳就對不起來了。與 removeCurrency 一樣，先確認沒有紀錄用到他（含垃圾桶內、可能被還原的）。
  const removeMember = async (index: number) => {
    setError(null);
    if (members.length <= 1) {
      setError('至少需要一位成員');
      return;
    }
    // 還沒存檔的新成員不可能出現在任何支出裡；已存在的成員要用資料庫裡的原名查
    const origin = memberOrigins[index];
    if (origin) {
      if (!supabase) return;
      const { data, error: fetchErr } = await supabase
        .from('expenses')
        .select('payer_data, split_data')
        .eq('trip_id', trip.id);
      if (fetchErr) {
        setError('檢查成員使用狀況失敗：' + fetchErr.message);
        return;
      }
      const used = (data || []).filter((e: { payer_data: Record<string, number> | null; split_data: Record<string, number> | null }) =>
        (e.payer_data?.[origin] ?? 0) !== 0 || (e.split_data?.[origin] ?? 0) !== 0
      ).length;
      if (used > 0) {
        setError(`已有 ${used} 筆紀錄用到 ${origin}，請先改掉這些紀錄的付款／分攤才能移除（改名不受影響）`);
        return;
      }
    }
    setMembers(members.filter((_, i) => i !== index));
    setMemberOrigins(memberOrigins.filter((_, i) => i !== index));
  };

  // 換主幣別時匯率要跟著換算：rates 的意思是「1 幣別 = ? 主幣別」，
  // 主幣別一換而匯率不動的話，所有統計與結算都會算錯。
  // 舊主幣別對自己的匯率依定義是 1（與 getRate 一致），不看 ratesStr 裡寫了什麼。
  const changeBaseCurrency = (next: string) => {
    setError(null);
    if (next === baseCurrency) return;
    const effective = (code: string) => (code === baseCurrency ? 1 : parseFloat(ratesStr[code]));
    const pivot = effective(next);
    if (!isFinite(pivot) || pivot <= 0) {
      setBaseCurrency(next);
      setError(`${next} 的匯率不是有效數字，無法自動換算，請手動重新填寫所有匯率`);
      return;
    }
    const rebased: Record<string, string> = {};
    Object.keys(ratesStr).forEach(code => {
      const r = effective(code);
      rebased[code] = code === next
        ? '1'
        : isFinite(r) && r > 0
          ? new Decimal(r).dividedBy(pivot).toSignificantDigits(6).toString()
          : ratesStr[code];
    });
    setRatesStr(rebased);
    setBaseCurrency(next);
  };

  const addCategory = () => {
    const cat = newCategory.trim();
    if (cat && !categories.includes(cat)) {
      setCategories([...categories, cat]);
      setNewCategory('');
    }
  };

  const addCurrency = () => {
    setError(null);
    const code = newCurrency.toUpperCase().trim();
    if (!code) return;
    // LINE Bot 的 AI 與收據辨識輸出的都是 ISO 4217 代碼（JPY），
    // 設成「日幣」「JP Y」的幣別幾乎對不上，記帳時會被退回預設幣別
    if (!/^[A-Z]{3}$/.test(code)) {
      setError('幣別請輸入 3 碼英文代碼，例如 JPY、USD、KRW');
      return;
    }
    if (!ratesStr[code]) {
      setRatesStr({ ...ratesStr, [code]: '1' });
      setPrecisionStr({ ...precisionStr, [code]: code === 'TWD' ? '0' : '2' });
      setNewCurrency('');
    }
  };

  // 刪除仍有支出使用的幣別會讓匯率消失，統計與結清會把該幣別當成 1:1 換算（金額全錯），
  // 因此刪除前先確認沒有任何紀錄使用它（含垃圾桶內、可能被還原的紀錄）。
  const removeCurrency = async (code: string) => {
    setError(null);
    if (code === baseCurrency) {
      setError('不能刪除主幣別');
      return;
    }
    if (!supabase) return;

    const { count, error: countErr } = await supabase
      .from('expenses')
      .select('id', { count: 'exact', head: true })
      .eq('trip_id', trip.id)
      .eq('currency', code);

    if (countErr) {
      setError('檢查幣別使用狀況失敗：' + countErr.message);
      return;
    }
    if (count && count > 0) {
      setError(`已有 ${count} 筆紀錄使用 ${code}，請先改掉這些紀錄的幣別才能刪除`);
      return;
    }

    setRatesStr(Object.fromEntries(Object.entries(ratesStr).filter(([k]) => k !== code)));
    setPrecisionStr(Object.fromEntries(Object.entries(precisionStr).filter(([k]) => k !== code)));
    // 下拉選單會看起來跳到第一個選項，但 state 還是舊值 —— 不改掉的話會把刪掉的幣別存成預設
    if (defaultCurrency === code) setDefaultCurrency(baseCurrency);
  };

  const removeCategory = (cat: string) => {
    const next = categories.filter(c => c !== cat);
    setCategories(next);
    if (defaultCategory === cat) setDefaultCategory(next[0] ?? '');
  };

  const tabs: { key: TabType; label: string }[] = [
    { key: 'basic', label: '基本' },
    { key: 'members', label: '成員' },
    { key: 'finance', label: '幣別匯率' },
    { key: 'categories', label: '分類' },
  ];

  const chipToggle = (on: boolean) => `${ui.chip} text-sm px-3.5 ${on ? ui.chipOn : ui.chipOff}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="旅程設定" maxWidth="sm:max-w-2xl">
      <div className="-mt-5 -mx-5">
        <div className="sticky -top-5 z-10 bg-surface px-5 pt-4 pb-3 border-b border-line">
          <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-sunk border border-line" role="tablist">
            {tabs.map(t => (
              <button
                key={t.key}
                role="tab"
                aria-selected={activeTab === t.key}
                onClick={() => setActiveTab(t.key)}
                className={`py-2 rounded-lg text-[13px] transition-colors ${activeTab === t.key ? 'bg-surface text-ink font-bold shadow-sm' : 'text-ink-2 hover:text-ink'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 pt-5 pb-2 min-h-[50dvh]">
          {activeTab === 'basic' && (
            <div className="space-y-5 anim-fade">
              <div>
                <label htmlFor="set-name" className={ui.label}>旅程名稱</label>
                <input id="set-name" type="text" className={ui.input} value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div>
                <label htmlFor="set-code" className={ui.label}>進入密碼 <span className="text-muted font-normal">· 選填</span></label>
                <div className="relative">
                  {accessCode.trim()
                    ? <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" size={15} />
                    : <Unlock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-pos" size={15} />}
                  <input id="set-code" type="text" maxLength={6} placeholder="留空即免密碼" className={`${ui.input} pl-10`} value={accessCode} onChange={e => setAccessCode(e.target.value)} />
                </div>
                <p className={`${ui.hint} mt-1.5`}>
                  {accessCode.trim()
                    ? '儲存後，還沒驗證過的人進入這趟旅程時要輸入密碼。清空這一欄就能取消密碼。'
                    : '目前免密碼：任何拿到連結的人都能直接進入，綁定 LINE 機器人時也不用驗證。'}
                </p>
              </div>
              <div>
                <label htmlFor="set-tripcat" className={ui.label}>旅程分類 <span className="text-muted font-normal">· 選填</span></label>
                <input
                  id="set-tripcat"
                  type="text"
                  list="settings-trip-categories"
                  placeholder="例如：家族、朋友、出差"
                  className={ui.input}
                  value={tripCategory}
                  onChange={e => setTripCategory(e.target.value)}
                />
                <datalist id="settings-trip-categories">
                  {knownTripCategories.map(c => <option key={c} value={c} />)}
                </datalist>
                <p className={`${ui.hint} mt-1.5`}>同一個分類的旅程會在首頁排在一起。</p>
              </div>

              {/* 旅程時區：LINE Bot 判斷「今天」用的就是它（M4）。
                  幣別不等於所在地 —— 主幣 TWD 的日本旅程用台北時間，
                  日本時間 23:30 記帳會被記到前一天去。 */}
              <div>
                <label htmlFor="set-tz" className={ui.label}>旅程時區 <span className="text-muted font-normal">· 選填</span></label>
                <select id="set-tz" className={ui.select} value={timezone} onChange={e => setTimezone(e.target.value)}>
                  <option value="">自動（依幣別推測）</option>
                  {TIMEZONE_OPTIONS.map(tz => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
                <p className={`${ui.hint} mt-1.5`}>
                  LINE 機器人判斷「今天」用的時區。選自動時會從幣別推測，主幣別是台幣的日本旅程會被當成台北時間，深夜記帳容易差一天，建議直接指定。
                </p>
              </div>

              {/* AI 記帳偏好：LINE Bot 解析文字與收據時的參考，整趟旅程共用一份 */}
              <section className="rounded-2xl border border-line p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="w-9 h-9 rounded-xl bg-sunk text-ink-2 flex items-center justify-center shrink-0"><Bot size={18} /></span>
                  <div>
                    <p className="text-sm font-bold">AI 記帳偏好</p>
                    <p className="text-xs text-muted mt-0.5">耀西解析你說的話或收據時，會參考這段描述</p>
                  </div>
                </div>
                <textarea
                  rows={4}
                  aria-label="AI 記帳偏好"
                  placeholder={`例如：預設由${trip.members[0] || '我'}付款，大家均分；日幣一律不換算`}
                  className={`${ui.input} resize-none`}
                  value={aiPreference}
                  onChange={e => setAiPreference(e.target.value)}
                />
                <p className={ui.hint}>
                  整趟旅程共用一份，在 LINE 裡按「⚙️ 記帳偏好」看到的也是這一份，留空代表沒有偏好。
                  不要在這裡寫「我是○○」：群組裡每個人看到的都是同一句，耀西會用 LINE 顯示名稱判斷「我」是誰。
                </p>
              </section>

              {/* LineBot Binding Section */}
              <section className="rounded-2xl border border-line p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="w-9 h-9 rounded-xl bg-[#06c755]/12 text-[#06a147] flex items-center justify-center shrink-0"><MessageCircle size={18} /></span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold">用 LINE 記帳</p>
                    <p className="text-xs text-muted mt-0.5">加機器人好友後，傳送下面的 ID 就能綁定這趟旅程</p>
                  </div>
                  <a
                    href="https://line.me/R/ti/p/%40457ctfgb"
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#06c755] text-white text-xs font-bold hover:brightness-95"
                  >
                    <Plus size={14} />加好友
                  </a>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1 px-4 py-3 rounded-xl bg-sunk border border-line num font-extrabold text-center text-xl tracking-[0.2em]">
                    ID:{lineBotId || '------'}
                  </div>
                  <button onClick={handleCopy} aria-label="複製綁定 ID" className={`${ui.btnSecondary} px-4`}>
                    {copied ? <Check size={18} className="text-pos" /> : <Copy size={18} />}
                  </button>
                </div>
              </section>

              <section className="rounded-2xl border border-line divide-y divide-line">
                <div className="flex items-center gap-3 p-4">
                  <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isArchived ? 'bg-warn/15 text-warn' : 'bg-sunk text-ink-2'}`}><Archive size={18} /></span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold">封存旅程</p>
                    <p className="text-xs text-muted mt-0.5">封存後只能查看，不能新增或修改</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={isArchived}
                    aria-label="封存旅程"
                    onClick={() => setIsArchived(!isArchived)}
                    className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${isArchived ? 'bg-warn' : 'bg-line'}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${isArchived ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                </div>
                <div className="flex items-center gap-3 p-4">
                  <span className="w-9 h-9 rounded-xl bg-sunk text-ink-2 flex items-center justify-center shrink-0"><Download size={18} /></span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold">匯出 CSV</p>
                    <p className="text-xs text-muted mt-0.5">下載所有支出紀錄，可以用試算表開啟</p>
                  </div>
                  <button onClick={() => exportExpensesToCSV(expenses, trip.name)} className={`${ui.btnSecondary} py-2 shrink-0`}>下載</button>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'members' && (
            <div className="space-y-5 anim-fade">
              <div className="flex gap-2">
                <input type="text" aria-label="新成員名稱" placeholder="新增成員" className={ui.input} value={newMember} onChange={e => setNewMember(e.target.value)} onKeyDown={e => isSubmitEnter(e) && addMember()} />
                <button onClick={addMember} aria-label="新增成員" className={`${ui.btnPrimary} px-4 shrink-0`}><Plus size={18} strokeWidth={2.6} /></button>
              </div>
              <ul className="rounded-2xl border border-line divide-y divide-line">
                {members.map((m, idx) => (
                  <li key={idx} className="flex items-center gap-3 pl-3 pr-1.5 py-1.5 group">
                    <span className="w-8 h-8 rounded-full bg-sunk text-ink-2 flex items-center justify-center text-sm font-bold shrink-0">{m.charAt(0)}</span>
                    <input
                      type="text"
                      aria-label={`成員 ${idx + 1} 的名稱`}
                      className="flex-1 min-w-0 bg-transparent text-base sm:text-sm py-2 outline-none rounded-lg focus:bg-sunk px-2 -mx-2"
                      value={m}
                      onChange={e => handleMemberRename(idx, e.target.value)}
                      placeholder="成員名稱"
                    />
                    {/* 觸控裝置沒有 hover：只有滑鼠操作時才「滑過才顯示」，否則手機、平板上按鈕永遠是透明的 */}
                    <button onClick={() => removeMember(idx)} aria-label={`移除 ${m}`} className={`${ui.iconBtn} hover:text-neg pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus:opacity-100`}><Trash2 size={16} /></button>
                  </li>
                ))}
              </ul>
              <p className={ui.hint}>直接點名字就能改名，所有支出紀錄裡的名字會一起更新。</p>

              <div className="pt-4 border-t border-line space-y-4">
                <p className="text-sm font-bold">記帳預設值</p>
                <div>
                  <p className={ui.label}>預設付款人</p>
                  <div className="flex flex-wrap gap-2">
                    {members.map(m => {
                      const checked = defaultPayer.includes(m);
                      return (
                        <button key={m} aria-pressed={checked} onClick={() => setDefaultPayer(prev => checked ? prev.filter(x => x !== m) : [...prev, m])} className={chipToggle(checked)}>
                          {m}
                        </button>
                      );
                    })}
                  </div>
                  <p className={`${ui.hint} mt-1.5`}>沒選的話，以「我是誰」選的人為準；還沒選身分就用第一位成員。</p>
                </div>
                <div>
                  <p className={ui.label}>預設分攤成員</p>
                  <div className="flex flex-wrap gap-2">
                    {members.map(m => {
                      const checked = defaultSplitMembers.includes(m);
                      return (
                        <button key={m} aria-pressed={checked} onClick={() => setDefaultSplitMembers(prev => checked ? prev.filter(x => x !== m) : [...prev, m])} className={chipToggle(checked)}>
                          {m}
                        </button>
                      );
                    })}
                  </div>
                  <p className={`${ui.hint} mt-1.5`}>沒選的話，預設全部成員一起分攤。</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'finance' && (
            <div className="space-y-5 anim-fade">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="set-base" className={ui.label}>主幣別</label>
                  <select id="set-base" className={`${ui.select} num font-bold`} value={baseCurrency} onChange={e => changeBaseCurrency(e.target.value)}>{Object.keys(ratesStr).map(c => <option key={c} value={c}>{c}</option>)}</select>
                </div>
                <div>
                  <label htmlFor="set-defcur" className={ui.label}>預設記帳幣別</label>
                  <select id="set-defcur" className={`${ui.select} num font-bold`} value={defaultCurrency} onChange={e => setDefaultCurrency(e.target.value)}>{Object.keys(ratesStr).map(c => <option key={c} value={c}>{c}</option>)}</select>
                </div>
              </div>
              {baseCurrency !== trip.base_currency && (
                <div className={ui.warnBox}>
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <p>主幣別從 {trip.base_currency} 改成 {baseCurrency}，下面的匯率已經自動換算成「1 單位 = ? {baseCurrency}」，儲存前請確認。</p>
                </div>
              )}
              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <p className="text-sm font-bold">幣別與匯率</p>
                  <span className="text-xs text-muted">1 單位 = ? {baseCurrency}</span>
                </div>
                <div className="grid grid-cols-[64px_minmax(0,1fr)_76px_36px] gap-2 px-1 pb-1 text-[11px] text-muted">
                  <span>幣別</span><span>匯率</span><span>小數位數</span><span />
                </div>
                <ul className="space-y-2">
                  {Object.keys(ratesStr).map(code => (
                    <li key={code} className="grid grid-cols-[64px_minmax(0,1fr)_76px_36px] gap-2 items-center">
                      <span className="num font-bold pl-1">{code}</span>
                      <input type="text" inputMode="decimal" aria-label={`${code} 匯率`} className={`${ui.input} num py-2`} value={ratesStr[code] ?? ''} onChange={e => setRatesStr({ ...ratesStr, [code]: e.target.value })} />
                      <input type="text" inputMode="numeric" aria-label={`${code} 小數位數`} className={`${ui.input} num py-2`} value={precisionStr[code] ?? ''} onChange={e => setPrecisionStr({ ...precisionStr, [code]: e.target.value })} />
                      {code !== baseCurrency
                        ? <button onClick={() => removeCurrency(code)} aria-label={`移除 ${code}`} className={`${ui.iconBtn} hover:text-neg`}><X size={16} /></button>
                        : <span className="text-[11px] text-muted text-center">主</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-2">
                <input type="text" aria-label="新幣別代碼" placeholder="新增幣別，例如 KRW" className={`${ui.input} uppercase placeholder:normal-case`} value={newCurrency} onChange={e => setNewCurrency(e.target.value)} />
                <button onClick={addCurrency} className={`${ui.btnSecondary} shrink-0`}>新增</button>
              </div>
            </div>
          )}

          {activeTab === 'categories' && (
            <div className="space-y-5 anim-fade">
              <div>
                <label htmlFor="set-defcat" className={ui.label}>預設記帳分類</label>
                <select id="set-defcat" className={ui.select} value={defaultCategory} onChange={e => setDefaultCategory(e.target.value)}>{categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}</select>
              </div>
              <div className="flex gap-2">
                <input type="text" aria-label="新分類名稱" placeholder="新增分類" className={ui.input} value={newCategory} onChange={e => setNewCategory(e.target.value)} onKeyDown={e => isSubmitEnter(e) && addCategory()} />
                <button onClick={addCategory} aria-label="新增分類" className={`${ui.btnPrimary} px-4 shrink-0`}><Plus size={18} strokeWidth={2.6} /></button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {categories.map(cat => (
                  <li key={cat} className="flex items-center gap-1.5 pl-3.5 pr-1.5 py-1.5 rounded-full bg-surface border border-line text-sm">
                    {cat}
                    <button onClick={() => removeCategory(cat)} aria-label={`移除分類 ${cat}`} className="p-0.5 rounded-full text-muted hover:text-neg"><X size={14} /></button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="sticky -bottom-5 z-10 bg-surface border-t border-line px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] -mb-5 space-y-2">
          {error && <div className={ui.errorBox} role="alert"><AlertCircle size={16} className="shrink-0 mt-0.5" /><span>{error}</span></div>}
          <div className="flex gap-2.5">
            <button onClick={onClose} className={`${ui.btnSecondary} flex-1 sm:flex-none sm:px-6 py-3`}>取消</button>
            <button disabled={loading} onClick={handleSave} className={`${ui.btnPrimary} flex-1 py-3`}>
              {loading ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}儲存設定
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default SettingsModal;
