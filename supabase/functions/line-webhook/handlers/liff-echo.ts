// ============================================================
// handlers/liff-echo.ts —— LIFF 存檔後，使用者聊天室送出的那句「✅ 已記帳：…」
//
// LIFF 頁面用 liff.sendMessages() 以使用者名義送出暗號（不算推播額度），
// 這裡找到 liff-notify 先存好的 `liff_notice` 列，用這則事件的 replyToken 回完整確認（含 ↩️ 撤銷）。
// 不論群組模式都要處理：它不是在跟 AI 聊天，也不能被當成記帳指令。
// 全貌見 _shared/liffEcho.ts。
// ============================================================

import type { EventContext } from "../context.ts"
import { supabase } from "../db.ts"
import { replyMessage } from "../line-api.ts"
import { LIFF_NOTICE_ROLE, looksLikeLiffEcho, pickLiffNotice } from "../../_shared/liffEcho.ts"

/** 處理掉了回 true；不像暗號、或對不到任何一列（使用者自己打的）就回 false，照一般訊息走 */
export async function handleLiffEcho(ctx: EventContext, text: string): Promise<boolean> {
  if (!looksLikeLiffEcho(text)) return false
  const { data: rows, error } = await supabase.from('line_chat_history')
    .select('id, content, created_at')
    .eq('line_user_id', ctx.sourceId)
    .eq('role', LIFF_NOTICE_ROLE)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) {
    console.error('[LIFF_ECHO] read notice failed:', error)
    return false
  }
  const hit = pickLiffNotice(rows ?? [], text, Date.now())
  if (!hit) return false
  console.log(`[LIFF_ECHO] Replying saved confirmation (notice ${hit.id})`)
  const message: Record<string, unknown> = { type: 'text', text: hit.notice.text }
  if (hit.notice.quickReply) message.quickReply = hit.notice.quickReply
  await Promise.all([
    replyMessage(ctx.replyToken, [message], ctx.sourceId),
    // 用過就刪，同一句話不會被回第二次
    supabase.from('line_chat_history').delete().eq('id', hit.id).then(({ error: e }) => {
      if (e) console.error('[LIFF_ECHO] delete notice failed:', e)
    }),
  ])
  return true
}
