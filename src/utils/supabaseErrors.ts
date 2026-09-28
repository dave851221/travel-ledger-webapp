/**
 * 這個 Supabase 錯誤是不是代表「這筆資料根本不存在」。
 *
 * 只有伺服器明確回報查無資料（PGRST116：`.single()` 沒有任何列）
 * 或 id 不是合法 UUID（22P02）才算。
 * 網路斷線、逾時、5xx 都**不算** —— 手機解鎖或切回前景的那一刻網路常常還沒接上，
 * 以前一律當成旅程不存在，使用者會被莫名其妙踢回首頁。
 */
export const isNotFoundError = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'PGRST116' || code === '22P02';
};
