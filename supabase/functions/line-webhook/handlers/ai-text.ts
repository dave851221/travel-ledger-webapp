// ============================================================
// handlers/ai-text.ts —— AI 核心（function calling）
//
// 走到這裡代表沒有任何明確指令認領這句話。查旅程、近期支出、對話歷史與
// 一行「今天的行程」組成 context，交給 `ai.runToolLoop()`（用哪一家見 ai.ts）。
// 其餘資料一律讓模型自己用工具查（帳務、彙總、行程、天氣；Claude 還能上網搜尋）——
// 每則訊息都把整趟的彙總與行程塞進去既貴又會稀釋重點。
// 最後一定要呼叫一支「終結函式」，這裡再依它決定送什麼出去：
//
//   propose_expenses       一到四張待確認的記帳卡片
//   propose_expense_update 「✏️ 修改預覽」卡（按了才 UPDATE）
//   propose_expense_delete 「🗑 確認刪除？」卡（按了才軟刪除）
//   analyze_receipt        重新閱讀某一筆的收據照片並回答
//   reply                  一般聊天／查詢
//   stay_silent            群組裡的「接話」其實不是在跟機器人講話 → 不回（只有接話才給這支）
//
// ⚠️ **模型不能直接改資料庫**：公開給它的只有唯讀工具與「提議」，
//    真正的寫入一律要使用者按下卡片上的按鈕（handlers/postback.ts）。
// ⚠️ 金額類的回答一律引用 get_trip_summary —— 那是伺服器用 Decimal 算好的（M6）；
//    彙總沒涵蓋的角度才叫模型去 list_expenses。
// ============================================================

import { formatAmountDisplay } from "../../_shared/finance.ts"
import {
  buildConversation,
  buildTripContext,
  draftRetryHint,
  findExpenseByRef,
  type HistoryTurn,
  loadRecentExpenses,
  loadTripSummary,
  photoDraftHint,
  prepareProposedExpenses,
  prepareProposedUpdate,
  type RecentExpense,
  RECENT_EXPENSE_COLUMNS,
  REF_NOT_FOUND_TEXT,
  sanitizeReplyText,
  chooseReceiptExpense,
} from "../../_shared/assistant/chat.ts"
import { optionalString } from "../../_shared/tools/args.ts"
import { expenseRef } from "../../_shared/tools/expenses.ts"
import { runTool } from "../../_shared/tools/registry.ts"
import { mentionsDraftField } from "../guards.ts"
import {
  aiUnavailableMessage,
  CHAT_HISTORY_TURNS,
  FALLBACK_NOTICES,
  GOOGLE_MAPS_API_KEY,
  TRIP_GONE_MSG,
  WEB_SEARCH_MAX_USES,
  WEBAPP_URL,
} from "../config.ts"
import { type EventContext, extendFollowup, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import { type OutstandingDraft, photoViewUrl, storePendingExpense, supersedeDraft } from "../drafts.ts"
import {
  ai,
  analyzeReceiptPhoto,
  fetchPhotoPart,
  FOLLOWUP_TERMINAL_NAMES,
  FOLLOWUP_TOOL_DECLARATIONS,
  READ_TOOL_NAMES,
  STAY_SILENT_TOOL,
  TERMINAL_TOOL_NAMES,
  TEXT_TOOL_DECLARATIONS,
  TRIP_SUMMARY_TOOL,
  YOSHI_SYSTEM_INSTRUCTION,
} from "../ai.ts"
import { loadItinerary } from "../itinerary.ts"
import { chargeAi } from "../quota.ts"
import { pushMessage, replyMessage, showLoading } from "../line-api.ts"
import {
  buildDeleteConfirmCard,
  buildDraftLiffUrl,
  buildEditLiffUrl,
  buildExpenseCard,
  buildItemsLiffUrl,
  canGoSolo,
  canSplitByItems,
  buildUpdatePreviewCard,
  GROUP_MODE_INFO,
  replyEditPicker,
  buildPlacesFlex,
} from "../messages.ts"
import { runInBackground } from "../util.ts"
import { countryForTimezone } from "../../_shared/tools/weather.ts"
import type { ToolArgs, ToolContext } from "../../_shared/tools/types.ts"
import type { TripRow } from "../../_shared/types.ts"
import type {
  AiMessage,
  ChatHistoryRow,
  OutgoingMessage,
  TextRoute,
} from "../types.ts"

/**
 * 整個 AI 迴圈的截止時間，從 **LINE 送出事件的那一刻**起算（不是函式啟動的時間）。
 * replyToken 大約一分鐘後失效，留 15 秒給送出訊息與資料庫寫入。
 */
const AI_DEADLINE_MS = 45_000

/** 補問一次「這句是不是在改草稿」至少要剩這麼多時間，不夠就照第一次的回答送出 */
const DRAFT_RETRY_MIN_MS = 15_000

/** LINE 一次 reply 最多送 5 則訊息。卡片前面那一則文字也算在內。 */
const MAX_REPLY_MESSAGES = 5

/** 各個終結分支共用的東西，省得每一支都掛十個參數 */
interface AiScope {
  ctx: EventContext
  trip: TripRow
  tripId: string
  today: string
  cleanText: string
  precision: Record<string, number>
  outstandingDrafts: OutstandingDraft[]
  /** 改由備援回答時放在回覆最前面的一句話（FALLBACK_NOTICES） */
  notice?: string
  /** 模型看過的文字（對話 + 工具結果），回覆裡的地圖網址要在這裡出現過才算數 */
  seenText: string[]
}

/** 所有終結分支都從這裡回覆，備援通知才不會漏掉哪一支 */
function reply(scope: AiScope, messages: OutgoingMessage[]): Promise<void> {
  return replyMessage(scope.ctx.replyToken, withNotice(scope.notice, messages), scope.ctx.sourceId)
}

/** 通知併進第一則文字；第一則是卡片就自己一則（LINE 一次最多 5 則） */
export function withNotice(notice: string | undefined, messages: OutgoingMessage[]): OutgoingMessage[] {
  if (!notice) return messages
  const [first, ...rest] = messages
  if (first?.type === 'text') return [{ ...first, text: `${notice}\n\n${first.text}` }, ...rest]
  return [{ type: 'text', text: notice }, ...messages].slice(0, MAX_REPLY_MESSAGES)
}

function newNonce(): string {
  return Math.random().toString(36).substring(2, 10)
}

/** 交給 AI。呼叫端已經確認 ctx.isBound，而且沒有任何指令認領這句話。 */
export async function handleAiText(ctx: EventContext, route: TextRoute): Promise<void> {
  const { memberName, replyToken, sourceId, speakerLabel, speakerUserId, userState } = ctx
  const { cleanText } = route
  const tripId = userState.current_trip_id as string
  const loadDrafts = ctx.loadDrafts
  const isFollowup = route.trigger === 'followup'

  // 一對一顯示「輸入中…」。不等它 —— 那只是一個動畫，不該拖慢回覆
  runInBackground(showLoading(sourceId))

  const [{ data: trip }, recentExpenses, { data: history }, itinerary, outstandingDrafts] = await Promise.all([
    supabase.from('trips').select('*').eq('id', tripId).single(),
    loadRecentExpenses(supabase, tripId),
    // 排除 pending/saved 內部記錄，只取對話歷史。
    // ⚠️ 必須用 descending 取「最近的 N 筆」，之後再反轉回時間順序。
    //    寫成 ascending + limit 會永遠拿到史上最舊的那幾筆，AI 會一直停留在很久以前的內容。
    // speaker_name 要一起撈：群組整串歷史是共用的，少了它 AI 分不出「我付的」是誰講的（L15、M17）。
    supabase.from('line_chat_history').select('role, content, speaker_name').eq('line_user_id', sourceId).in('role', ['user', 'model']).order('created_at', { ascending: false }).limit(CHAT_HISTORY_TURNS),
    // 沒有行程頁的旅程是 null（見 itinerary.ts，有快取）
    loadItinerary(tripId),
    // 記憶化的，路由層查過就直接回（見 context.ts）
    loadDrafts(),
  ])
  // 旅程可能已被後台刪除（見 docs/DB_MAINTENANCE.md）。
  // 以前這裡直接讀 trip.name，整個 event 丟出例外 → 500 → LINE 會重送同一則訊息（M5）。
  if (!trip) {
    await replyMessage(replyToken, [{
      type: 'text', text: TRIP_GONE_MSG,
    }], sourceId)
    return
  }

  // 開放版：先扣這趟的 AI 次數，用完就回說明、不叫 AI
  if (!(await chargeAi(ctx, tripId, 'text'))) return

  // 不阻塞主流程，但交給 waitUntil 保證回應送出後仍寫得完。
  // 接話的訊息要等 AI 判斷完才寫：它決定不回的話，那句話只是群組裡的閒聊，不該進對話歷史。
  const recordUserTurn = () => runInBackground(supabase.from('line_chat_history').insert({
    line_user_id: sourceId, role: 'user', content: cleanText,
    speaker_user_id: speakerUserId, speaker_name: speakerLabel,
  }))
  if (!isFollowup) recordUserTurn()

  // 舊紀錄的清理已改由資料庫的 pg_cron 排程負責（每天一次，見
  // supabase/migrations/20260903_cron_purge_line_history.sql）。

  const today = tripToday(trip)
  const contextPrecision = (trip.precision_config ?? {}) as Record<string, number>

  // 群組才有模式。「照片怎麼沒反應」「為什麼要 @ 你」這類問題要靠這一行回答 ——
  // 靜音模式下照片根本沒進到機器人，不給它這一行，它只能亂猜是辨識失敗。
  const modeInfo = GROUP_MODE_INFO[ctx.groupMode]
  const groupModeLine = ctx.isGroup
    ? `
【群組模式】${modeInfo.name}：${modeInfo.summary}。`
      + `使用者問照片為什麼沒反應、為什麼要 @ 你時，照這個說明回答；`
      + `要換模式可以按下方的模式按鈕，或輸入「模式:提及模式」「模式:全回應模式」「模式:靜音模式」。`
    : ''

  // 旅程 context 與多輪對話的組法與網頁聊天共用（_shared/assistant/chat.ts）
  const tripContext = buildTripContext({
    trip, today, memberName, itinerary, recentExpenses, drafts: outstandingDrafts, channelNote: groupModeLine,
  })
  // 查詢是新到舊，這裡反轉回舊到新才符合對話順序
  const conversation = buildConversation(
    tripContext,
    [...(history ?? [])].reverse() as ChatHistoryRow[] as HistoryTurn[],
    isFollowup
      ? `【這句話沒有叫你】是 ${memberName} 在你剛回覆完之後接著說的，可能是在跟群組裡的其他人聊天。`
        + `如果明顯不是在跟你講話，或只是笑、附和、道謝（「哈哈」「好喔」「謝謝」）而沒有要你做什麼，呼叫 ${STAY_SILENT_TOOL}；`
        + `有在問你、要你查或記東西，就照常回答。\n\n${cleanText}`
      : cleanText,
  )

  // 如果聊天室裡還有一張沒被確認／取消的收據草稿，把那張收據一起送給 AI。
  const photoDraft = outstandingDrafts.find(d => d.photoIds.length > 0) ?? null
  let attachedPhoto = false
  if (photoDraft) {
    const part = await fetchPhotoPart(await photoViewUrl(photoDraft.photoIds[0], photoDraft.tripId))
    if (part) {
      const lastTurn = conversation[conversation.length - 1]
      lastTurn.parts.unshift({ text: photoDraftHint(photoDraft) })
      lastTurn.parts.push(part)
      attachedPhoto = true
    }
  }

  const toolCtx: ToolContext = {
    db: supabase, trip, today, actorName: memberName,
    loadItinerary: () => loadItinerary(tripId),
    placesApiKey: GOOGLE_MAPS_API_KEY || undefined,
  }
  const scope: AiScope = {
    ctx, trip, tripId, today, cleanText,
    precision: contextPrecision,
    outstandingDrafts,
    seenText: conversation.flatMap((m) => m.parts.map((part) => ('text' in part ? part.text : ''))),
  }

  // 上網搜尋時給個大概的位置（「附近的拉麵」）：今天行程所在的城市與旅程時區
  const timezone = trip.timezone ?? itinerary?.timeZone ?? undefined
  const searchLocation = {
    city: itinerary?.days.find((d) => d.date === today)?.city,
    country: timezone ? countryForTimezone(timezone) : undefined,
    timezone,
  }

  const runLoop = (messages: AiMessage[], webSearch: boolean) => ai.runToolLoop({
    // 有附收據時改用視覺模型
    task: attachedPhoto ? 'vision' : 'text',
    messages,
    system: YOSHI_SYSTEM_INSTRUCTION,
    declarations: isFollowup ? FOLLOWUP_TOOL_DECLARATIONS : TEXT_TOOL_DECLARATIONS,
    terminalNames: isFollowup ? FOLLOWUP_TERMINAL_NAMES : TERMINAL_TOOL_NAMES,
    // ⚠️ 只讓模型執行唯讀工具。寫入類的 create／update／delete_expense 雖然
    //    在 registry 裡，但沒有公開給它，這裡再擋一次 —— 名字是模型給的字串。
    execute: async (name: string, args: ToolArgs) => {
      if (name === TRIP_SUMMARY_TOOL) return loadTripSummary(supabase, trip)
      if (!READ_TOOL_NAMES.includes(name)) {
        return { error: `Tool ${name} is not available here` }
      }
      const output = await runTool(name, args, toolCtx)
      scope.seenText.push(JSON.stringify(output))
      return output
    },
    // 查行程、查帳、上網可能要好幾輪；時間不夠時 deadline 會強迫收尾
    maxRounds: 4,
    // ⚠️ 以 LINE 送出事件的時間為準：排隊延遲也要算進去
    deadlineAt: ctx.eventTimestamp + AI_DEADLINE_MS,
    temperature: 0.4,
    // 只有 Claude 會用（Gemini 忽略）。接話的訊息不給：多半只是閒聊，不值得花搜尋的錢
    webSearch: webSearch ? { maxUses: WEB_SEARCH_MAX_USES, location: searchLocation } : undefined,
    onFallback: (reason) => { scope.notice = FALLBACK_NOTICES[reason] },
  })

  try {
    let result = await runLoop(conversation, !isFollowup)

    // 防線：草稿還在、這句話聽起來是在補付款人／分攤／日期，模型卻只用 reply 回文字 ——
    // 卡片沒換，按「確認存入」寫進去的仍是舊內容。帶著提醒再問一次（時間夠的話）。
    // 模型仍然可以選 reply（例如那其實是一句閒聊），這裡不強迫。
    if (result.call.name === 'reply' && outstandingDrafts.length > 0 && mentionsDraftField(cleanText)
      && ctx.eventTimestamp + AI_DEADLINE_MS - Date.now() > DRAFT_RETRY_MIN_MS) {
      console.log(`[GUARD] Reply while a draft is outstanding, asking again: "${cleanText.substring(0, 80)}"`)
      const hint = draftRetryHint(outstandingDrafts.map(d => d.nonce))
      const retryConversation = conversation.map((m, i) => i === conversation.length - 1
        ? { ...m, parts: [...m.parts, { text: hint }] }
        : m)
      const retried = await runLoop(retryConversation, false)
      if (retried.call.name === 'propose_expenses') result = retried
    }

    console.log(`[AI] ${result.model} → ${result.call.name}`)
    const { args, name } = result.call
    if (name === STAY_SILENT_TOOL) {
      console.log(`[AI] Follow-up was not addressed to the bot, staying silent: "${cleanText.substring(0, 80)}"`)
      return
    }
    if (isFollowup) recordUserTurn()
    switch (name) {
      case 'propose_expenses':
        await proposeExpenses(scope, args, result.extraText)
        break
      case 'propose_expense_update':
        await proposeExpenseUpdate(scope, args, result.extraText)
        break
      case 'propose_expense_delete':
        await proposeExpenseDelete(scope, args, result.extraText)
        break
      case 'analyze_receipt':
        await analyzeReceipt(scope, args)
        break
      default:
        await plainReply(scope, args)
    }
    // 回覆過了，同一個人接下來幾分鐘的話不必再 @（群組的提及模式才有作用）
    extendFollowup(ctx)
  } catch (e) {
    console.error('[AI_ERROR]', e)
    // 接話本來就可能不是在跟機器人講話，出錯就安靜，不要在群組裡冒出一句錯誤訊息
    if (isFollowup) return
    const msg = aiUnavailableMessage(e) ?? '😵 AI 處理時發生錯誤，請稍後再試。'
    await reply(scope, [{ type: 'text', text: msg }])
  }
}

// ============================================================
// 終結分支
// ============================================================

/**
 * 一到四張待確認的記帳卡片。
 *
 * 驗證（成員、逐項分、幣別、金額）在共用的 `prepareProposedExpenses()`（網頁聊天同一份），
 * 這裡只負責 LINE 這一側：每筆各自一個 nonce、各自一列 pending、畫 Flex 卡片 ——
 * 「午餐 300 晚餐 500」出兩張卡，兩張都能獨立確認或取消（C8）。
 */
async function proposeExpenses(scope: AiScope, args: ToolArgs, extraText?: string): Promise<void> {
  const { ctx, trip, tripId, today, cleanText, outstandingDrafts } = scope
  const { boundQR, memberName, replyToken, sourceId } = ctx

  const outcome = prepareProposedExpenses(args, {
    trip, today, memberName, cleanText, drafts: outstandingDrafts, extraText,
  })
  if (outcome.kind === 'edit_existing') {
    // 模型本來就該改用 propose_expense_update，這裡是它沒照做時的保險：改列已存檔紀錄的編輯清單
    await replyEditPicker({
      tripId, sourceId, replyToken, boundQR,
      notice: '看起來你想改已經存入的紀錄。如果其實是要新記一筆，請不要用「改」來描述。',
    })
    return
  }
  if (outcome.kind === 'message') {
    await reply(scope, [{ type: 'text', text: outcome.text, quickReply: boundQR }])
    return
  }
  const { proposals, notes, correctedDraft } = outcome

  const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
  const cards: OutgoingMessage[] = []
  const pendingWrites: Promise<unknown>[] = []
  const historyRows: { line_user_id: string; role: string; content: string }[] = []

  for (const { expense, photoIds, receipt, items, subtotal } of proposals) {
    const nonce = newNonce()
    // 摘要要帶 nonce，AI 下一輪才有辦法指名它要修正哪一張
    historyRows.push({
      line_user_id: sourceId, role: 'model',
      content: `[記帳建議] ${JSON.stringify({ ...expense, nonce }, null, 2)}`,
    })
    pendingWrites.push(storePendingExpense(sourceId, nonce, {
      kind: 'expense',
      exp: {
        d: expense.description, a: expense.amount, c: expense.currency,
        dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details,
      },
      p: photoIds, rc: receipt, tid: tripId,
      // 品項明細跟著收據走：只有第一筆、而且是在修正那張收據時才沿用
      it: items.length > 0 ? items : undefined,
      st: subtotal,
    }))
    cards.push(buildExpenseCard({
      expense,
      title: '🤖 AI 記帳預覽',
      altText: `確認記帳: ${expense.description}`,
      heroUrl: photoIds.length > 0 ? (await photoViewUrl(photoIds[0], trip.id)) || null : null,
      nonce,
      webUrl,
      // 草稿卡片的「✏️ 編輯」只帶 nonce，完整內容 LiffEdit 自己去 pending 列撈（T2）
      liffUrl: buildDraftLiffUrl(trip.id, nonce, sourceId),
      soloButton: canGoSolo(expense, trip.members),
      itemsUrl: canSplitByItems(items, trip.members) ? buildItemsLiffUrl(trip.id, nonce, sourceId) : undefined,
    }))
  }

  // ⚠️ 全部併成**一則**文字：LINE 一次只能回 5 則，4 張卡片已經佔掉 4 則。
  const leadText: OutgoingMessage[] = notes.length > 0
    ? [{ type: 'text', text: notes.join('\n') }]
    : []

  runInBackground(supabase.from('line_chat_history').insert(historyRows))

  // 修正草稿時會送出新卡片，被修正的那一張必須先失效，否則按舊的「確認存入」會寫進未修正的金額。
  // ⚠️ 只失效被指名的那一張 —— 連續記多筆、群組裡多人同時記帳時，其他人的卡片必須留著（H1）。
  if (correctedDraft) await supersedeDraft(sourceId, correctedDraft.nonce)

  // storePendingExpense 與 replyMessage 並行執行，縮短回覆延遲
  await Promise.all([
    ...pendingWrites,
    reply(scope, [...leadText, ...cards].slice(0, MAX_REPLY_MESSAGES)),
  ])
}

/**
 * 「✏️ 修改預覽」卡片。
 *
 * ⚠️ 這裡**只算不寫**：`prepareProposedUpdate()` 把改完之後的完整內容與異動清單算出來，
 *    真正的 UPDATE 在使用者按下按鈕之後才發生（handlers/postback.ts 的 `act: 'upd'`）。
 */
async function proposeExpenseUpdate(scope: AiScope, args: ToolArgs, extraText?: string): Promise<void> {
  const { ctx, trip, tripId, today, cleanText, precision } = scope
  const { boundQR, memberName, sourceId } = ctx

  const outcome = prepareProposedUpdate(await findExpenseByRef(supabase, tripId, args.expense_ref), args, {
    trip, today, memberName, cleanText, extraText,
  })
  if (outcome.kind === 'message') {
    await reply(scope, [{ type: 'text', text: outcome.text, quickReply: boundQR }])
    return
  }
  const { result, existing, notes } = outcome

  const expense = result.expense
  const nonce = newNonce()
  const ref = expenseRef(existing.id)

  runInBackground(supabase.from('line_chat_history').insert({
    line_user_id: sourceId, role: 'model',
    content: `[修改建議 ${ref}] ${existing.description}：`
      + result.changes.map(c => `${c.field} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join('；'),
  }))

  const leadText: OutgoingMessage[] = notes.length > 0 ? [{ type: 'text', text: notes.join('\n') }] : []

  await Promise.all([
    storePendingExpense(sourceId, nonce, {
      kind: 'update',
      eid: existing.id,
      exp: {
        d: expense.description, a: expense.amount, c: expense.currency,
        dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details,
      },
      tid: tripId,
    }),
    reply(scope, [...leadText, buildUpdatePreviewCard({
      existing: {
        id: existing.id,
        description: existing.description,
        date: existing.date,
        // 卡片上的「原本」金額照旅程精度顯示，不然 USD 會出現一長串小數
        amount: formatAmountDisplay(existing.amount, existing.currency, precision),
        currency: existing.currency,
      },
      changes: result.changes,
      nonce,
      // 開的是**原內容**：LiffEdit 每次都直接查 DB（T2），沒辦法預填這裡提議的值
      editUrl: buildEditLiffUrl(existing, tripId, sourceId),
    })]),
  ])
}

/** 「🗑 確認刪除？」卡片。真正的軟刪除在 `act: 'del'`。 */
async function proposeExpenseDelete(scope: AiScope, args: ToolArgs, extraText?: string): Promise<void> {
  const { ctx, tripId, precision } = scope
  const { boundQR, sourceId } = ctx

  const existing = await findExpenseByRef(supabase, tripId, args.expense_ref)
  if (!existing) {
    await reply(scope, [{ type: 'text', text: REF_NOT_FOUND_TEXT, quickReply: boundQR }])
    return
  }

  const nonce = newNonce()
  const ref = expenseRef(existing.id)
  runInBackground(supabase.from('line_chat_history').insert({
    line_user_id: sourceId, role: 'model',
    content: `[刪除建議 ${ref}] ${existing.description} ${existing.amount} ${existing.currency}（等待使用者確認）`,
  }))

  const leadText: OutgoingMessage[] = extraText ? [{ type: 'text', text: extraText }] : []

  await Promise.all([
    storePendingExpense(sourceId, nonce, { kind: 'delete', eid: existing.id, tid: tripId }),
    reply(scope, [...leadText, buildDeleteConfirmCard({
      existing: {
        id: existing.id,
        description: existing.description,
        date: existing.date,
        amount: formatAmountDisplay(existing.amount, existing.currency, precision),
        currency: existing.currency,
        category: existing.category,
      },
      nonce,
    })]),
  ])
}

/** 一般聊天／查詢的回覆 */
async function plainReply(scope: AiScope, args: ToolArgs): Promise<void> {
  const { ctx } = scope
  const { boundQR, sourceId } = ctx
  // 假完成宣稱、沒查過的地圖連結、過長都在 sanitizeReplyText 處理（網頁聊天共用）
  const safeContent = sanitizeReplyText(args.text, scope.seenText.join('\n'))
  runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: safeContent }))
  // 推薦地點（兩個以上）畫成一張卡片：店名＋評分／距離，按鈕開地圖，不再貼一長串網址（David 2026-11-27）
  const places = buildPlacesFlex(safeContent)
  if (places) {
    await reply(scope, places.intro ? [{ type: 'text', text: places.intro }, { ...places.flex, quickReply: boundQR }] : [{ ...places.flex, quickReply: boundQR }])
    return
  }
  await reply(scope, [{ type: 'text', text: safeContent, quickReply: boundQR }])
}

/**
 * 重新閱讀某一筆的收據照片並回答問題。
 *
 * 兩段式：先用模型給的 ref 直接對回那一筆（最常見）；對不上就退回全庫搜尋 ——
 * 先在程式端用店名比對，仍然不唯一才多叫一次模型從清單裡挑（T4）。
 */
async function analyzeReceipt(scope: AiScope, args: ToolArgs): Promise<void> {
  const { ctx, tripId, cleanText, precision } = scope
  const { boundQR, sourceId } = ctx
  const question = optionalString(args.question) ?? '請詳細描述此收據的所有品項與金額'

  const label = (e: RecentExpense) =>
    `${e.description} ${formatAmountDisplay(e.amount, e.currency, precision)} ${e.currency}`

  /** 把選定的那一筆的**所有**收據照片一起送去分析並回覆 */
  const analyzeChosen = async (chosen: RecentExpense) => {
    const urls: string[] = (await Promise.all((chosen.photo_urls ?? []).map((path: string) => photoViewUrl(path, tripId)))).filter(Boolean)
    const content = await analyzeReceiptPhoto(urls, question, label(chosen))
    // 開頭標明分析的是哪一筆，使用者才看得出有沒有挑錯
    const answer = `🔍 ${chosen.date} ${label(chosen)}\n\n${content}`
    // 歷史加上支出標記，下一輪追問（「那第二項是什麼」）才有指代對象
    runInBackground(supabase.from('line_chat_history').insert({
      line_user_id: sourceId, role: 'model',
      content: `[收據分析 ${expenseRef(String(chosen.id ?? ''))}] ${content}`,
    }))
    await pushMessage(sourceId, [{ type: 'text', text: answer.substring(0, 4900), quickReply: boundQR }])
  }

  // ① 先用 ref 直接對回那一筆（模型只要抄 8 個字元，抄錯的空間很小，T4）
  const byRef = await findExpenseByRef(supabase, tripId, args.expense_ref)
  const refPick = byRef && (byRef.photo_urls?.length ?? 0) > 0 ? byRef as RecentExpense : null

  if (refPick) {
    await reply(scope, [{ type: 'text', text: '🔍 正在重新分析收據照片，請稍候...' }])
    try {
      await analyzeChosen(refPick)
    } catch (photoErr) {
      console.error('[ANALYZE_PHOTO_ERROR]', photoErr)
      await pushMessage(sourceId, [{ type: 'text', text: '😵 無法重新分析照片，請稍後再試。', quickReply: boundQR }])
    }
    return
  }

  // ② ref 沒填或對不上 → 全庫找有照片的支出
  await reply(scope, [{ type: 'text', text: '🔍 正在查詢符合描述的支出紀錄...' }])
  try {
    const { data: allExpenses } = await supabase.from('expenses')
      .select(RECENT_EXPENSE_COLUMNS)
      .eq('trip_id', tripId)
      .is('deleted_at', null)
      .not('is_settlement', 'is', true)
      .order('date', { ascending: false })

    const withPhotos = (allExpenses ?? []).filter((e: RecentExpense) => e.photo_urls?.length > 0)

    if (withPhotos.length === 0) {
      await pushMessage(sourceId, [{ type: 'text', text: '😅 此旅程中找不到任何帶有收據照片的支出紀錄。', quickReply: boundQR }])
      return
    }

    // 店名比對、仍不唯一才叫模型從清單挑（_shared/assistant/chat.ts，網頁聊天共用）
    const chosen = await chooseReceiptExpense(ai, withPhotos, { question, cleanText, precision })

    if (!chosen) {
      await pushMessage(sourceId, [{ type: 'text', text: '😅 找不到符合描述的收據照片，請試著描述得更詳細一點，例如加上日期、店名或金額。', quickReply: boundQR }])
      return
    }

    await pushMessage(sourceId, [{ type: 'text', text: `✅ 找到了！正在分析「${chosen.description}」的收據照片...` }])
    try {
      await analyzeChosen(chosen)
    } catch (analyzeErr) {
      console.error('[ANALYZE_PHOTO_AFTER_SEARCH_ERROR]', analyzeErr)
      await pushMessage(sourceId, [{ type: 'text', text: '😵 照片分析失敗，請稍後再試。', quickReply: boundQR }])
    }
  } catch (searchErr) {
    console.error('[SEARCH_PHOTO_ERROR]', searchErr)
    await pushMessage(sourceId, [{ type: 'text', text: '😵 查詢過程發生錯誤，請稍後再試。', quickReply: boundQR }])
  }
}
