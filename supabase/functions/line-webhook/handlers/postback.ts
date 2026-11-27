// ============================================================
// handlers/postback.ts —— Flex 卡片按鈕（postback）
//
// 七種動作：undo（撤銷已存入）、cur（換個幣別重新出卡）、me（改成只算按的人）、del（刪除既有支出）、
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
import { resolveMember } from "../../_shared/validate.ts"
import { buildSavedText } from "../../_shared/savedText.ts"
import { TRIP_GONE_MSG, WEBAPP_URL } from "../config.ts"
import { photos } from "../photos.ts"
import { type EventContext, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import {
  getPendingExpense,
  photoViewUrl,
  releaseNonce,
  storePendingExpense,
} from "../drafts.ts"
import { replyMessage } from "../line-api.ts"
import {
  buildDraftLiffUrl,
  buildExpenseCard,
  buildItemsLiffUrl,
  canGoSolo,
  canSplitByItems,
  describeProcessedAction,
  fieldLabel,
} from "../messages.ts"
import type { PreparedExpense, ScopedContext } from "../../_shared/tools/types.ts"
import type { PrecisionConfig, TripRow } from "../../_shared/types.ts"
import type { DraftExpense, PostbackData, PostbackEvent } from "../types.ts"

/**
 * 刪除／還原只需要「哪個資料庫、哪一趟旅程」，為它們多查一次整趟旅程並不划算。
 * ctx.isBound 是呼叫端的前提，所以 current_trip_id 必定有值。
 */
function toolScope(tripId: string | null): ScopedContext {
  return { db: supabase, trip: { id: tripId as string } }
}

type TripRecord = TripRow

/**
 * 佔用 nonce（防連點的鎖），回傳錯誤（null 代表搶到了）。
 *
 * ⚡ 速度：postback 幾乎每次都是冷啟動，每一趟資料庫往返要 0.3～1 秒，
 *    所以這支常和「讀 pending」「預先查旅程」放進同一個 Promise.all。
 */
function lockNonce(nonce: string | undefined, sourceId: string, actionType: string): Promise<unknown> {
  if (!nonce) return Promise.resolve(null)
  return Promise.resolve(supabase.from('line_processed_actions')
    .insert({ nonce, line_user_id: sourceId, action_type: actionType })
    .then((r: { error: unknown }) => r.error))
}

/** 預先查旅程（`select('*')`）。查不到或沒有 id 時是 null。 */
function fetchTrip(tripId: string | null | undefined): Promise<TripRecord | null> {
  if (!tripId) return Promise.resolve(null)
  return Promise.resolve(supabase.from('trips').select('*').eq('id', tripId).maybeSingle()
    .then((r: { data: TripRecord | null }) => r.data))
}

/** 鎖已經被佔走時，回覆「這張卡片先前已經…」 */
async function replyAlreadyProcessed(replyToken: string, nonce: string, sourceId: string): Promise<void> {
  const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
  await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId)
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

  // 「👤 只算我」有金額時直接存入（David：不要再吐一張卡）。
  // 換好的內容與已經查到的旅程直接交給下面的「確認存入」，不再另存 pending、不再重查一次。
  let soloFrom: { oldNonce: string; me: string } | null = null
  let soloSave: { exp: DraftExpense; photoIds: string[]; receipt: boolean; tripId: string; trip: TripRecord } | null = null

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
    if (!oldNonce) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新傳送收據。' }], sourceId)
      return
    }
    // 讀草稿、佔用舊 nonce（避免同一則訊息的按鈕被連按兩次而出兩張卡）、預先查旅程，同時做
    const [pending, lockErr, guessTrip] = await Promise.all([
      getPendingExpense(sourceId, oldNonce),
      lockNonce(oldNonce, sourceId, 'superseded'),
      fetchTrip(userState.current_trip_id),
    ])
    if (!pending) {
      if (!lockErr) await releaseNonce(oldNonce)
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新傳送收據。' }], sourceId)
      return
    }
    if (lockErr) {
      await replyAlreadyProcessed(replyToken, oldNonce, sourceId)
      return
    }

    // isBound 是呼叫端的前提，current_trip_id 必定有值
    const tripIdForCur = pending.tid || userState.current_trip_id as string
    const curTrip = guessTrip?.id === tripIdForCur ? guessTrip : await fetchTrip(tripIdForCur)
    if (!curTrip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。' }], sourceId)
      return
    }
    if (!Object.prototype.hasOwnProperty.call(curTrip.rates ?? {}, chosen)) {
      // 沒有換出新卡片，舊的鎖要放掉 —— 否則同一則訊息上的其他幣別按鈕與「❌ 取消」都會說已處理過
      await releaseNonce(oldNonce)
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
      p: photoIds, rc: pending.rc, tid: tripIdForCur, it: pending.it, st: pending.st,
    })
    await replyMessage(replyToken, [buildExpenseCard({
      expense: curExpense,
      title: `🔍 已改用 ${chosen}`,
      altText: `確認記帳: ${curExpense.description}`,
      heroUrl: photoIds.length > 0 ? (await photoViewUrl(photoIds[0], tripIdForCur)) || null : null,
      nonce: newNonce,
      webUrl: `${WEBAPP_URL}/#/trip/${tripIdForCur}/dashboard`,
      liffUrl: buildDraftLiffUrl(tripIdForCur, newNonce, sourceId),
      soloButton: canGoSolo(curExpense, curTrip.members),
      itemsUrl: canSplitByItems(pending.it, curTrip.members) ? buildItemsLiffUrl(tripIdForCur, newNonce, sourceId) : undefined,
    })], sourceId)
    return
  }

  // 「👤 只算我」—— 收據上只有自己的東西（個人記帳）時一鍵改成：按的人付、也只算他。
  // 跟 cur 一樣是換一張新卡：舊卡失效、內容存成新的 pending，按「確認存入」才落地。
  if (postbackData.act === 'me') {
    const oldNonce = postbackData.n
    if (!oldNonce) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，可能已經過期了。' }], sourceId)
      return
    }
    // 讀草稿、上鎖、預先查目前的旅程三件事同時做（每趟往返都要好幾百毫秒）
    const [pending, lockErr, guessTrip] = await Promise.all([
      getPendingExpense(sourceId, oldNonce),
      lockNonce(oldNonce, sourceId, 'superseded'),
      fetchTrip(userState.current_trip_id),
    ])
    if (!pending) {
      // 草稿不在了：剛剛搶到的鎖要放掉，行為與以前「先查草稿、查不到就不上鎖」一樣
      if (!lockErr) await releaseNonce(oldNonce)
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，可能已經過期了。' }], sourceId)
      return
    }
    if (lockErr) {
      await replyAlreadyProcessed(replyToken, oldNonce, sourceId)
      return
    }

    const tripIdForMe = pending.tid || userState.current_trip_id as string
    const meTrip = guessTrip?.id === tripIdForMe ? guessTrip : await fetchTrip(tripIdForMe)
    if (!meTrip) {
      await releaseNonce(oldNonce)
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。' }], sourceId)
      return
    }

    // 按按鈕的人（LINE 名稱，例如「張代杰」）對應回成員清單（「代杰」）
    const me = resolveMember(ctx.memberName, meTrip.members ?? [])
    if (!me) {
      // 沒換出新卡，舊卡的鎖要放掉，「確認存入」「✏️ 編輯」才還能用
      await releaseNonce(oldNonce)
      await replyMessage(replyToken, [{
        type: 'text',
        text: `🤔 對不到你是哪位成員（LINE 名稱：${ctx.memberName}，成員：${(meTrip.members ?? []).join('、')}）。
請按卡片上的「✏️ 編輯」自己改付款人與分攤。`,
        quickReply: boundQR,
      }], sourceId)
      return
    }

    const src = pending.exp ?? {}
    const currency = String(src.c ?? '')
    const precision = (meTrip.precision_config as PrecisionConfig | null)?.[currency] ?? DEFAULT_PRECISION[currency] ?? 2
    const amount = new Decimal(Number(src.a) || 0).toDecimalPlaces(precision).toNumber()
    const soloExpense = {
      description: src.d, amount, currency,
      date: src.dt, category: src.cat,
      payer_data: { [me]: amount },
      split_details: { [me]: amount },
    }

    const photoIds = pending.p ?? []
    const soloExp: DraftExpense = {
      d: soloExpense.description, a: amount, c: currency,
      dt: soloExpense.date, cat: soloExpense.category,
      p: soloExpense.payer_data, s: soloExpense.split_details,
    }
    if (amount > 0) {
      // 直接存：不另存 pending、不再上第二道鎖（舊卡的 nonce 剛剛已經鎖住了）
      soloFrom = { oldNonce, me }
      soloSave = { exp: soloExp, photoIds, receipt: pending.rc === true, tripId: tripIdForMe, trip: meTrip }
      postbackData = { act: 'save' }
    } else {
      const newNonce = Math.random().toString(36).substring(2, 10)
      // 新卡的 pending 與對話歷史（帶新 nonce，之後說「改成 500」AI 才找得到這張卡）同時寫，
      // 都寫好了才送卡片 —— 不然手快的人會按到一張還查不到內容的卡
      await Promise.all([
        storePendingExpense(sourceId, newNonce, {
          kind: 'expense', exp: soloExp, p: photoIds, rc: pending.rc, tid: tripIdForMe, it: pending.it, st: pending.st,
        }),
        supabase.from('line_chat_history').insert({
          line_user_id: sourceId, role: 'model',
          content: `[記帳建議] ${JSON.stringify({ ...soloExpense, photo_ids: photoIds, nonce: newNonce }, null, 2)}`,
        }),
      ])
      await replyMessage(replyToken, [buildExpenseCard({
        expense: soloExpense,
        title: `👤 改成只算 ${me}`,
        altText: `確認記帳: ${soloExpense.description}`,
        heroUrl: photoIds.length > 0 ? (await photoViewUrl(photoIds[0], tripIdForMe)) || null : null,
        nonce: newNonce,
        webUrl: `${WEBAPP_URL}/#/trip/${tripIdForMe}/dashboard`,
        liffUrl: buildDraftLiffUrl(tripIdForMe, newNonce, sourceId),
        // 照片記帳（還沒填金額）換出來的卡片一樣只能「✏️ 填金額」，不能直接存 0 元
        needsAmount: amount <= 0,
        unidentified: amount <= 0 && !String(src.d ?? '').trim(),
      })], sourceId)
      return
    }
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
    // 讀卡片內容與預先查旅程只讀不寫，跟上鎖同時做。
    const [lockErr, pending, guessTrip] = await Promise.all([
      lockNonce(updNonce, sourceId, 'update'),
      getPendingExpense(sourceId, updNonce),
      fetchTrip(userState.current_trip_id),
    ])
    if (lockErr) {
      await replyAlreadyProcessed(replyToken, updNonce, sourceId)
      return
    }

    if (!pending || pending.kind !== 'update' || !pending.eid || !pending.exp) {
      await releaseNonce(updNonce)
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這張修改卡的內容，請重新說一次要改哪一筆。' }], sourceId)
      return
    }

    const updTripId = pending.tid || userState.current_trip_id as string
    const updTrip = guessTrip?.id === updTripId ? guessTrip : await fetchTrip(updTripId)
    if (!updTrip) {
      // 旅程被後台刪掉了，這張卡再也套不上去 —— 與 save 一致，鎖不放
      await replyMessage(replyToken, [{ type: 'text', text: TRIP_GONE_MSG }], sourceId)
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
            : updResult.reason === 'dropped_members'
              ? `😅 這張修改卡上的「${(updResult.dropped ?? []).join('、')}」已經不在旅程成員裡了，不能就這樣套用。\n\n`
                + `目前成員：${(updTrip.members ?? []).join('、')}\n\n請重新說一次要怎麼改，或按「🌐 網頁編輯」。`
              : updResult.reason === 'invalid_amount'
                ? '😅 修改後的金額必須大於 0，無法套用。請重新說一次要改成多少。'
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
    const changedText = changed.length > 0 ? `改了：${changed.join('、')}` : '（內容與原本相同）'
    // 改完的完整內容也列出來（commitExpenseUpdate 照 prepared 原樣寫入）
    const updText = buildSavedText({
      description: prepared.description,
      amount: prepared.amount,
      currency: prepared.currency,
      date: prepared.date,
      category: prepared.category,
      payer_data: prepared.payer_data,
      split_data: prepared.split_details,
    }, {
      header: '✏️ 已修改',
      titleSuffix: by,
      note: changedText,
    }, (updTrip.precision_config as PrecisionConfig | null) ?? {})
    await replyMessage(replyToken, [{
      type: 'text',
      text: updText,
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
    // 舊格式的卡片（內容整包放在 postback 裡）只會來自收據辨識
    let receipt = !!(postbackData.expense || exp_new || exp_old)

    let trip: TripRecord | null = null

    if (soloSave) {
      // 「👤 只算我」直接存：內容與旅程上面都備好了，不必再查
      expenseRaw = soloSave.exp
      photo_ids = soloSave.photoIds
      receipt = soloSave.receipt
      trip_id = soloSave.tripId
      trip = soloSave.trip
    } else {
      // 讀草稿、上鎖、預先查目前的旅程三件事同時做（每趟往返都要好幾百毫秒）
      const needsPending = !expenseRaw && !!nonce
      const [pending, nonceInsertError, guessTrip] = await Promise.all([
        needsPending ? getPendingExpense(sourceId, nonce as string) : Promise.resolve(null),
        lockNonce(nonce, sourceId, 'save'),
        fetchTrip(trip_id),
      ])
      if (pending) {
        expenseRaw = pending.exp
        photo_ids = pending.p || []
        receipt = pending.rc === true
        trip_id = pending.tid || trip_id
      }

      if (!expenseRaw) {
        // 以前是先查草稿、查不到就不上鎖；現在一起做，搶到的鎖要放掉
        if (nonce && !nonceInsertError) await releaseNonce(nonce)
        await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新記帳。' }], sourceId); return
      }

      if (nonce && nonceInsertError) {
        // 查詢 action_type，給予更明確的重複操作提示
        await replyAlreadyProcessed(replyToken, nonce, sourceId); return
      }

      // 草稿是在別趟旅程記的（中途切換過）才需要再查一次
      trip = guessTrip?.id === trip_id ? guessTrip : await fetchTrip(trip_id)
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

    if (!trip) {
      // 旅程可能已被刪除（見 docs/DB_MAINTENANCE.md），此時舊卡片的按鈕不該讓整個函式崩掉。
      // ⚠️ 這一路與「已封存」都刻意**不** releaseNonce：那張卡片本來就再也存不進去了。
      await replyMessage(replyToken, [{ type: 'text', text: TRIP_GONE_MSG }], sourceId);
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
    }, { photoUrls: photo_urls, receiptPhotoUrls: receipt ? photo_urls : [] })

    if (!saveResult.ok) {
      // 存不進去的三種情況都要把 nonce 放掉，卡片上的按鈕才還能用
      // （不然連我們自己叫使用者去按的「✏️ 編輯」都會說已處理過）。
      // 封存與旅程不見則維持現狀不放 —— 那張卡片已經沒有出路了。
      if (saveResult.reason === 'archived' || saveResult.reason === 'trip_missing') {
        const text = saveResult.reason === 'archived'
          ? '❌ 此旅程已封存，無法新增支出。'
          : TRIP_GONE_MSG
        await replyMessage(replyToken, [{ type: 'text', text }], sourceId)
        return
      }

      await releaseNonce(nonce)
      // 只算我直接存失敗：原本那張卡要能再按（「✏️ 編輯」等），不然使用者會卡住
      if (soloFrom) await releaseNonce(soloFrom.oldNonce)
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
      } else if (saveResult.reason === 'invalid_amount') {
        await replyMessage(replyToken, [{
          type: 'text',
          text: '😅 這筆的金額是 0（可能沒辨識到金額），不能存入。\n\n請按卡片上的「✏️ 編輯」補上金額，或直接重說一次，例如「晚餐 300」。',
          quickReply: boundQR,
        }], sourceId)
      } else if (saveResult.reason === 'insert_failed') {
        await replyMessage(replyToken, [{
          type: 'text', text: '❌ 寫入資料庫失敗，這筆還沒存進去。請稍後再按一次「確認存入」。', quickReply: boundQR,
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
    //    ⚡ 但不必等它寫完才回覆 —— 下面跟回覆放進同一個 Promise.all。
    const bookkeeping: PromiseLike<unknown>[] = []
    if (savedExpense?.id) {
      bookkeeping.push(supabase.from('line_chat_history').insert({
        line_user_id: sourceId, role: 'saved',
        content: JSON.stringify({
          expense_id: savedExpense.id,
          description: expense.description,
          by: speakerLabel,
        }),
        speaker_user_id: speakerUserId, speaker_name: speakerLabel,
      }))
    }
    // 只算我直接存成功：舊卡的鎖從「被取代」改成「已存入」，
    // 再按一次才會說「已存入」，而不是叫人去按一張根本沒出現的新卡
    if (soloFrom) {
      bookkeeping.push(supabase.from('line_processed_actions')
        .update({ action_type: 'save' }).eq('nonce', soloFrom.oldNonce))
    }

    // 存入後附帶撤銷快速按鈕，讓使用者可即時反悔。
    // postback 只帶 eid —— 塞進描述會讓長店名超過 300 bytes，整則訊息發不出去（H12）。
    const undoItems = savedExpense?.id
      ? [{ type: "action", action: { type: "postback", label: "↩️ 撤銷", data: JSON.stringify({ act: "undo", eid: savedExpense.id }) } }]
      : []
    // 回覆列出真正寫進去的內容（commitExpense 依成員與精度重算過的付款人與分攤），
    // 只算我也是這一則 —— 不另外再吐一張卡（David）
    const savedText = buildSavedText({
      description: expense.description,
      amount: saveResult.amount,
      currency: String(expense.currency ?? ''),
      date: expense.date,
      category: expense.category,
      payer_data: saveResult.payer_data,
      split_data: saveResult.split_data,
    }, {
      header: '✅ 已存入',
      titleSuffix: soloFrom ? `（只算 ${soloFrom.me}）` : '',
      // 群組裡標明是誰記的，一對一就不必贅述
      footer: speakerLabel ? `（由 ${speakerLabel} 記錄）` : undefined,
    }, (trip.precision_config as PrecisionConfig | null) ?? {})
    await Promise.all([
      ...bookkeeping,
      replyMessage(replyToken, [{
        type: 'text', text: savedText,
        quickReply: { items: [...undoItems, ...boundQR.items] }
      }], sourceId),
    ])

  } else if (postbackData.action === 'cancel' || postbackData.act === 'cancel') {
    const nonce = postbackData.n ?? postbackData.nonce
    let photo_ids = postbackData.p ?? postbackData.photo_urls ?? []
    let trip_id = postbackData.trip_id ?? userState?.current_trip_id

    // 從 pending 取得照片資訊（用於刪除 Storage 的照片）。
    // AI 的修改／刪除提議卡（kind: 'update' / 'delete'）沒有照片，
    // 所以下面只會上鎖並回一句「已取消」，那正是我們要的行為。
    // 讀草稿（只讀不寫）與上鎖同時做
    const [pending, nonceInsertError] = await Promise.all([
      photo_ids.length === 0 && nonce ? getPendingExpense(sourceId, nonce) : Promise.resolve(null),
      lockNonce(nonce, sourceId, 'cancel'),
    ])
    if (pending) {
      photo_ids = pending.p || []
      trip_id = pending.tid || trip_id
    }
    if (nonce && nonceInsertError) {
      await replyAlreadyProcessed(replyToken, nonce, sourceId); return
    }

    // 刪照片與回覆同時送（都 await，Edge Runtime 回應後會中止沒做完的 promise）
    const removePhotos = async () => {
      if (photo_ids.length === 0 || !trip_id) return
      const urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)
      console.log(`[PHOTO] Remove photo URL: ${urls}`)
      await photos.remove(urls)
    }
    await Promise.all([
      removePhotos(),
      replyMessage(replyToken, [{ type: 'text', text: photo_ids.length > 0 ? '❌ 已取消並刪除照片。' : '❌ 已取消。' }], sourceId),
    ])
  }
}
