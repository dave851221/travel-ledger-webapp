/** 一個帳號的一種登入方式（資料庫 app.account_logins 組好的：名稱、遮過的 email，不含任何 ID） */
export interface LoginInfo { provider: 'line' | 'google'; name?: string | null; account?: string | null }

export const providerLabel = (p: LoginInfo['provider']): string => (p === 'line' ? 'LINE' : 'Google');
