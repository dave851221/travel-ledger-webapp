// ============================================================
// web-chat/payload.ts —— 網頁送來的資料：型別與驗證（純函式，vitest 測得到）
//
// 網頁聊天的對話紀錄與草稿**存在使用者的瀏覽器裡**（不寫資料庫，免費方案的 Disk IO 很緊），
// 每則訊息把最近幾輪與還沒處理的草稿一起帶上來。所以這裡收到的全是「使用者自己給的」：
// 形狀、長度、照片路徑都要先收斂，照片路徑一定要在這趟旅程的資料夾底下。
//
// 型別與前端 src/features/chat/types.ts 是同一份契約，改一邊要同步另一邊。
// ============================================================

import { reconcileReceiptItems, type ReceiptItem, sanitizeReceiptItems } from "../_shared/itemSplit.ts"
import type { DraftExpense, OutstandingDraft } from "../_shared/assistant/types.ts"
import type { HistoryTurn } from "../_shared/assistant/chat.ts"
import type { AmountMap } from "../_shared/types.ts"

/** 網頁上一張還沒存的記帳卡（就是 OutstandingDraft，少了 tripId —— 一律是這次請求的旅程） */
export interface WebDraft {
  nonce: string
  exp: DraftExpense
  /** Storage 路徑（expenses/{tripId}/…） */
  photoIds: string[]
  receipt: boolean
  items: ReceiptItem[]
  subtotal?: number
}

/** 使用者點了某張卡的「回覆」 */
export type ReplyTarget =
  | { kind: 'draft'; nonce: string }
  | { kind: 'expense'; id: string; label?: string }

export interface ChatRequest {
  tripId: string
  action: 'message' | 'photo' | 'save' | 'update' | 'delete' | 'undo' | 'discard'
  /** 網頁上選的「我是誰」（沒選就是空的） */
  memberName?: string
  text?: string
  photoPath?: string
  history?: unknown
  drafts?: unknown
  replyTo?: unknown
  draft?: unknown
  expenseId?: string
  exp?: unknown
  photoIds?: unknown
  /** save：前端為這張卡配好的支出 id（重送不會多存一筆） */
  saveId?: string
}

export const MAX_TEXT_LENGTH = 2000
const MAX_HISTORY_CONTENT = 3000
const MAX_DRAFTS = 10
const MAX_NAME_LENGTH = 40

/** 這趟旅程的照片才收（不能拿別趟旅程或 bucket 裡其他地方的檔案來 OCR、刪除） */
export function isTripPhotoPath(path: unknown, tripId: string): path is string {
  return typeof path === 'string'
    && path.startsWith(`expenses/${tripId}/`)
    && !path.includes('..')
    && path.length < 300
}

export function cleanMemberName(name: unknown): string {
  const s = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : ''
  return s || '未知'
}

export function cleanText(text: unknown): string {
  return typeof text === 'string' ? text.trim().slice(0, MAX_TEXT_LENGTH) : ''
}

/** 最近 limit 輪（舊到新）。角色只認 user／model */
export function cleanHistory(raw: unknown, limit: number): HistoryTurn[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((h): h is { role: string; content: string } =>
      !!h && typeof h === 'object'
      && (h.role === 'user' || h.role === 'model')
      && typeof h.content === 'string' && h.content.trim() !== '')
    .slice(-limit)
    .map((h) => ({ role: h.role as 'user' | 'model', content: h.content.slice(0, MAX_HISTORY_CONTENT) }))
}

function cleanAmountMap(raw: unknown): AmountMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: AmountMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 50)) {
    const n = Number(v)
    if (k && Number.isFinite(n)) out[k.slice(0, MAX_NAME_LENGTH)] = n
  }
  return out
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined
}

export function cleanDraftExpense(raw: unknown): DraftExpense {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const amount = Number(e.a)
  return {
    d: str(e.d) ?? '',
    a: Number.isFinite(amount) ? amount : 0,
    c: str(e.c, 8) ?? '',
    dt: str(e.dt, 10) ?? '',
    cat: str(e.cat, 40) ?? '',
    p: cleanAmountMap(e.p) ?? {},
    s: cleanAmountMap(e.s) ?? {},
  }
}

export function cleanDraft(raw: unknown, tripId: string): WebDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const nonce = str(d.nonce, 40)
  if (!nonce) return null
  const exp = cleanDraftExpense(d.exp)
  const subtotal = Number(d.subtotal) > 0 ? Number(d.subtotal) : undefined
  return {
    nonce,
    exp,
    photoIds: (Array.isArray(d.photoIds) ? d.photoIds : []).filter((p) => isTripPhotoPath(p, tripId)).slice(0, 10),
    receipt: d.receipt === true,
    items: reconcileReceiptItems(sanitizeReceiptItems(d.items), Number(exp.a) || 0, subtotal),
    subtotal,
  }
}

export function cleanDrafts(raw: unknown, tripId: string): WebDraft[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_DRAFTS).map((d) => cleanDraft(d, tripId)).filter((d): d is WebDraft => d !== null)
}

export function toOutstanding(draft: WebDraft, tripId: string): OutstandingDraft {
  return { ...draft, tripId }
}

export function cleanReplyTarget(raw: unknown): ReplyTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'draft' && typeof r.nonce === 'string' && r.nonce) return { kind: 'draft', nonce: r.nonce.slice(0, 40) }
  if (r.kind === 'expense' && typeof r.id === 'string' && /^[0-9a-f-]{8,36}$/i.test(r.id)) {
    return { kind: 'expense', id: r.id, label: str(r.label, 120) }
  }
  return null
}
