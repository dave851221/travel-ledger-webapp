/**
 * 開放版的用量上限（資料庫 app/05_quota.sql 擋下時的錯誤代碼）→ 給人看的話。
 * 上限只在資料庫判斷，前端只負責把代碼翻成中文。
 */
export function quotaMessage(err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  if (text.includes('entry_limit')) return '這趟旅程的記帳筆數已經滿了，刪掉不需要的帳就能空出位置。';
  // Storage API 不轉出資料庫的訊息，只說 'database error, code: P0001'；上傳政策裡只有照片上限會丟 P0001
  if (text.includes('photo_limit') || /database error, code: P0001/.test(text)) return '這趟旅程的照片張數已經滿了，這次的照片沒有上傳。';
  return null;
}

/** 上限錯誤換成好懂的 Error，其他照原樣丟出 */
export function rethrowQuota(err: unknown): never {
  const friendly = quotaMessage(err);
  throw friendly ? new Error(friendly) : err;
}
