// ============================================================
// line-api.ts —— 與 LINE Messaging API 的往來
//
// 簽章驗證、reply／push、「輸入中」動畫、成員顯示名稱，以及從 LINE CDN 下載訊息內容。
// import config.ts（存取權杖與 channel secret）與 db.ts（記下群組裡送出的訊息 id）。
// ============================================================

import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET } from "./config.ts"
import { supabase } from "./db.ts"
import { runInBackground } from "./util.ts"
import type { OutgoingMessage } from "./types.ts"

/**
 * 記下機器人在群組裡送出的訊息 id。使用者在 LINE 對它按「回覆」時，
 * webhook 會帶 `quotedMessageId`，對得上這裡的 id 就代表是在跟機器人講話（不必再 @）。
 * 一對一不需要：那邊每句話本來就會處理。
 */
async function recordSentMessages(res: Response, to: string | undefined): Promise<void> {
  // groupId 以 C 開頭、roomId 以 R 開頭、userId 以 U 開頭
  if (!to || to.startsWith('U')) return
  try {
    const body = await res.json() as { sentMessages?: { id: string }[] }
    const rows = (body.sentMessages ?? []).map((m) => ({ message_id: m.id, line_user_id: to }))
    if (rows.length === 0) return
    runInBackground(supabase.from('line_bot_messages').upsert(rows, { onConflict: 'message_id', ignoreDuplicates: true }))
  } catch (err) {
    console.warn('[LINE] Could not read sentMessages:', err)
  }
}

/**
 * 一對一聊天顯示「輸入中…」的動畫，等 AI 的時候使用者才知道機器人有在動。
 * LINE 只支援一對一（群組會 400），也不計入推播額度。回覆送出後動畫會自己消失。
 */
export async function showLoading(chatId: string, seconds = 30): Promise<void> {
  if (!chatId.startsWith('U')) return
  try {
    const res = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      // 5 的倍數，最多 60 秒
      body: JSON.stringify({ chatId, loadingSeconds: Math.min(60, Math.max(5, Math.round(seconds / 5) * 5)) }),
    })
    if (!res.ok) console.warn(`[LINE] Loading animation failed: ${await res.text()}`)
  } catch (err) {
    console.warn('[LINE] Loading animation failed:', err)
  }
}

export async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !LINE_CHANNEL_SECRET) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  // decodeBase64 回傳 Uint8Array<ArrayBufferLike>，新版 TS lib 不再視為 BufferSource
  const sigBytes = decodeBase64(signature) as unknown as BufferSource
  return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body))
}

export async function pushMessage(to: string, messages: OutgoingMessage[]) {
  console.log(`[LINE] Pushing to ${to}...`)
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  })
  if (!res.ok) console.error(`[LINE] Push Error: ${await res.text()}`)
  else await recordSentMessages(res, to)
}

/**
 * 這則事件的預設快速回覆按鈕（index.ts 建完 context 就登記），以 replyToken 為 key。
 *
 * LINE 只顯示**最後一則**訊息帶的快速回覆。很多回覆的最後一則是 Flex 卡片（記帳卡、修改卡、
 * 收據辨識），以前沒帶按鈕，輸入框上方那排按鈕就整個消失了。
 * 現在最後一則沒帶的話自動補上這組；自己帶了（例如選幣別）就照它的。
 */
const defaultQuickReplies = new Map<string, unknown>()

export function setDefaultQuickReply(replyToken: string, quickReply: unknown): void {
  if (!replyToken) return
  // 沒有回覆的事件（群組閒聊）不會來取，isolate 活得久時別讓它一直長
  if (defaultQuickReplies.size > 100) defaultQuickReplies.clear()
  defaultQuickReplies.set(replyToken, quickReply)
}

/** 最後一則沒有快速回覆時補上 fallback（純函式，測試用得到） */
export function withQuickReplyOnLast(messages: OutgoingMessage[], fallback: unknown): OutgoingMessage[] {
  const last = messages[messages.length - 1]
  if (!fallback || !last || last.quickReply) return messages
  return [...messages.slice(0, -1), { ...last, quickReply: fallback }]
}

export async function replyMessage(replyToken: string, rawMessages: OutgoingMessage[], to?: string) {
  console.log(`[LINE] Replying to ${replyToken}...`)
  const messages = withQuickReplyOnLast(rawMessages, defaultQuickReplies.get(replyToken))
  // replyToken 只能用一次，用過就清掉
  defaultQuickReplies.delete(replyToken)
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[LINE] Reply Error: ${errorText}`);
    // reply 失敗最常見的原因是 replyToken 過期（處理超過一分鐘，OCR 與語音都可能）。
    // ⚠️ 改用 push 補送**原本那組 messages**，不要送一段錯誤文字 ——
    //    以前這裡送的是錯誤訊息，於是使用者辛苦等來的記帳卡片整張消失，
    //    只看到一串 LINE 的英文錯誤（N5、G22）。push 會計入推播額度，
    //    但免費方案下這是罕見路徑，弄丟卡片的代價大得多。
    if (to) {
      await pushMessage(to, messages)
    }
    return
  }
  await recordSentMessages(res, to)
}

/**
 * 取得發言者的 LINE 顯示名稱。
 *
 * 三種來源三個 endpoint —— 原本只處理 group，
 * 導致多人聊天室的發言者永遠是「未知」，還被當成身分餵進 prompt。
 * 一對一也一樣抓不到，`我付的晚餐 300` 只能靠偏好設定猜付款人是誰。
 */
export async function getChatMemberName(
  sourceType: 'user' | 'group' | 'room',
  chatId: string,
  userId: string,
): Promise<string> {
  try {
    const endpoint = sourceType === 'group'
      ? `https://api.line.me/v2/bot/group/${chatId}/member/${userId}`
      : sourceType === 'room'
        ? `https://api.line.me/v2/bot/room/${chatId}/member/${userId}`
        : `https://api.line.me/v2/bot/profile/${userId}`
    const response = await fetch(
      endpoint,
      { headers: { "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    if (!response.ok) {
      console.error(`[LINE API Error] 無法取得成員名稱: ${await response.text()}`);
      return "";
    }
    const profile = await response.json();
    console.log(`[PROFILE in GROUP] ${JSON.stringify(profile, null, 2)}`)
    return profile.displayName;
  } catch (error) {
    console.error("[Fetch Error] 呼叫 LINE API 失敗:", error);
    return "";
  }
}

/**
 * 從 LINE 的 content endpoint 下載訊息內容（圖片、語音）。
 *
 * 刻意回傳整個 Response 而不是 ArrayBuffer：圖片與語音兩條路徑對
 * 「下載失敗」的處置本來就不一樣（一個丟固定訊息、一個帶 HTTP 狀態碼），
 * 而圖片那邊還要把這個 fetch 放進 Promise.all 跟旅程查詢並行。
 * 由呼叫端自己檢查 `res.ok`，行為與抽出來之前完全相同。
 */
export function downloadLineContent(messageId: string): Promise<Response> {
  return fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  })
}
