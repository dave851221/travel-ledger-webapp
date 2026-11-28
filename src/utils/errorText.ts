/**
 * 錯誤 → 給人看的一句話。
 *
 * Supabase 回的錯誤（PostgrestError）是一般物件、不是 Error：以前寫 `err instanceof Error ? err.message : String(err)`，
 * 畫面上就變成「記帳失敗：[object Object]」（2026-11-28 深入 review：被移出旅程的人照舊畫面記帳時）。
 * 權限被擋（RLS／42501）換成看得懂的說法。
 */
export function errorText(err: unknown): string {
  const obj = typeof err === 'object' && err !== null ? err as { message?: unknown; code?: unknown } : null;
  const message = err instanceof Error ? err.message : typeof obj?.message === 'string' ? obj.message : String(err);
  if (obj?.code === '42501' || /row-level security|permission denied/i.test(message)) {
    return '沒有權限：你可能已經不是這趟旅程的成員，或這項只有管理員能改。請重新整理看看。';
  }
  return message;
}
