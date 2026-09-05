// ============================================================
// handlers/postback.ts —— Flex 卡片按鈕（postback）
//
// 六種動作：undo（撤銷已存入）、cur（換個幣別重新出卡）、del（刪除既有支出）、
// upd（套用 AI 提議的修改）、save（確認存入）、cancel（取消草稿或提議）。
//
// ⚠️ 防重複點擊的鎖是 line_processed_actions 的 PK 衝突：先寫 nonce 再做事。
//    做不成的時候一定要 releaseNonce()，不然那張卡片連「✏️ 編輯」都會說已處理過。
// ============================================================

import { Decimal } from "../../_shared/deps.ts"
import { calculateDistribution, DEFAULT_PRECISION } from "../../_shared/finance.ts"
import {
  commitExpense,
  commitExpenseUpdate,
  deleteExpense,
  resolveExpenseRef,
} from "../../_shared/tools/expenses.ts"
import { RECEIPTS_BUCKET, WEBAPP_URL } from "../config.ts"
import { type EventContext, tripToday } from "../context.ts"
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
  fieldLabel,
} from "../messages.ts"
import type { PreparedExpense, ScopedContext } from "../../_shared/tools/types.ts"
import type { PrecisionConfig } from "../../_shared/types.ts"
import type { DraftExpense, PostbackData, PostbackEvent } from "../types.ts"

/**
 * 刪除／還原只需要「哪個資料庫、哪一趟旅程」，為它們多查一次整趟旅程並不划算。
 * ctx.isBound 是呼叫端的前提，所以 current_trip_id 必定有值。
 */
function toolScope(tripId: string | null): ScopedContext {
  return { db: supabase, trip: { id: tripId as string } }
}

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
    // 軟刪除走共用工具層：旅程範圍與「已經在垃圾桶裡就不要再 UPDATE 一次」
    // 都在 deleteExpense 裡面 —— deleted_at 被刷新的話，
    // 網頁垃圾桶的 24 小時保留期會整個重算（H3）。
    const undoResult = await deleteExpense(expenseId, toolScope(userState.current_trip_id))
    const description = undoResult.description || postbackData.d || '該筆支出'

    if (!undoResult.ok) {
      const text = undoResult.reason === 'not_found'
        ? '❌ 找不到這筆支出，可能已被永久刪除，或不屬於目前綁定的旅程。'
        : undoResult.reason === 'already_deleted'
          ? `ℹ️ 「${description}」先前已經撤銷了。`
          : '❌ 撤銷失敗，請至網頁手動刪除。'
      // 「找不到」與「撤銷失敗」都是異常狀況，維持原本不附快速回覆的樣子
      const message = undoResult.reason === 'already_deleted'
        ? { type: 'text', text, quickReply: boundQR }
        : { type: 'text', text }
      await replyMessage(replyToken, [message], sourceId)
      return
    }
    await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${description}`, quickReply: boundQR }], sourceId)
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

  // 刪除既有支出。兩個來源：
  //   ①「刪除支出」清單上的按鈕（只有 eid，沒有 nonce）
  //   ② AI 的「🗑 確認刪除？」卡片（帶 nonce，要防連點）
  if (postbackData.act === 'del') {
    const expenseId = postbackData.eid
    if (!expenseId) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這筆支出。' }], sourceId)
      return
    }
    // 有 nonce 才上鎖 —— 舊清單卡沒有 nonce，行為維持原樣
    const delNonce = postbackData.n
    if (delNonce) {
      const { error: lockErr } = await supabase.from('line_processed_actions')
        .insert({ nonce: delNonce, line_user_id: sourceId, action_type: 'delete' })
      if (lockErr) {
        const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', delNonce).maybeSingle()
        await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId)
        return
      }
    }
    // 與 undo 走同一支 deleteExpense。⚠️ 這裡因此多了**旅程範圍**的保護：
    // 以前只比對 id，切換旅程後按舊清單上的按鈕會刪到別趟旅程的支出（J4）。
    const delResult = await deleteExpense(expenseId, toolScope(userState.current_trip_id))

    if (!delResult.ok) {
      // 真的只是寫入失敗時把鎖放掉，使用者才還能再按一次
      if (delResult.reason === 'update_failed') await releaseNonce(delNonce)
      if (delResult.reason === 'already_deleted') {
        await replyMessage(replyToken, [{
          type: 'text', text: `ℹ️ 「${delResult.description}」先前已經刪除了。`, quickReply: boundQR,
        }], sourceId)
      } else if (delResult.reason === 'not_found') {
        await replyMessage(replyToken, [{ type: 'text', text: '❌ 這筆支出已不存在。' }], sourceId)
      } else {
        await replyMessage(replyToken, [{ type: 'text', text: '❌ 刪除失敗，請至網頁操作。' }], sourceId)
      }
      return
    }

    const by = speakerLabel ? `（由 ${speakerLabel} 刪除）` : ''
    await replyMessage(replyToken, [{
      type: 'text',
      text: `🗑 已刪除：${delResult.description}${by}\n\n24 小時內可到網頁的垃圾桶還原。`,
      quickReply: boundQR,
    }], sourceId)
    return
  }

  // 套用 AI 提議的修改（「✏️ 修改預覽」卡片的「✅ 確認修改」）。
  //
  // ⚠️ 與 save 的差別是這條走 UPDATE 而不是 INSERT，而且**不寫 `saved` 列** ——
  //    「取消上一筆」要撤的是最近**新增**的那一筆，把修改也記進去的話，
  //    使用者說「取消上一筆」會撤掉一筆他剛改好的舊支出（與 liff-notify 的
  //    mode === 'update' 同一個理由，見 J11／M11）。
  if (postbackData.act === 'upd') {
    const updNonce = postbackData.n
    if (!updNonce) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 無效的操作資料，請重新說一次要改哪一筆。' }], sourceId)
      return
    }

    // 先上鎖再做事（防連點）。已經套用過的話這裡就會衝突。
    const { error: lockErr } = await supabase.from('line_processed_actions')
      .insert({ nonce: updNonce, line_user_id: sourceId, action_type: 'update' })
    if (lockErr) {
      const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', updNonce).maybeSingle()
      await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId)
      return
    }

    const pending = await getPendingExpense(sourceId, updNonce)
    if (!pending || pending.kind !== 'update' || !pending.eid || !pending.exp) {
      await releaseNonce(updNonce)
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這張修改卡的內容，請重新說一次要改哪一筆。' }], sourceId)
      return
    }

    const updTripId = pending.tid || userState.current_trip_id as string
    const { data: updTrip } = await supabase.from('trips').select('*').eq('id', updTripId).maybeSingle()
    if (!updTrip) {
      // 旅程被後台刪掉了，這張卡再也套不上去 —— 與 save 一致，鎖不放
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
      return
    }

    // ⚠️ 一定要**重新讀**那一筆：卡片可能是十分鐘前發的，中間有人在網頁改過或刪掉了。
    //    resolveExpenseRef 同時擋掉「不屬於這趟旅程」「已在垃圾桶」「是結清紀錄」。
    const existing = await resolveExpenseRef(pending.eid, toolScope(updTripId), { allowSettlement: false })
    if (!existing) {
      await releaseNonce(updNonce)
      await replyMessage(replyToken, [{
        type: 'text',
        text: '❌ 這筆支出已不存在（可能已被刪除，或不屬於目前這趟旅程）。',
        quickReply: boundQR,
      }], sourceId)
      return
    }

    const src = pending.exp
    const prepared: PreparedExpense = {
      description: String(src.d ?? src.description ?? ''),
      amount: parseFloat(String(src.a ?? src.amount ?? 0)) || 0,
      currency: String(src.c ?? src.currency ?? ''),
      date: String(src.dt ?? src.date ?? ''),
      category: String(src.cat ?? src.category ?? ''),
      payer_data: src.p ?? src.payer_data ?? {},
      split_details: src.s ?? src.split_details ?? {},
      adjustment_member: null,
    }

    // 封存、參與者為空與 Σ 檢查都在 commitExpenseUpdate 裡（與工具層共用同一份）
    const updResult = await commitExpenseUpdate(existing.id, prepared, {
      db: supabase, trip: updTrip, today: tripToday(updTrip), actorName: ctx.memberName,
    })
    if (!updResult.ok) {
      // 封存是「這張卡永遠套不上去」，其餘放掉鎖讓使用者還能按取消或再試
      if (updResult.reason !== 'archived') await releaseNonce(updNonce)
      const text = updResult.reason === 'archived'
        ? '❌ 此旅程已封存，無法修改支出。'
        : updResult.reason === 'not_found'
          ? '❌ 這筆支出已不存在，無法修改。'
          : updResult.reason === 'empty_participants'
            ? '😅 修改後的付款人或分攤成員是空的（可能是成員已被移除），無法套用。請按卡片上的「🌐 網頁編輯」處理。'
            : '❌ 財務運算發生錯誤，請聯絡管理員。'
      await replyMessage(replyToken, [{ type: 'text', text, quickReply: boundQR }], sourceId)
      return
    }

    // 卡片是先前發的，這中間內容可能已經變過 —— 改了哪幾欄以「剛剛真正寫進去的」為準
    const changed = ([
      ['description', existing.description, prepared.description],
      ['amount', Number(existing.amount) || 0, prepared.amount],
      ['currency', existing.currency, prepared.currency],
      ['date', existing.date, prepared.date],
      ['category', existing.category, prepared.category],
      ['payer_data', existing.payer_data ?? {}, prepared.payer_data],
      ['split_data', existing.split_data ?? {}, prepared.split_details],
    ] as [string, unknown, unknown][])
      .filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after))
      .map(([field]) => fieldLabel(field))

    const by = speakerLabel ? `（由 ${speakerLabel} 修改）` : ''
    const changedText = changed.length > 0 ? `\n改了：${changed.join('、')}` : '\n（內容與原本相同）'
    await replyMessage(replyToken, [{
      type: 'text',
      text: `✏️ 已修改：${prepared.description}${by}${changedText}`,
      quickReply: boundQR,
    }], sourceId)
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

    const { data: trip } = await supabase.from('trips').select('*').eq('id', trip_id).single()

    if (!trip) {
      // 旅程可能已被刪除（見 docs/DB_MAINTENANCE.md），此時舊卡片的按鈕不該讓整個函式崩掉。
      // ⚠️ 這一路與「已封存」都刻意**不** releaseNonce：那張卡片本來就再也存不進去了。
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId);
      return;
    }

    // 封存、成員過濾（M12）、Σ 檢查與 insert 全部在 commitExpense 裡 ——
    // 與 OCR／文字路徑的 prepareExpense 同屬一份共用工具層。
    // 卡片產生時一定填好了幣別與日期，只是短鍵／長鍵兩種來源在型別上都是選填。
    const saveResult = await commitExpense({
      description: expense.description ?? '',
      amount: parseFloat(String(expense.amount)) || 0,
      currency: String(expense.currency ?? ''),
      date: String(expense.date ?? ''),
      category: String(expense.category ?? ''),
      payer_data: expense.payer_data,
      split_details: expense.split_details,
      adjustment_member: null,
    }, {
      db: supabase, trip, today: tripToday(trip), actorName: ctx.memberName,
    }, { photoUrls: photo_urls })

    if (!saveResult.ok) {
      // 存不進去的三種情況都要把 nonce 放掉，卡片上的按鈕才還能用
      // （不然連我們自己叫使用者去按的「✏️ 編輯」都會說已處理過）。
      // 封存與旅程不見則維持現狀不放 —— 那張卡片已經沒有出路了。
      if (saveResult.reason === 'archived' || saveResult.reason === 'trip_missing') {
        const text = saveResult.reason === 'archived'
          ? '❌ 此旅程已封存，無法新增支出。'
          : '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。'
        await replyMessage(replyToken, [{ type: 'text', text }], sourceId)
        return
      }

      await releaseNonce(nonce)
      if (saveResult.reason === 'empty_participants') {
        // 卡片產生時已經補過預設值（applyParticipantDefaults），
        // 走到這裡還是空的多半是成員在存檔前被刪掉了，只能請使用者重新編輯。
        await replyMessage(replyToken, [{
          type: 'text',
          text: '😅 這筆的付款人或分攤成員是空的（可能是成員已被移除），無法存入。\n\n請按卡片上的「✏️ 編輯」補上，或直接重說一次。',
          quickReply: boundQR,
        }], sourceId)
      } else if (saveResult.reason === 'dropped_members') {
        await replyMessage(replyToken, [{
          type: 'text',
          text: `😅 這張卡片上的「${(saveResult.dropped ?? []).join('、')}」已經不在旅程成員裡了，不能就這樣存入 —— `
            + `他的那一份會被默默算到別人頭上。\n\n`
            + `目前成員：${trip.members.join('、')}\n\n`
            + `請按卡片上的「✏️ 編輯」重新分攤，或直接重說一次。`,
          quickReply: boundQR,
        }], sourceId)
      } else {
        await replyMessage(replyToken, [{ type: 'text', text: `❌ 財務運算發生錯誤，請聯絡管理員。` }], sourceId)
      }
      return
    }

    const savedExpense = { id: saveResult.id }

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

    // 從 pending 取得照片資訊（用於刪除 Storage 的照片）。
    // AI 的修改／刪除提議卡（kind: 'update' / 'delete'）沒有照片，
    // 所以下面只會上鎖並回一句「已取消」，那正是我們要的行為。
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
