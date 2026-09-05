// ============================================================
// handlers/audio.ts —— 語音訊息（M15）
//
// 先轉成文字，接著完全走打字的那條路 —— 快捷指令、草稿修正、取消、
// 編輯清單、AI 記帳全部都能用語音講，而不是只有記帳。
//
// ⚠️ 群組的提及模式**不處理語音**：語音沒辦法 @提及機器人，
//    要嘛每則語音都下載＋轉錄（群組裡語音很多，額度撐不住），
//    要嘛就是現在這樣跳過。想在群組用語音請切「模式:全回應模式」。
// ============================================================

import { isRateLimit, RATE_LIMIT_MSG } from "../config.ts"
import type { EventContext } from "../context.ts"
import { transcribeAudio } from "../gemini.ts"
import { replyMessage } from "../line-api.ts"
import type { AudioMessageEvent } from "../types.ts"

/**
 * 把語音轉成文字。
 *
 * 回傳 `null` 代表「這則事件已經處理完了」（略過、轉錄失敗、或聽不出內容，
 * 該回的話都回過了），呼叫端直接跳到下一則事件；
 * 回傳字串則代表轉錄成功，要當成使用者打的字往下走。
 */
export async function handleAudio(ctx: EventContext, event: AudioMessageEvent): Promise<string | null> {
  const { boundQR, isGroup, mentionRequired, replyToken, sourceId } = ctx

  if (isGroup && mentionRequired) {
    console.log('[AUDIO] Group in mention mode, skipping voice message.')
    return null
  }
  let transcript: string
  try {
    transcript = await transcribeAudio(event.message.id)
  } catch (err) {
    console.error('[AUDIO_ERROR]', err)
    const msg = isRateLimit(err)
      ? RATE_LIMIT_MSG
      : String((err as Error)?.message) === 'AUDIO_TOO_LARGE'
        ? '😅 這段語音太長了，請講短一點（或直接打字）。'
        : '😵 語音處理時發生錯誤，請稍後再試，或直接打字。'
    await replyMessage(replyToken, [{ type: 'text', text: msg, quickReply: boundQR }], sourceId)
    return null
  }
  console.log(`[AUDIO] Transcript: "${transcript}"`)
  if (!transcript) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: '🎤 我聽不太清楚這段語音，可以再說一次，或直接打字嗎？',
      quickReply: boundQR,
    }], sourceId)
    return null
  }
  return transcript
}
