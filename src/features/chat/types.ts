/**
 * 網頁聊天（跟耀西對話記帳）的型別。
 *
 * 上半部是跟 Edge Function `web-chat` 的契約（supabase/functions/web-chat/payload.ts、handlers.ts），
 * 改一邊要同步另一邊；下半部是聊天室畫面上的每一則訊息，存在這台裝置的 localStorage。
 */
import type { ReceiptItem } from '../../utils/itemSplit';

// ── 與 web-chat 的契約 ───────────────────────────────

/** 草稿內容。短鍵沿用 LINE 的 pending 格式：d 描述、a 金額、c 幣別、dt 日期、cat 分類、p 付款、s 分攤 */
export interface DraftExpense {
  d: string;
  a: number;
  c: string;
  dt: string;
  cat: string;
  p: Record<string, number>;
  s: Record<string, number>;
}

export interface WebDraft {
  nonce: string;
  exp: DraftExpense;
  /** Storage 路徑（expenses/{tripId}/…） */
  photoIds: string[];
  /** 照片是收據（機器人讀出金額的才算）；照片記帳是商品照片 */
  receipt: boolean;
  items: ReceiptItem[];
  subtotal?: number;
}

export interface HistoryTurn {
  role: 'user' | 'model';
  content: string;
}

export type ReplyTarget =
  | { kind: 'draft'; nonce: string }
  | { kind: 'expense'; id: string; label?: string };

export interface UpdateChange { field: string; label: string; before: string; after: string }

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'draft'; draft: WebDraft; title: string; needsAmount?: boolean; unidentified?: boolean; replaces?: string }
  | { type: 'currency'; draft: WebDraft; text: string; currencies: string[] }
  | {
    type: 'update';
    expenseId: string;
    existing: { description: string; date: string; amount: string; currency: string };
    changes: UpdateChange[];
    exp: DraftExpense;
  }
  | { type: 'delete'; expenseId: string; existing: { description: string; date: string; amount: string; currency: string; category: string } }
  | { type: 'pick_existing'; text: string };

export interface ChatReply {
  blocks: ChatBlock[];
  history: HistoryTurn[];
}

export interface ActionReply {
  ok: boolean;
  text: string;
  expenseId?: string;
}

// ── 畫面上的訊息 ───────────────────────────────

export type DraftStatus = 'pending' | 'saved' | 'undone' | 'cancelled' | 'replaced';
export type ConfirmStatus = 'pending' | 'done' | 'cancelled';

interface Base {
  id: string;
  /** epoch ms */
  at: number;
}

export type ChatItem =
  | (Base & { role: 'user'; kind: 'text'; text: string; replyLabel?: string })
  /** path 是空的＝還在上傳；localUrl 只在這次開著的頁面有效（重新整理就沒了） */
  | (Base & { role: 'user'; kind: 'photo'; path: string; localUrl?: string; status?: 'uploading' | 'reading' | 'failed' })
  | (Base & { role: 'bot'; kind: 'text'; text: string })
  | (Base & {
    role: 'bot';
    kind: 'draft';
    draft: WebDraft;
    title: string;
    needsAmount?: boolean;
    unidentified?: boolean;
    /** 這趟旅程沒有收據上的幣別：先選一個幣別才能存（金額不換算） */
    currencies?: string[];
    status: DraftStatus;
    expenseId?: string;
    /** 存入後的完整明細（與 LINE 的「✅ 已存入」同一份格式） */
    resultText?: string;
  })
  | (Base & {
    role: 'bot';
    kind: 'update';
    expenseId: string;
    existing: { description: string; date: string; amount: string; currency: string };
    changes: UpdateChange[];
    exp: DraftExpense;
    status: ConfirmStatus;
    resultText?: string;
  })
  | (Base & {
    role: 'bot';
    kind: 'delete';
    expenseId: string;
    existing: { description: string; date: string; amount: string; currency: string; category: string };
    status: ConfirmStatus;
    resultText?: string;
  })
  | (Base & { role: 'bot'; kind: 'pick'; text: string; mode: 'edit' | 'delete' })
  | (Base & { role: 'bot'; kind: 'summary'; title: string; subtitle?: string; sections: SummarySection[]; totals: string[]; notes?: string[] });

export interface SummarySection {
  heading?: string;
  rows: { label: string; value: string; sub?: string }[];
}

export type DraftItem = Extract<ChatItem, { kind: 'draft' }>;
