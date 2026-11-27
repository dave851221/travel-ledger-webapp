// 開放版的 AI 次數（資料庫 app.consume_ai，見 supabase/app/schema/05_quota.sql）。
//
// 每次要叫 AI 之前先呼叫 consumeAi；ok=false 就「不要叫 AI」，把 quotaReply 的話回給使用者。
// 呼叫端自己先確認 actor 有權使用這趟（是成員、或在綁定這趟的群組裡），這裡只管次數。
// 被 AI 拒絕的回覆也已經扣過（真的花了錢）。上限只看「這趟」，不限每個人的次數。

import type { SupabaseClient } from './deps.ts'

export type AiKind = 'text' | 'receipt' | 'voice' | 'search'
export type QuotaReason = 'ai_disabled' | 'trip_limit' | 'no_trip' | 'error'

export interface QuotaResult {
  ok: boolean
  reason?: QuotaReason
  remaining?: number
  limit?: number
}

/** actor 字串：登入帳號用 user:<uuid>，群組裡還沒登入過的 LINE 使用者用 line:<userId> */
export const userActor = (userId: string) => `user:${userId}`
export const lineActor = (lineUserId: string) => `line:${lineUserId}`

/** db 必須是指向 app schema 的 service role client */
export async function consumeAi(db: SupabaseClient, tripId: string, actor: string, kind: AiKind): Promise<QuotaResult> {
  const { data, error } = await db.rpc('consume_ai', { p_trip_id: tripId, p_actor: actor, p_kind: kind })
  // 資料庫出問題時當作不能用（寧可少回一次，也不要在沒有計數的情況下叫 AI）
  if (error || !data || typeof data !== 'object') return { ok: false, reason: 'error' }
  return data as QuotaResult
}

/** 擋下時回給使用者的話（旅行喵喵的口吻，簡短） */
export function quotaReply(r: QuotaResult): string {
  switch (r.reason) {
    case 'trip_limit':
      return `這趟旅程的 AI 記帳次數用完了（${r.limit ?? ''} 次）喵。還是可以在網頁上自己記帳喔！`
    case 'ai_disabled':
      return '喵喵現在暫停服務中，請先在網頁上記帳，晚點再來找我。'
    case 'no_trip':
      return '找不到這趟旅程，請重新綁定一次。'
    default:
      return '喵喵剛剛出了點狀況，請稍後再試一次。'
  }
}
