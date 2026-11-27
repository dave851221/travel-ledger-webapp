// ============================================================
// quota.ts —— 開放版（旅行喵喵）叫 AI 之前先扣這趟的次數
//
// 舊版（耀西）沒有額度，一律放行。開放版每次要叫 AI（文字、收據）之前呼叫 chargeAi：
// 扣不到就回一句說明、不叫 AI（資料庫出錯也一樣不叫，寧可少回也不要沒計數就花錢）。
// 規則在 supabase/app/schema/05_quota.sql。
// ============================================================

import { consumeAi, lineActor, quotaReply, userActor, type AiKind } from "../_shared/quota.ts"
import { IS_PUBLIC } from "./config.ts"
import type { EventContext } from "./context.ts"
import { supabase } from "./db.ts"
import { replyMessage } from "./line-api.ts"

/** 誰叫的：連到網站帳號的用帳號，否則用 LINE userId，再不然（群組裡沒加好友）用聊天室 */
export function actorOf(ctx: Pick<EventContext, 'accountUserId' | 'speakerUserId' | 'sourceId'>): string {
  if (ctx.accountUserId) return userActor(ctx.accountUserId)
  return lineActor(ctx.speakerUserId ?? ctx.sourceId)
}

/** 回傳 true＝可以叫 AI；false＝已經回覆過使用者（額度用完等），呼叫端直接結束 */
export async function chargeAi(ctx: EventContext, tripId: string, kind: AiKind): Promise<boolean> {
  if (!IS_PUBLIC) return true
  const r = await consumeAi(supabase, tripId, actorOf(ctx), kind)
  if (r.ok) return true
  console.log(`[QUOTA] AI blocked: ${r.reason}`)
  await replyMessage(ctx.replyToken, [{ type: 'text', text: quotaReply(r), quickReply: ctx.boundQR }], ctx.sourceId)
  return false
}

/** 照片張數（開放版）：機器人用 service role 上傳，storage 的上傳政策管不到，要自己問 */
export async function photoQuotaOk(tripId: string): Promise<boolean> {
  if (!IS_PUBLIC) return true
  const { error } = await supabase.rpc('photo_quota_ok', { p_trip_id: tripId })
  return !error
}
