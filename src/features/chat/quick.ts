/**
 * 聊天室的快捷查詢（純函式，quick.test.ts）。
 *
 * LINE 上「今日支出」「結算」這些指令要去查資料庫；網頁上帳目本來就在畫面裡，
 * 直接用手上的資料算，按了馬上出來，不必等 AI、也不花一次請求。
 * 金額加總走 decimal.js（sumByCurrency），結清走 calculateSettlements，與帳目、結清分頁同一套。
 */
import type { Expense, Trip } from '../../types';
import Decimal from 'decimal.js';
import { convertToBase, formatAmount, getCurrencyPrecision, sumByCurrency } from '../../utils/finance';
import { calculateSettlements } from '../../utils/settlement';
import { formatMoney } from '../../utils/money';
import type { SummarySection } from './types';

export type QuickCommand = 'today' | 'week' | 'month' | 'settle' | 'overview';

export const QUICK_COMMANDS: { key: QuickCommand; label: string; keywords: string[] }[] = [
  { key: 'today', label: '📅 今日支出', keywords: ['今日支出', '今天支出'] },
  { key: 'week', label: '📊 近 7 天', keywords: ['本週支出', '近期支出', '近7天', '近 7 天'] },
  { key: 'month', label: '🗓 本月支出', keywords: ['本月支出'] },
  { key: 'settle', label: '💰 結算', keywords: ['結算'] },
  { key: 'overview', label: '🗺️ 旅程總覽', keywords: ['旅程總覽'] },
];

/** 與 LINE 相同的精確關鍵字（整句完全相符才算，避免「結算好了嗎」被吃掉） */
export function matchQuickCommand(text: string): QuickCommand | null {
  const t = text.trim();
  return QUICK_COMMANDS.find(c => c.keywords.includes(t))?.key ?? null;
}

export const HELP_KEYWORDS = ['使用說明', '說明', '教學', '怎麼用', '怎麼使用', '如何使用', 'help', 'HELP', 'Help', '功能'];
export const UNDO_KEYWORDS = ['取消上一筆', '撤銷上一筆', '刪除上一筆', '刪掉上一筆', '移除上一筆'];
export const EDIT_LIST_KEYWORDS = ['編輯支出', '編輯紀錄', '編輯記錄', '修改支出', '修改紀錄'];
export const DELETE_LIST_KEYWORDS = ['刪除支出', '刪除紀錄', '刪除記錄', '管理支出', '刪除哪一筆'];
export const CANCEL_DRAFT_KEYWORDS = ['取消', '不要記', '不用記', '算了', '取消這筆', '取消剛剛那筆'];

/**
 * 幣別 → 時區的猜法，與 Edge Function 的 `_shared/assistant/time.ts` 同一份表：
 * 旅程沒設時區時兩邊都這樣猜，「今日支出」才會跟機器人記的日期是同一天。
 */
const CURRENCY_TIMEZONE: Record<string, string> = {
  TWD: 'Asia/Taipei', JPY: 'Asia/Tokyo', KRW: 'Asia/Seoul',
  HKD: 'Asia/Hong_Kong', SGD: 'Asia/Singapore', MYR: 'Asia/Kuala_Lumpur',
  THB: 'Asia/Bangkok', VND: 'Asia/Ho_Chi_Minh', IDR: 'Asia/Jakarta',
  PHP: 'Asia/Manila', CNY: 'Asia/Shanghai',
  AUD: 'Australia/Sydney', NZD: 'Pacific/Auckland',
  GBP: 'Europe/London', EUR: 'Europe/Paris', CHF: 'Europe/Zurich',
  USD: 'America/New_York', CAD: 'America/Toronto',
};

const validTimezone = (tz: string) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
};

/** 這趟旅程的時區：設定的 → 依主幣別、匯率表猜 → UTC（與後端 getTripTimezone 相同） */
export function tripTimezone(trip: Pick<Trip, 'timezone' | 'base_currency' | 'rates'>): string {
  const explicit = trip.timezone?.trim();
  if (explicit && validTimezone(explicit)) return explicit;
  for (const cur of [trip.base_currency, ...Object.keys(trip.rates ?? {})]) {
    if (cur && CURRENCY_TIMEZONE[cur]) return CURRENCY_TIMEZONE[cur];
  }
  return 'UTC';
}

/** 這趟旅程的「今天」 */
export function tripTodayString(trip: Pick<Trip, 'timezone' | 'base_currency' | 'rates'>, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tripTimezone(trip) }).format(now);
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export interface SummaryCard {
  title: string;
  subtitle?: string;
  sections: SummarySection[];
  totals: string[];
  notes?: string[];
}

const MAX_ROWS = 40;

function totalsOf(rows: Expense[], trip: Trip): string[] {
  const totals = sumByCurrency(rows);
  const parts = Object.entries(totals).map(([cur, d]) => formatMoney(d.toNumber(), cur, trip.precision_config));
  return parts.length > 0 ? [`${rows.length} 筆・合計 ${parts.join(' + ')}`] : [];
}

function listCard(title: string, subtitle: string, rows: Expense[], trip: Trip, groupByDate: boolean): SummaryCard {
  const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const listed = sorted.slice(0, MAX_ROWS);
  const sections: SummarySection[] = [];
  for (const e of listed) {
    const heading = groupByDate ? shortDate(e.date) : undefined;
    const last = sections[sections.length - 1];
    const row = { label: e.description || '（未命名）', value: formatMoney(e.amount, e.currency, trip.precision_config), sub: groupByDate ? undefined : e.category };
    if (last && last.heading === heading) last.rows.push(row);
    else sections.push({ heading, rows: [row] });
  }
  const omitted = sorted.length - listed.length;
  return {
    title, subtitle, sections, totals: totalsOf(rows, trip),
    notes: omitted > 0 ? [`另有 ${omitted} 筆較早的沒列出（合計已包含），完整清單請看帳目`] : [],
  };
}

/** 跑一個快捷查詢。回傳 string 代表直接回一句話（例如沒有資料） */
export function runQuickCommand(cmd: QuickCommand, trip: Trip, expenses: Expense[], balances: Record<string, number>, now: Date = new Date()): SummaryCard | string {
  const spending = expenses.filter(e => !e.is_settlement && !e.deleted_at);
  const today = tripTodayString(trip, now);

  if (cmd === 'today') {
    const rows = spending.filter(e => e.date === today);
    if (rows.length === 0) return `📅 今日（${today.slice(5)}）尚無支出記錄。`;
    return listCard('📅 今日支出', shortDate(today), rows, trip, false);
  }
  if (cmd === 'week') {
    const from = tripTodayString(trip, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    const rows = spending.filter(e => e.date >= from);
    if (rows.length === 0) return '📊 近 7 天內尚無支出記錄。';
    return listCard('📊 近 7 天支出', `${shortDate(from)} 起`, rows, trip, true);
  }
  if (cmd === 'month') {
    const monthStart = `${today.slice(0, 7)}-01`;
    const rows = spending.filter(e => e.date >= monthStart);
    if (rows.length === 0) return `📊 本月（${today.slice(0, 7)}）尚無支出記錄。`;
    return listCard('📊 本月支出', today.slice(0, 7), rows, trip, true);
  }
  if (cmd === 'settle') {
    const base = trip.base_currency;
    const settlements = calculateSettlements(balances, getCurrencyPrecision(base, trip.precision_config));
    if (settlements.length === 0) return '✅ 目前一切已結清，無需轉帳！';
    return {
      title: '💰 結算建議',
      subtitle: `最少轉帳次數，折合 ${base}`,
      sections: [{ rows: settlements.map(s => ({ label: `${s.from} → ${s.to}`, value: formatMoney(s.amount, base, trip.precision_config) })) }],
      totals: [],
      notes: ['實際轉完帳後，到「結清」分頁按一下就能記錄。'],
    };
  }
  // overview
  return {
    title: `🗺️ ${trip.name}`,
    subtitle: `${trip.is_archived ? '已封存 🔒' : '進行中 ✈️'}・今天 ${shortDate(today)}`,
    sections: [{
      rows: [
        { label: '👥 成員', sub: trip.members.join('、') || '（尚無成員）', value: `${trip.members.length} 人` },
        { label: '💵 主幣別', value: trip.base_currency },
        // 每個人總共花了多少（自己分攤的部分，折合主幣別）；誰該給誰在「結算」看（David 2026-11-27）
        ...trip.members.map(m => {
          const spent = spending.reduce((sum, e) => {
            const share = Number((e.split_data ?? {})[m]) || 0;
            return share ? sum.plus(convertToBase(share, e.currency, trip.rates, trip.base_currency)) : sum;
          }, new Decimal(0));
          return { label: m, value: formatMoney(spent.toNumber(), trip.base_currency, trip.precision_config), sub: '總共花費' };
        }),
      ],
    }],
    totals: totalsOf(spending, trip),
  };
}

/** 卡片上一行金額的純文字（給對話紀錄用，模型看得懂就好） */
export const plainAmount = (amount: number, currency: string, trip: Trip) =>
  `${formatAmount(amount, currency, trip.precision_config)} ${currency}`;
