// ============================================================
// handlers/postback.ts —— Flex 卡片按鈕（postback）
//
// 五種動作：undo（撤銷已存入）、cur（換個幣別重新出卡）、del（從清單刪除）、
// save（確認存入）、cancel（取消草稿）。
//
// ⚠️ 防重複點擊的鎖是 line_processed_actions 的 PK 衝突：先寫 nonce 再做事。
//    做不成的時候一定要 releaseNonce()，不然那張卡片連「✏️ 編輯」都會說已處理過。
// ============================================================

import { Decimal } from "../../_shared/deps.ts"
import { calculateDistribution, DEFAULT_PRECISION } from "../../_shared/finance.ts"
import { RECEIPTS_BUCKET, WEBAPP_URL } from "../config.ts"
import type { EventContext } from "../context.ts"
import { supabase } from "../db.ts"
import {
  getPendingExpense,
  photoPublicUrl,
  releaseNonce,
  storePendingExpense,
} from "../drafts.ts"
import { replyMessage } from "../line-api.ts"
import {
  buildDraftLiffUrl,
  buildExpenseCard,
  describeProcessedAction,
} from "../messages.ts"
import type { AmountMap, PrecisionConfig } from "../../_shared/types.ts"
import type { DraftExpense, PostbackData, PostbackEvent } from "../types.ts"

/** 處理一則 postback。呼叫端已經確認 ctx.isBound。 */
export async function handlePostback(ctx: EventContext, event: PostbackEvent): Promise<void> {
  const { boundQR, replyToken, sourceId, speakerLabel, speakerUserId, userState } = ctx

  let postbackData: PostbackData
  try {
    postbackData = JSON.parse(event.postback.data)
  } catch {
    console.error('[POSTBACK] Failed to parse postback data:', event.postback.data)
    await replyMessage(replyToken, [{ type: 'text', text: '❌ 無效的操作資料，請重試。' }], sourceId)
    return
  }

  console.log(`[POSTBACK] Data: ${event.postback.data}`)

  // 撤銷存入（postback 按鈕）
  //
  // postback 只帶 eid：描述放進去的話，外文店名＋中文說明很容易讓整包
  // 超過 LINE 的 300 bytes 上限，整則「已存入」回覆會直接發送失敗（H12）。
  // 描述在這裡回查即可。舊卡片仍可能帶 d，留著當後備。
  if (postbackData.act === 'undo') {
    const expenseId = postbackData.eid
    if (!expenseId) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到可撤銷的記錄。' }], sourceId)
      return
    }
    const { data: target } = await supabase.from('expenses')
      .select('description, deleted_at')
      .eq('id', expenseId)
      .eq('trip_id', userState.current_trip_id)
      .maybeSingle()
    const description = target?.description || postbackData.d || '該筆支出'

    if (!target) {
      await replyMessage(replyToken, [{
        type: 'text', text: '❌ 找不到這筆支出，可能已被永久刪除，或不屬於目前綁定的旅程。',
      }], sourceId)
      return
    }
    // 已經撤銷過就別再 UPDATE 一次：deleted_at 被刷新的話，
    // 網頁垃圾桶的 24 小時保留期會整個重算（H3）。
    if (target.deleted_at) {
      await replyMessage(replyToken, [{
        type: 'text', text: `ℹ️ 「${description}」先前已經撤銷了。`, quickReply: boundQR,
      }], sourceId)
      return
    }

    const { error } = await supabase.from('expenses')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', expenseId)
      .is('deleted_at', null)
    if (error) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 撤銷失敗，請至網頁手動刪除。' }], sourceId)
    } else {
      await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${description}`, quickReply: boundQR }], sourceId)
    }
    return
  }

  // 「以 XXX 存入」—— 收據的幣別在這趟旅程沒有匯率時的補救（M10）。
  // 照片與辨識結果已經先存成 pending，這裡只是換個幣別重新出卡，
  // 使用者不必為了改一個幣別重拍收據。
  if (postbackData.act === 'cur') {
    const oldNonce = postbackData.n
    const chosen = String(postbackData.c ?? '').toUpperCase()
    const pending = oldNonce ? await getPendingExpense(sourceId, oldNonce) : null
    if (!pending) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新傳送收據。' }], sourceId)
      return
    }

    // 佔用舊 nonce，避免同一則訊息的按鈕被連按兩次而出兩張卡
    const { error: lockErr } = await supabase.from('line_processed_actions')
      .insert({ nonce: oldNonce, line_user_id: sourceId, action_type: 'superseded' })
    if (lockErr) {
      const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', oldNonce).maybeSingle()
      await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId)
      return
    }

    // isBound 是呼叫端的前提，current_trip_id 必定有值
    const tripIdForCur = pending.tid || userState.current_trip_id as string
    const { data: curTrip } = await supabase.from('trips')
      .select('id, rates, precision_config, base_currency, default_currency, members').eq('id', tripIdForCur).maybeSingle()
    if (!curTrip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。' }], sourceId)
      return
    }
    if (!Object.prototype.hasOwnProperty.call(curTrip.rates ?? {}, chosen)) {
      await replyMessage(replyToken, [{ type: 'text', text: `❌ 這趟旅程沒有 ${chosen} 的匯率，請先到網頁設定。` }], sourceId)
      return
    }

    // 🚫 只換幣別標籤，金額不換算 —— 與兩個 prompt 的規則一致。
    //    但精度會變（USD 2 位 → TWD 0 位），所以分帳要照新精度重算：
    //    把原本的分配當成 lockedData 交回去，餘數由 calculateDistribution
    //    強制加到調整成員身上，Σ 一定等於總額。
    const src = pending.exp ?? {}
    const curPrecision = (curTrip.precision_config as PrecisionConfig | null)?.[chosen] ?? DEFAULT_PRECISION[chosen] ?? 2
    const curAmount = new Decimal(Number(src.a) || 0).toDecimalPlaces(curPrecision).toNumber()
    const curPayers = Object.keys(src.p ?? {})
    const curSplits = Object.keys(src.s ?? {})
    const curAdjust = curPayers.find((m: string) => curSplits.includes(m)) ?? curSplits[0]
    // 全 0 的 map 是 applyParticipantDefaults 的佔位（意思是均分），不能當鎖定金額交給
    // calculateDistribution，否則整筆會落到調整成員身上（H6 同款問題）。
    // 有值的先照新精度四捨五入，餘數由 calculateDistribution 給調整成員。
    const relock = (map: Record<string, unknown> | undefined): Record<string, number> => {
      const entries = Object.entries(map ?? {})
      if (entries.every(([, v]) => !(Number(v) || 0))) return {}
      const out: Record<string, number> = {}
      for (const [k, v] of entries) out[k] = new Decimal(Number(v) || 0).toDecimalPlaces(curPrecision).toNumber()
      return out
    }
    const curExpense = {
      description: src.d, amount: curAmount, currency: chosen,
      date: src.dt, category: src.cat,
      payer_data: curPayers.length > 0
        ? calculateDistribution(curAmount, curPayers, relock(src.p), curPayers[0], curPrecision) : {},
      split_details: curSplits.length > 0
        ? calculateDistribution(curAmount, curSplits, relock(src.s), curAdjust, curPrecision) : {},
    }

    const newNonce = Math.random().toString(36).substring(2, 10)
    const photoIds = pending.p ?? []
    await storePendingExpense(sourceId, newNonce, {
      exp: {
        d: curExpense.description, a: curExpense.amount, c: curExpense.currency,
        dt: curExpense.date, cat: curExpense.category,
        p: curExpense.payer_data, s: curExpense.split_details,
      },
      p: photoIds, tid: tripIdForCur,
    })
    await replyMessage(replyToken, [buildExpenseCard({
      expense: curExpense,
      title: `🔍 已改用 ${chosen}`,
      altText: `確認記帳: ${curExpense.description}`,
      heroUrl: photoIds.length > 0 ? photoPublicUrl(photoIds[0], tripIdForCur) : null,
      nonce: newNonce,
      webUrl: `${WEBAPP_URL}/#/trip/${tripIdForCur}/dashboard`,
      liffUrl: buildDraftLiffUrl(tripIdForCur, newNonce, sourceId),
    })], sourceId)
    return
  }

  // 從「刪除支出」清單點選的刪除
  if (postbackData.act === 'del') {
    const expenseId = postbackData.eid
    if (!expenseId) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這筆支出。' }], sourceId)
      return
    }
    const { data: target } = await supabase.from('expenses')
      .select('description, deleted_at').eq('id', expenseId).maybeSingle()

    if (!target) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 這筆支出已不存在。' }], sourceId)
      return
    }
    if (target.deleted_at) {
      await replyMessage(replyToken, [{
        type: 'text', text: `ℹ️ 「${target.description}」先前已經刪除了。`, quickReply: boundQR,
      }], sourceId)
      return
    }

    const { error } = await supabase.from('expenses')
      .update({ deleted_at: new Date().toISOString() }).eq('id', expenseId)
    if (error) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 刪除失敗，請至網頁操作。' }], sourceId)
    } else {
      const by = speakerLabel ? `（由 ${speakerLabel} 刪除）` : ''
      await replyMessage(replyToken, [{
        type: 'text',
        text: `🗑 已刪除：${target.description}${by}\n\n24 小時內可到網頁的垃圾桶還原。`,
        quickReply: boundQR,
      }], sourceId)
    }
    return
  }

  if (postbackData.action === 'save_expense' || postbackData.act === 'save') {
    const { n: nonce_short, expense: exp_old, exp: exp_new, photo_urls: p_old, p: p_new } = postbackData
    const nonce = nonce_short || postbackData.nonce

    // 優先從 chat_history 取得 pending 資料（避免 300 bytes 限制）
    let expenseRaw: DraftExpense | undefined = exp_new || exp_old || postbackData.expense
    let photo_ids = p_new || p_old || postbackData.photo_urls || []
    let trip_id = postbackData.trip_id || userState?.current_trip_id

    if (!expenseRaw && nonce) {
      const pending = await getPendingExpense(sourceId, nonce)
      if (pending) {
        expenseRaw = pending.exp
        photo_ids = pending.p || []
        trip_id = pending.tid || trip_id
      }
    }

    if (!expenseRaw) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新記帳。' }], sourceId); return
    }

    if (nonce) {
      const { error: nonceInsertError } = await supabase
        .from('line_processed_actions')
        .insert({ nonce, line_user_id: sourceId, action_type: 'save' });
      if (nonceInsertError) {
        // 查詢 action_type，給予更明確的重複操作提示
        const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
        await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId); return
      }
    }

    if (!trip_id) {
      await replyMessage(replyToken, [{ type: 'text', text: `❌ 找不到對應旅程，請重新綁定。` }], sourceId); return
    }

    const expense = {
      description: expenseRaw.d ?? expenseRaw.description,
      amount: expenseRaw.a ?? expenseRaw.amount,
      currency: expenseRaw.c ?? expenseRaw.currency,
      date: expenseRaw.dt ?? expenseRaw.date,
      category: expenseRaw.cat ?? expenseRaw.category,
      payer_data: expenseRaw.p ?? expenseRaw.payer_data ?? {},
      split_details: expenseRaw.s ?? expenseRaw.split_details ?? {}
    }

    const photo_urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)

    const { data: trip } = await supabase.from('trips')
      .select('precision_config, members, is_archived, default_payer, default_split_members')
      .eq('id', trip_id).single()

    if (!trip) {
      // 旅程可能已被刪除（見 docs/DB_MAINTENANCE.md），此時舊卡片的按鈕不該讓整個函式崩掉
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId);
      return;
    }
    if (trip.is_archived) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 此旅程已封存，無法新增支出。' }], sourceId);
      return;
    }

    // 卡片產生時一定填好了 currency，只是短鍵／長鍵兩種來源在型別上都是選填
    const currency = expense.currency as string
    const precision = (trip.precision_config as PrecisionConfig | null)?.[currency] ?? DEFAULT_PRECISION[currency] ?? 2
    const numAmount = new Decimal(parseFloat(String(expense.amount)) || 0).toDecimalPlaces(precision).toNumber()
    const payerMembers = Object.keys(expense.payer_data).filter(m => trip.members.includes(m))
    const splitMembers = Object.keys(expense.split_details).filter(m => trip.members.includes(m))

    // 空的付款人或分攤名單過去會一路走到「Σ != 總額」，
    // 使用者收到的是「財務運算發生錯誤，請聯絡管理員」這種毫無頭緒的訊息。
    // 卡片產生時已經補過預設值（applyParticipantDefaults），
    // 走到這裡還是空的多半是成員在存檔前被刪掉了，只能請使用者重新編輯。
    if (payerMembers.length === 0 || splitMembers.length === 0) {
      console.warn(`[SAVE] Empty participants after filtering. trip=${trip_id}`)
      // 沒有存成功就把 nonce 放掉，卡片上的按鈕才還能用（不然連「✏️ 編輯」都會說已處理過）
      await releaseNonce(nonce)
      await replyMessage(replyToken, [{
        type: 'text',
        text: '😅 這筆的付款人或分攤成員是空的（可能是成員已被移除），無法存入。\n\n請按卡片上的「✏️ 編輯」補上，或直接重說一次。',
        quickReply: boundQR,
      }], sourceId)
      return
    }

    // 卡片上有、但成員清單裡已經沒有的名字（M12）。
    //
    // ⚠️ 不能默默存下去：被移除的人的份額會被 calculateDistribution
    //    當成餘數加到調整成員身上，Σ 仍然等於總額，所以下面的檢查也攔不住 ——
    //    帳面上完全正常，只是有個人平白多背了一份。
    const droppedPayers = Object.keys(expense.payer_data).filter(m => !trip.members.includes(m))
    const droppedSplits = Object.keys(expense.split_details).filter(m => !trip.members.includes(m))
    const dropped = [...new Set([...droppedPayers, ...droppedSplits])]
    if (dropped.length > 0) {
      console.warn(`[SAVE] Members no longer in trip: ${dropped.join(', ')}`)
      await releaseNonce(nonce)
      await replyMessage(replyToken, [{
        type: 'text',
        text: `😅 這張卡片上的「${dropped.join('、')}」已經不在旅程成員裡了，不能就這樣存入 —— `
          + `他的那一份會被默默算到別人頭上。\n\n`
          + `目前成員：${trip.members.join('、')}\n\n`
          + `請按卡片上的「✏️ 編輯」重新分攤，或直接重說一次。`,
        quickReply: boundQR,
      }], sourceId)
      return
    }

    const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
    const finalPayerData = calculateDistribution(numAmount, payerMembers, expense.payer_data, payerMembers[0], precision)
    const finalSplitData = calculateDistribution(numAmount, splitMembers, expense.split_details, adjustMember, precision)

    const checkSum = (data: AmountMap) => Object.values(data).reduce((a, b) => a.plus(new Decimal(b)), new Decimal(0))
    const payerSum = checkSum(finalPayerData)
    const splitSum = checkSum(finalSplitData)
    const target = new Decimal(numAmount).toDecimalPlaces(precision)

    if (!payerSum.equals(target) || !splitSum.equals(target)) {
      console.error(`[CRITICAL_VALIDATION_ERROR] Sum mismatch. P:${payerSum}, S:${splitSum}, T:${target}`)
      // 同上：沒存成功就把鎖放掉，卡片還能重按或改用「✏️ 編輯」
      await releaseNonce(nonce)
      await replyMessage(replyToken, [{ type: 'text', text: `❌ 財務運算發生錯誤，請聯絡管理員。` }], sourceId)
      return
    }

    const { data: savedExpense } = await supabase.from('expenses').insert({
      trip_id: trip_id, description: expense.description, amount: target.toNumber(), currency: expense.currency,
      payer_data: finalPayerData, split_data: finalSplitData, date: expense.date, category: expense.category,
      photo_urls: photo_urls, adjustment_member: adjustMember
    }).select('id').single()

    // 記錄 expense_id 供文字指令「取消上一筆」使用。
    // ⚠️ 必須 await：Edge Runtime 會在回應送出後中止未完成的 promise，
    //    這一列掉了就會讓「取消上一筆」撤到更早的一筆支出（H11）。
    if (savedExpense?.id) {
      await supabase.from('line_chat_history').insert({
        line_user_id: sourceId, role: 'saved',
        content: JSON.stringify({
          expense_id: savedExpense.id,
          description: expense.description,
          by: speakerLabel,
        }),
        speaker_user_id: speakerUserId, speaker_name: speakerLabel,
      })
    }

    // 存入後附帶撤銷快速按鈕，讓使用者可即時反悔。
    // postback 只帶 eid —— 塞進描述會讓長店名超過 300 bytes，整則訊息發不出去（H12）。
    const undoItems = savedExpense?.id
      ? [{ type: "action", action: { type: "postback", label: "↩️ 撤銷", data: JSON.stringify({ act: "undo", eid: savedExpense.id }) } }]
      : []
    // 群組裡標明是誰記的，一對一就不必贅述
    const savedBy = speakerLabel ? `\n（由 ${speakerLabel} 記錄）` : ''
    await replyMessage(replyToken, [{
      type: 'text', text: `✅ 已存入：${expense.description}${savedBy}`,
      quickReply: { items: [...undoItems, ...boundQR.items] }
    }], sourceId)

  } else if (postbackData.action === 'cancel' || postbackData.act === 'cancel') {
    const nonce = postbackData.n ?? postbackData.nonce
    let photo_ids = postbackData.p ?? postbackData.photo_urls ?? []
    let trip_id = postbackData.trip_id ?? userState?.current_trip_id

    // 從 pending 取得照片資訊（用於刪除 Storage 的照片）
    if (photo_ids.length === 0 && nonce) {
      const pending = await getPendingExpense(sourceId, nonce)
      if (pending) {
        photo_ids = pending.p || []
        trip_id = pending.tid || trip_id
      }
    }

    if (nonce) {
      const { error: nonceInsertError } = await supabase
        .from('line_processed_actions')
        .insert({ nonce, line_user_id: sourceId, action_type: 'cancel' })
      if (nonceInsertError) {
        const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
        await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId); return
      }
    }

    if (photo_ids.length > 0 && trip_id) {
      const urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)
      console.log(`[PHOTO] Remove photo URL: ${urls}`)
      await supabase.storage.from(RECEIPTS_BUCKET).remove(urls)
    }

    await replyMessage(replyToken, [{ type: 'text', text: photo_ids.length > 0 ? '❌ 已取消並刪除照片。' : '❌ 已取消。' }], sourceId)
  }
}
