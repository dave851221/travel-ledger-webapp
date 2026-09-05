// ============================================================
// line-webhook —— LINE Bot 的進入點
//
// 這支檔案只做四件事：驗簽章、解析事件、建 EventContext、分派給 handler。
// 真正的邏輯都在 handlers/ 底下，共用的東西在同目錄的葉節點模組。
//
// 模組相依是單向的，不要繞回去：
//   config → db → line-api → drafts / messages / gemini
//          → context → handlers/* → index
//
// ⚠️ 分派順序就是行為規格：
//    join → postback → image → audio → 文字。postback／image／audio 三個分支
//    都以「已綁定」為前提，未綁定者按了舊卡片會一路掉到最後的
//    「請先輸入 ID:代碼」，那是刻意的。
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { buildEventContext } from "./context.ts"
import { replyMessage, verifySignature } from "./line-api.ts"
import { BOT_SELF_INTRODUCTION, getQuickReply } from "./messages.ts"
import { handleAiText } from "./handlers/ai-text.ts"
import { handleAudio } from "./handlers/audio.ts"
import { handleCommands, routeTextMessage } from "./handlers/commands.ts"
import { handleImage } from "./handlers/image.ts"
import { handlePostback } from "./handlers/postback.ts"
import type {
  AudioMessageEvent,
  ImageMessageEvent,
  Mentionee,
  TextMessageEvent,
  WebhookEvent,
} from "./types.ts"

serve(async (req) => {
  try {
    const signature = req.headers.get('x-line-signature')
    const bodyText = await req.text()
    if (!(await verifySignature(bodyText, signature))) return new Response('Unauthorized', { status: 401 })

    const { events } = JSON.parse(bodyText) as { events?: WebhookEvent[] }
    for (const event of events ?? []) {
      console.log(`[EVENT_RAW] Received event type: ${event.type}`)

      const ctx = await buildEventContext(event)
      const { boundQR, isBound, replyToken, sourceId, sourceType } = ctx

      // --- 被加進群組／聊天室（M19）---
      // 以前完全不處理 join，機器人進來之後一片安靜，
      // 沒人知道它會做什麼、也不知道要先輸入 ID:代碼 綁定旅程。
      if (event.type === 'join') {
        console.log(`[JOIN] Added to ${sourceType} ${sourceId}`)
        await replyMessage(replyToken, [{
          type: 'text',
          text: BOT_SELF_INTRODUCTION,
          quickReply: isBound ? boundQR : getQuickReply(false),
        }], sourceId)
        continue
      }

      // --- Postback 處理 ---
      if (isBound && event.type === 'postback') {
        await handlePostback(ctx, event)
        continue
      }

      // --- 圖片處理 (收據 OCR) ---
      if (isBound && event.type === 'message' && event.message.type === 'image') {
        await handleImage(ctx, event as ImageMessageEvent)
        continue
      }

      // --- 語音訊息（M15）---
      // 轉成文字之後完全走打字的那條路。null 代表已經回覆過了（略過或轉錄失敗）。
      let transcript: string | null = null
      if (isBound && event.type === 'message' && event.message.type === 'audio') {
        transcript = await handleAudio(ctx, event as AudioMessageEvent)
        if (transcript === null) continue
      }

      // --- 其餘非文字訊息則跳過處理 ---
      if (transcript === null && (event.type !== 'message' || event.message.type !== 'text')) {
        console.log(`[SKIP] Not a text message event.`)
        continue
      }

      // ⚠️ mentionees 的 index 是相對於**原始未 trim 的** text，切 mention 要用原文（M16）
      //    語音沒有 mention 資料，轉錄出來的文字直接當原文用。
      const textEvent = event as TextMessageEvent
      const rawText: string = transcript ?? textEvent.message.text
      const mentionees: Mentionee[] | undefined = transcript === null
        ? textEvent.message.mention?.mentionees
        : undefined

      const route = routeTextMessage(ctx, rawText, mentionees)
      if (!route) continue

      if (await handleCommands(ctx, route)) continue

      if (isBound) {
        await handleAiText(ctx, route)
        continue
      }

      // 其他，尚未綁定狀態下的聊天
      await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程。', quickReply: getQuickReply(false) }], sourceId)
    }
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[GLOBAL_ERROR]', err)
    return new Response('Error', { status: 500 })
  }
})
