/**
 * 聊天室的狀態：存在這台裝置的 localStorage（`chat_{tripId}`），不寫資料庫。
 *
 * 免費方案的 Disk IO 很緊（見 CLAUDE.md 的「不要做保溫」），LINE 那邊每則訊息都要寫好幾列
 * 對話紀錄與草稿；網頁的對話只有這個人自己看，存在裝置上就夠了。
 * 代價：換一台裝置看不到之前的對話，卡片也只在這台上按得到（存進去的支出當然大家都看得到）。
 *
 * 純函式為主（chatStore.test.ts），讀寫 localStorage 的那兩支包 try/catch（無痕模式會丟例外）。
 */
import type { ChatBlock, ChatItem, DraftItem, HistoryTurn, WebDraft } from './types';

const KEY = (tripId: string) => `chat_${tripId}`;
const VERSION = 1;
/** 畫面上留多少則（太多 localStorage 會滿；照片只存路徑，不佔空間） */
export const MAX_ITEMS = 150;
/** 對話紀錄留多少輪（每次送最近 8 輪給模型，web-chat 的 CHAT_HISTORY_TURNS） */
export const MAX_HISTORY = 16;
export const SEND_HISTORY = 8;

export interface ChatState {
  items: ChatItem[];
  history: HistoryTurn[];
}

export const emptyChat = (): ChatState => ({ items: [], history: [] });

export function loadChat(tripId: string): ChatState {
  try {
    const raw = localStorage.getItem(KEY(tripId));
    if (!raw) return emptyChat();
    const parsed = JSON.parse(raw);
    if (parsed?.v !== VERSION || !Array.isArray(parsed.items)) return emptyChat();
    return { items: parsed.items, history: Array.isArray(parsed.history) ? parsed.history : [] };
  } catch {
    return emptyChat();
  }
}

export function saveChat(tripId: string, state: ChatState): void {
  try {
    localStorage.setItem(KEY(tripId), JSON.stringify({
      v: VERSION,
      items: state.items.slice(-MAX_ITEMS),
      history: state.history.slice(-MAX_HISTORY),
    }));
  } catch { /* 空間不足或無痕模式：這次不存，畫面照常 */ }
}

export const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 還等著確認的草稿（送給模型當 context，最新的在前） */
export function pendingDrafts(items: ChatItem[]): WebDraft[] {
  return items
    .filter((i): i is DraftItem => i.kind === 'draft' && i.status === 'pending')
    .map(i => i.draft)
    .reverse()
    .slice(0, 10);
}

/** 把 web-chat 回來的區塊變成畫面上的訊息；被修正的那張草稿標成「已更新」 */
export function applyBlocks(items: ChatItem[], blocks: ChatBlock[], now: number = Date.now()): ChatItem[] {
  const replaced = new Set(blocks.flatMap(b => (b.type === 'draft' && b.replaces ? [b.replaces] : [])));
  const updated = replaced.size === 0 ? items : items.map(i =>
    i.kind === 'draft' && i.status === 'pending' && replaced.has(i.draft.nonce) ? { ...i, status: 'replaced' as const } : i);
  const added: ChatItem[] = blocks.map((b, idx): ChatItem => {
    const base = { id: newId(), at: now + idx, role: 'bot' as const };
    switch (b.type) {
      case 'text': return { ...base, kind: 'text', text: b.text };
      case 'draft': return { ...base, kind: 'draft', draft: b.draft, title: b.title, needsAmount: b.needsAmount, unidentified: b.unidentified, status: 'pending' };
      case 'currency': return { ...base, kind: 'draft', draft: b.draft, title: '🔍 AI 辨識結果', currencies: b.currencies, status: 'pending' };
      case 'update': return { ...base, kind: 'update', expenseId: b.expenseId, existing: b.existing, changes: b.changes, exp: b.exp, status: 'pending' };
      case 'delete': return { ...base, kind: 'delete', expenseId: b.expenseId, existing: b.existing, status: 'pending' };
      case 'pick_existing': return { ...base, kind: 'pick', text: b.text, mode: 'edit' };
    }
  });
  // currency 區塊前面那句說明也要看得到
  const withCurrencyNotes = blocks.flatMap((b, idx) => (b.type === 'currency'
    ? [{ id: newId(), at: now + idx - 0.5, role: 'bot' as const, kind: 'text' as const, text: b.text }]
    : []));
  return [...updated, ...[...withCurrencyNotes, ...added].sort((a, b) => a.at - b.at)];
}

/** 改一則訊息（依 id），其他不動 */
export function patchItem<T extends ChatItem>(items: ChatItem[], id: string, patch: Partial<T>): ChatItem[] {
  return items.map(i => (i.id === id ? { ...i, ...patch } as ChatItem : i));
}

/** 最近一筆在聊天室裡存進去、還沒撤銷的（「取消上一筆」用） */
export function lastSavedDraft(items: ChatItem[]): DraftItem | null {
  for (let k = items.length - 1; k >= 0; k--) {
    const i = items[k];
    if (i.kind === 'draft' && i.status === 'saved' && i.expenseId) return i;
  }
  return null;
}

/** 最新一張還沒處理的草稿（「取消」用） */
export function latestPendingDraft(items: ChatItem[]): DraftItem | null {
  for (let k = items.length - 1; k >= 0; k--) {
    const i = items[k];
    if (i.kind === 'draft' && i.status === 'pending') return i;
  }
  return null;
}
