// ============================================================
// line-webhook —— LINE Bot 的進入點
//
// 這支檔案只做五件事：驗簽章、解析事件、略過 LINE 重送的事件、建 EventContext、分派給 handler。
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
import { buildEventContext, extendFollowup, isQuotingBot } from "./context.ts"
import { IS_PUBLIC, LINE_CHANNEL_ACCESS_TOKEN } from "./config.ts"
import { handlePublicBindPostback, isPublicBindPostback } from "./handlers/bind-public.ts"
import { claimWebhookEvent, supabase } from "./db.ts"
import { replyMessage, setDefaultQuickReply, verifySignature } from "./line-api.ts"
import { BOT_SELF_INTRODUCTION, getQuickReply } from "./messages.ts"
import { handleAiText } from "./handlers/ai-text.ts"
import { handleAudio } from "./handlers/audio.ts"
import { handleCommands, routeTextMessage } from "./handlers/commands.ts"
import { handleImage } from "./handlers/image.ts"
import { handleLiffEcho } from "./handlers/liff-echo.ts"
import { handlePostback } from "./handlers/postback.ts"
import type {
  AudioMessageEvent,
  ImageMessageEvent,
  Mentionee,
  TextMessageEvent,
  WebhookEvent,
} from "./types.ts"

serve(async (req) => {
  // 保溫用的 GET。排程已關（Disk IO 額度撐不住，見 migrations/20261116_unschedule_keep_warm.sql），分支留著無害。
  // 按鈕幾乎每次都碰上冷啟動：worker 閒置約一分鐘就關，新 worker 連資料庫、LINE API 都要重新握手，
  // 光這段就多 0.5～1 秒。這裡各打一個最輕的請求，讓 worker 與兩條連線都留著。
  // LINE 的 webhook 一律是 POST，GET 不會撞到正式流程。
  if (req.method === 'GET') {
    await Promise.allSettled([
      supabase.from('line_user_states').select('line_user_id').limit(1),
      fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } })
        .then(r => r.body?.cancel()),
    ])
    return new Response('warm', { status: 200 })
  }
  try {
    const signature = req.headers.get('x-line-signature')
    const bodyText = await req.text()
    if (!(await verifySignature(bodyText, signature))) return new Response('Unauthorized', { status: 401 })

    const { events } = JSON.parse(bodyText) as { events?: WebhookEvent[] }
    for (const event of events ?? []) {
      console.log(`[EVENT_RAW] Received event type: ${event.type}`)

      // LINE 重送的同一個事件只處理一次。
      // ⚡ 與 buildEventContext 同時做：postback 幾乎都是冷啟動，每趟資料庫往返要 0.3～1 秒。
      //    重送時 context 白查一次無妨（它只讀狀態、補 last_active_at）。
      const [claimed, ctx] = await Promise.all([
        claimWebhookEvent(event.webhookEventId),
        buildEventContext(event),
      ])
      if (!claimed) {
        console.log(`[EVENT_DEDUP] Skipping redelivered event ${event.webhookEventId}`)
        continue
      }

      const { boundQR, isBound, replyToken, sourceId, sourceType } = ctx
      // 回覆的最後一則沒帶按鈕時自動補上（記帳卡片之後按鈕才不會消失）
      setDefaultQuickReply(replyToken, isBound ? boundQR : getQuickReply(false))

      // --- 被加進群組／聊天室（M19）---
      // 以前完全不處理 join，機器人進來之後一片安靜，
      // 沒人知道它會做什麼、也不知道要先輸入 ID:代碼 綁定旅程。
      // 開放版：加好友（follow）也自我介紹，告訴對方怎麼綁定
      if (event.type === 'join' || (IS_PUBLIC && (event as { type: string }).type === 'follow')) {
        console.log(`[JOIN] Added to ${sourceType} ${sourceId}`)
        await replyMessage(replyToken, [{
          type: 'text',
          text: BOT_SELF_INTRODUCTION,
          quickReply: isBound ? boundQR : getQuickReply(false),
        }], sourceId)
        continue
      }

      // --- 開放版：選旅程的按鈕（還沒綁定時也要能按）---
      if (IS_PUBLIC && event.type === 'postback' && isPublicBindPostback(event.postback?.data)) {
        await handlePublicBindPostback(ctx, event.postback.data)
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

      // LIFF 存檔後以使用者名義送出的「✅ 已記帳」：回完整確認，不進 AI、不看群組模式
      if (transcript === null && await handleLiffEcho(ctx, rawText)) continue

      // 引用回覆只有打字的訊息才有；有引用才查資料庫
      const quotingBot = transcript === null && await isQuotingBot(ctx, textEvent.message.quotedMessageId)
      const route = routeTextMessage(ctx, rawText, mentionees, quotingBot)
      if (!route) continue

      if (await handleCommands(ctx, route)) {
        // 查完「今日支出」接著問「那昨天呢」也不必再 @
        extendFollowup(ctx)
        continue
      }

      if (isBound) {
        await handleAiText(ctx, route)
        continue
      }

      // 其他，尚未綁定狀態下的聊天
      const bindHint = IS_PUBLIC ? '👋 請先輸入「綁定」，選要記帳的旅程。' : '👋 請先輸入 ID:代碼 來連結旅程。'
      await replyMessage(replyToken, [{ type: 'text', text: bindHint, quickReply: getQuickReply(false) }], sourceId)
    }
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[GLOBAL_ERROR]', err)
    return new Response('Error', { status: 500 })
  }
})
