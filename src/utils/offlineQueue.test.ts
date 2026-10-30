import { describe, it, expect } from 'vitest';
import type { Expense } from '../types';
import { isNetworkError, withPending, type QueuedExpense } from './offlineQueue';

const record = (tripId: string): QueuedExpense['record'] => ({
  trip_id: tripId,
  date: '2026-10-30',
  category: '餐飲',
  description: '拉麵',
  amount: 1000,
  currency: 'JPY',
  payer_data: { A: 1000 },
  split_data: { A: 500, B: 500 },
  adjustment_member: 'A',
  photo_urls: [],
  is_settlement: false,
});

const saved = (id: string): Expense => ({ ...record('t1'), id, created_at: '2026-10-30T00:00:00Z', deleted_at: null });

describe('withPending', () => {
  it('只併入這趟旅程的待上傳支出，標上 pending_sync 並排在最前面', () => {
    const queue: QueuedExpense[] = [
      { id: 'q1', queuedAt: '2026-10-30T01:00:00Z', record: record('t1') },
      { id: 'q2', queuedAt: '2026-10-30T01:00:00Z', record: record('t2') },
    ];
    const out = withPending([saved('s1')], queue, 't1');
    expect(out.map((e) => e.id)).toEqual(['q1', 's1']);
    expect(out[0].pending_sync).toBe(true);
    expect(out[0].deleted_at).toBeNull();
  });

  it('已經上傳到資料庫的不重複列出', () => {
    const queue: QueuedExpense[] = [{ id: 's1', queuedAt: '2026-10-30T01:00:00Z', record: record('t1') }];
    expect(withPending([saved('s1')], queue, 't1')).toHaveLength(1);
  });

  it('沒有待上傳的時候回傳原本的陣列（不觸發重算）', () => {
    const list = [saved('s1')];
    expect(withPending(list, [], 't1')).toBe(list);
  });
});

describe('isNetworkError', () => {
  it('認得各瀏覽器的連線失敗訊息', () => {
    expect(isNetworkError({ message: 'TypeError: Failed to fetch' })).toBe(true);
    expect(isNetworkError(new Error('Load failed'))).toBe(true);
    expect(isNetworkError({ message: 'NetworkError when attempting to fetch resource.' })).toBe(true);
  });

  it('資料被拒絕不算連線問題', () => {
    expect(isNetworkError({ message: 'new row violates check constraint', code: '23514' })).toBe(false);
  });
});
