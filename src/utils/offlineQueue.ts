import { supabase } from '../api/supabase';
import type { Expense } from '../types';

/**
 * 離線記帳：連不上資料庫時，新增的支出先存在這支手機上，恢復連線後再上傳。
 *
 * 每一筆在排隊時就配好 id，上傳用 upsert + ignoreDuplicates ——
 * 上傳到一半斷線、或兩個分頁同時上傳，同一筆都不會寫入兩次。
 * 只收「新增」：修改、刪除要對照資料庫現況，離線時直接請使用者等連線。
 * 照片也不收：檔案太大放不進 localStorage。
 *
 * localStorage 在隱私模式或空間不足時會丟例外，讀寫一律包 try/catch。
 */

const KEY = 'offline_expense_queue_v1';

/** 寫進 expenses 的欄位（不含 id、created_at、deleted_at） */
export type NewExpenseRecord = Omit<Expense, 'id' | 'created_at' | 'deleted_at' | 'pending_sync'>;

export interface QueuedExpense {
  id: string;
  queuedAt: string;
  record: NewExpenseRecord;
}

const listeners = new Set<() => void>();

export const readQueue = (): QueuedExpense[] => {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeQueue = (queue: QueuedExpense[]): boolean => {
  try {
    if (queue.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(queue));
    listeners.forEach((fn) => fn());
    return true;
  } catch {
    return false;
  }
};

export const subscribeQueue = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/** 排進佇列。存不進去（隱私模式、空間滿了）時回傳 null，呼叫端要告訴使用者沒記到。 */
export const enqueueExpense = (record: NewExpenseRecord): string | null => {
  const id = crypto.randomUUID();
  const ok = writeQueue([...readQueue(), { id, queuedAt: new Date().toISOString(), record }]);
  return ok ? id : null;
};

export const removeFromQueue = (ids: string[]): void => {
  if (ids.length === 0) return;
  writeQueue(readQueue().filter((q) => !ids.includes(q.id)));
};

/**
 * 這次失敗是不是「連不上」而不是資料有問題。
 * 只有連不上才排隊 —— 資料被拒絕（例如欄位錯了）排隊也只會一直失敗。
 */
export const isNetworkError = (err: unknown): boolean => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = err && typeof err === 'object' && 'message' in err
    ? String((err as { message: unknown }).message)
    : String(err);
  // Chrome「Failed to fetch」、Firefox「NetworkError」、Safari「Load failed」
  return /Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg);
};

/**
 * 把這趟旅程還沒上傳的支出併進帳目，讓畫面、餘額、統計都先算進去。
 * 已經在資料庫裡的（上傳完、還沒移出佇列的那一下）不重複列出。
 */
export const withPending = (expenses: Expense[], queue: QueuedExpense[], tripId: string): Expense[] => {
  const known = new Set(expenses.map((e) => e.id));
  const pending: Expense[] = queue
    .filter((q) => q.record.trip_id === tripId && !known.has(q.id))
    .map((q) => ({ ...q.record, id: q.id, created_at: q.queuedAt, deleted_at: null, pending_sync: true }));
  return pending.length > 0 ? [...pending, ...expenses] : expenses;
};

let flushing: Promise<string[]> | null = null;

/**
 * 依序上傳佇列。回傳成功上傳的 id，**還沒移出佇列** ——
 * 呼叫端重新抓完帳目再呼叫 removeFromQueue，畫面上那幾筆才不會閃一下消失又出現。
 * 遇到連不上就停，剩下的下次再試。
 */
export const uploadQueue = (): Promise<string[]> => {
  if (flushing) return flushing;
  flushing = (async () => {
    const uploaded: string[] = [];
    if (!supabase) return uploaded;
    for (const item of readQueue()) {
      const { error } = await supabase
        .from('expenses')
        .upsert([{ id: item.id, ...item.record }], { onConflict: 'id', ignoreDuplicates: true });
      if (!error) { uploaded.push(item.id); continue; }
      if (isNetworkError(error)) break;
      // 旅程已經被刪掉了：這筆永遠傳不上去，丟掉
      if (error.code === '23503') { uploaded.push(item.id); continue; }
      console.error('[OFFLINE] upload failed, will retry later:', error);
    }
    return uploaded;
  })().finally(() => { flushing = null; });
  return flushing;
};

/**
 * 新增一筆支出；連不上就排進佇列。
 * `queued: true` 代表這筆還在手機上，呼叫端的提示要講清楚「恢復連線後會上傳」。
 * 資料被拒絕（不是連線問題）照常丟出錯誤。
 */
export const insertExpenseOrQueue = async (record: NewExpenseRecord): Promise<{ id: string | null; queued: boolean }> => {
  const queue = () => {
    const id = enqueueExpense(record);
    if (!id) throw new Error('目前離線，而且這支手機無法暫存資料，這筆沒有記到');
    return { id, queued: true };
  };
  if (!supabase || (typeof navigator !== 'undefined' && navigator.onLine === false)) return queue();
  try {
    const { data, error } = await supabase.from('expenses').insert([record]).select('id').single();
    if (error) throw error;
    return { id: data?.id ?? null, queued: false };
  } catch (err) {
    if (isNetworkError(err)) return queue();
    throw err;
  }
};
