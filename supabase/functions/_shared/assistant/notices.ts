// ============================================================
// _shared/assistant/notices.ts —— AI 失敗或改用備援時要跟使用者說的話
//
// LINE 與網頁聊天共用（原本在 line-webhook/config.ts，那裡原樣轉出）。
// ============================================================

export const RATE_LIMIT_MSG = '⚠️ AI 服務暫時達到免費使用量上限，請隔天再試。'
export const AI_BUSY_MSG = '⏳ AI 服務目前忙碌中，請過幾分鐘再試一次。'
export const AI_QUOTA_MSG = '⚠️ AI 本月的使用額度已經用完了，請管理員到 Anthropic Console 調整上限或儲值。'

/**
 * AI 失敗時（錯誤前綴的定義見 `_shared/ai/types.ts`）要回給使用者的話；
 * 其他錯誤回傳 null，由呼叫端用自己的訊息。
 */
export const aiUnavailableMessage = (e: unknown): string | null => {
  const message = String((e as { message?: unknown } | null)?.message)
  if (message.startsWith('RATE_LIMIT:')) return RATE_LIMIT_MSG
  if (message.startsWith('AI_QUOTA:')) return AI_QUOTA_MSG
  if (message.startsWith('AI_BUSY:')) return AI_BUSY_MSG
  return null
}

/**
 * 主要的 AI 失敗、這次改由備援（Gemini 免費版）回答時，放在回覆最前面的一句話。
 * 併在同一則回覆裡講（LINE 的 replyToken 只能用一次；網頁也照同一個做法）。
 */
export const FALLBACK_NOTICES = {
  quota: '⚠️ Claude 本月額度已用完，這次改用免費版 Gemini 回覆（可能比較慢、也比較不準）。',
  error: '⚠️ Claude 暫時連不上，這次改用免費版 Gemini 回覆。',
} as const

