// ============================================================
// handlers/image.ts —— 收據照片的 OCR 路徑
//
// 下載 → 上傳 Storage → AI OCR（`_shared/assistant/receipt.ts`，網頁聊天共用）→ 出卡片。
//
// 照片分三種（OCR_RESPONSE_SCHEMA 的 type）：
//   expense     收據、付款畫面 → 照常辨識金額
//   item_photo  不是收據但拍的是可以記帳的東西（食物、商品、門票…）→ 判斷是什麼、金額填 0，
//               卡片只有「✏️ 填金額」沒有「✅ 確認存入」，使用者到編輯頁補上金額才存得進去
//   not_receipt 認不出是什麼 → 照片照樣留著，出一張描述與金額都空白的卡片讓使用者自己填。
//               AI 回了壞掉的格式、或根本沒回應（額度、忙碌、逾時）時也一樣（使用者要求：上傳的照片不要丟）。
//
// ⚠️ 照片一旦上傳就要負責清乾淨：處理過程拋出 AI 以外的例外時（上傳失敗、回覆失敗…），
//    要把 filePath 從 bucket 移除，否則會留下沒有支出指向它的孤兒照片。
//    卡片出去之後由「❌ 取消」負責刪照片。
// ============================================================

import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { recognizeReceipt } from "../../_shared/assistant/receipt.ts"
import { aiUnavailableMessage, IS_PUBLIC, RECEIPTS_BUCKET, TRIP_GONE_MSG, WEBAPP_URL } from "../config.ts"
import { type EventContext, extendFollowup, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import { photoViewUrl, storePendingExpense } from "../drafts.ts"
import { ai } from "../ai.ts"
import { downloadLineContent, replyMessage, showLoading } from "../line-api.ts"
import { chargeAi, photoQuotaOk } from "../quota.ts"
import { buildDraftLiffUrl, buildExpenseCard, buildItemsLiffUrl, canGoSolo, canSplitByItems } from "../messages.ts"
import { runInBackground } from "../util.ts"
import type { ImageMessageEvent } from "../types.ts"

/** 處理一張收據照片。呼叫端已經確認 ctx.isBound。 */
export async function handleImage(ctx: EventContext, event: ImageMessageEvent): Promise<void> {
  const { boundQR, memberName, replyToken, sourceId, userState } = ctx

  const messageId = event.message.id

  // 群組靜音模式：照片完全不碰（不下載、不辨識、不回覆）。
  // 有人問「怎麼沒反應」時，AI 的 context 裡有目前的模式，答得出來（ai-text.ts）。
  if (ctx.isGroup && ctx.groupMode === 'silent') {
    console.log(`[IMAGE] Group is in silent mode, ignoring messageId: ${messageId}`)
    return
  }

  if (!userState?.current_trip_id) {
    await replyMessage(replyToken, [{ type: 'text', text: IS_PUBLIC ? '👋 請先輸入「綁定」選旅程，再傳送收據照片喔！' : '👋 請先輸入 ID:代碼 來連結旅程，再傳送收據照片喔！' }], sourceId)
    return
  }

  // 一對一顯示「輸入中…」：下載、上傳、辨識加起來常常要好幾秒
  runInBackground(showLoading(sourceId))

  const tripId = userState.current_trip_id
  const filePath = `expenses/${tripId}/${messageId}.jpg`
  try {
    console.log(`[IMAGE] Downloading messageId: ${messageId}`)
    const [lineRes, { data: trip }] = await Promise.all([
      downloadLineContent(messageId),
      supabase.from('trips').select('*').eq('id', tripId).single()
    ])
    if (!lineRes.ok) throw new Error('Failed to download image from LINE')

    if (!trip) {
      await replyMessage(replyToken, [{ type: 'text', text: TRIP_GONE_MSG }], sourceId)
      return
    }
    // 照片還沒上傳，直接回覆就好，不需要清理 Storage。
    // 以前是靜默 continue —— 使用者傳了照片卻什麼都沒發生，
    // 與文件寫的「回覆已封存」不符（H8）。
    if (trip.is_archived) {
      console.log(`[PHOTO] Trip ${tripId} is archived, ignoring photo from ${sourceId}`)
      await replyMessage(replyToken, [{
        type: 'text', text: '🔒 此旅程已封存，無法新增支出（照片未儲存）。', quickReply: boundQR,
      }], sourceId)
      return
    }

    // 開放版：照片張數與 AI 次數（照片還沒上傳，不用清理）
    if (!(await photoQuotaOk(tripId))) {
      await replyMessage(replyToken, [{
        type: 'text', text: '這趟旅程的照片張數已經滿了，這張沒有存。可以直接打字記帳，例如「晚餐 1200」。', quickReply: boundQR,
      }], sourceId)
      return
    }
    if (!(await chargeAi(ctx, tripId, 'receipt'))) return

    const imageBuffer = await lineRes.arrayBuffer()

    console.log(`[STORAGE] Uploading to: ${filePath}`)
    const { error: uploadErr } = await supabase.storage.from(RECEIPTS_BUCKET).upload(filePath, imageBuffer, {
      contentType: 'image/jpeg', upsert: true
    })
    if (uploadErr) throw uploadErr

    const publicUrl = await photoViewUrl(filePath, tripId)
    const base64Image = encodeBase64(new Uint8Array(imageBuffer))
    const today = tripToday(trip)

    // prompt、驗證、品項明細都在共用的 recognizeReceipt（網頁聊天用同一份）
    const ocr = await recognizeReceipt(ai, {
      trip, memberName, today,
      tripUrl: `${WEBAPP_URL}/#/trip/${tripId}/dashboard`,
      imageBase64: base64Image,
    })
    const { expense, items, itemsSubtotal, needsAmount, unidentified, payerDefaulted } = ocr

    if (ocr.reject) {
      // 這趟旅程沒有這個幣別的匯率。直接存下去統計會以 1:1 換算而失真，
      // 所以還是不能存 —— 但**照片要留著**（M10）。
      // 把辨識結果暫存起來，附上「以 XXX 存入」的快速回覆讓他當場選一個幣別。
      // （prepareExpense 被拒時仍回傳正規化好的內容，所以這裡直接存得下去。）
      const available = Object.keys(trip.rates ?? {})
      const pendingNonce = Math.random().toString(36).substring(2, 10)
      await storePendingExpense(sourceId, pendingNonce, {
        exp: {
          d: expense.description, a: expense.amount, c: expense.currency,
          dt: expense.date, cat: expense.category,
          p: expense.payer_data, s: expense.split_details,
        },
        p: [messageId], rc: !needsAmount, tid: tripId, it: items.length > 0 ? items : undefined, st: itemsSubtotal,
      })
      // 幣別按鈕 + 取消。快速回覆上限 13 顆，留一顆給取消。
      const currencyItems = available.slice(0, 12).map(cur => ({
        type: 'action',
        action: {
          type: 'postback', label: `以 ${cur} 存入`,
          data: JSON.stringify({ act: 'cur', n: pendingNonce, c: cur }),
        },
      }))
      await replyMessage(replyToken, [{
        type: 'text',
        text: `${ocr.fallbackNotice ? `${ocr.fallbackNotice}\n\n` : ''}${ocr.reject}\n\n📷 收據已經先幫你留著了，選一個幣別就能直接存入（金額不會換算）。`,
        quickReply: {
          items: [
            ...currencyItems,
            { type: 'action', action: { type: 'postback', label: '❌ 取消', data: JSON.stringify({ act: 'cancel', n: pendingNonce }) } },
          ],
        },
      }], sourceId)
      return
    }

    const photo_ids = [messageId]
    const nonce = Math.random().toString(36).substring(2, 10)
    const exp_short = {
      d: expense.description, a: expense.amount, c: expense.currency,
      dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
    }

    // ⚠️ 這裡刻意不讓舊草稿失效。一次選兩張收據送出時，
    //    第二張會讓第一張作廢，使用者只記得到最後一張（H1、H7）。
    //    卡片失效只發生在 AI 明確指出「這句是在修正某張草稿」的時候。
    await storePendingExpense(sourceId, nonce, {
      exp: exp_short, p: photo_ids, rc: !needsAmount, tid: tripId, pd: payerDefaulted || undefined, it: items.length > 0 ? items : undefined, st: itemsSubtotal,
    })

    // 摘要要帶 nonce：AI 才有辦法用 corrects_draft 指名它要修正哪一張卡片
    const historySummary = `[記帳建議] ${JSON.stringify({ ...expense, photo_ids, nonce }, null, 2)}`
    runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary }))

    const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
    // 草稿卡片的「✏️ 編輯」只帶 nonce，完整內容 LiffEdit 自己去 pending 列撈（T2）
    const liffUrl = buildDraftLiffUrl(trip.id, nonce, sourceId)

    // 幣別或日期被修正過就一併告知；AI 全忙時多說一句為什麼卡片是空的
    const ocrWarningMsg = ocr.notes.length > 0
      ? [{ type: 'text' as const, text: ocr.notes.join('\n') }]
      : []

    await replyMessage(replyToken, [...ocrWarningMsg, buildExpenseCard({
      expense,
      title: needsAmount ? "📷 照片記帳" : "🔍 AI 辨識結果",
      altText: unidentified
        ? '照片記帳（請填寫內容與金額）'
        : needsAmount ? `照片記帳（還沒填金額）: ${expense.description}` : `收據辨識預覽: ${expense.description}`,
      heroUrl: publicUrl || null,
      nonce, webUrl, liffUrl, needsAmount, unidentified,
      soloButton: canGoSolo(expense, trip.members),
      itemsUrl: canSplitByItems(items, trip.members) ? buildItemsLiffUrl(trip.id, nonce, sourceId) : undefined,
    })], sourceId)
    // 傳完照片接著打「這是抹茶冰淇淋 600」來補充，群組的提及模式下也不必再 @
    extendFollowup(ctx)
  } catch (e) {
    console.error('[OCR_ERROR]', e)
    await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
    const msg = aiUnavailableMessage(e) ?? '😵 處理圖片時發生錯誤，請稍後再試。'
    await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
  }
}
