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

import { formatAmount } from "../../_shared/finance.ts"
import { optionalString, toExpenseInput, toExpensePatch } from "../../_shared/tools/args.ts"
import {
  expenseRef,
  prepareExpense,
  prepareExpenseUpdate,
  resolveExpenseRef,
} from "../../_shared/tools/expenses.ts"
import { runTool } from "../../_shared/tools/registry.ts"
import { MAX_PROPOSED_EXPENSES } from "../../_shared/tools/schemas.ts"
import {
  claimsCompletedAction,
  extractJSON,
  matchExpensesByQuestion,
  mentionsDraftField,
  mentionsEditingExisting,
  pickExpenseByRef,
  summarizeHistoryEntry,
  summarizeTripExpenses,
} from "../guards.ts"
import {
  aiUnavailableMessage,
  CHAT_HISTORY_TURNS,
  FALLBACK_NOTICES,
  WEB_SEARCH_MAX_USES,
  WEBAPP_URL,
} from "../config.ts"
import { type EventContext, extendFollowup, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import { type OutstandingDraft, photoPublicUrl, storePendingExpense, supersedeDraft } from "../drafts.ts"
import {
  ai,
  analyzeReceiptPhoto,
  fetchPhotoPart,
  FOLLOWUP_TERMINAL_NAMES,
  FOLLOWUP_TOOL_DECLARATIONS,
  memberAliasHint,
  READ_TOOL_NAMES,
  STAY_SILENT_TOOL,
  TERMINAL_TOOL_NAMES,
  TEXT_TOOL_DECLARATIONS,
  TRIP_SUMMARY_TOOL,
  YOSHI_SYSTEM_INSTRUCTION,
} from "../ai.ts"
import { loadItinerary } from "../itinerary.ts"
import { pushMessage, replyMessage, showLoading } from "../line-api.ts"
import {
  buildDeleteConfirmCard,
  buildDraftLiffUrl,
  buildEditLiffUrl,
  buildExpenseCard,
  buildUpdatePreviewCard,
  GROUP_MODE_INFO,
  replyEditPicker,
} from "../messages.ts"
import { runInBackground } from "../util.ts"
import { itineraryTodayLine } from "../../_shared/tools/itinerary.ts"
import { countryForTimezone } from "../../_shared/tools/weather.ts"
import type { ToolArgs, ToolContext } from "../../_shared/tools/types.ts"
import type { ExpenseRow, TripRow } from "../../_shared/types.ts"
import type {
  AiMessage,
  ChatHistoryRow,
  OutgoingMessage,
  PhotoSelectResponse,
  TextRoute,
} from "../types.ts"

/** 近期支出與全庫搜尋只 select 這幾個欄位 */
type RecentExpense = Pick<
  ExpenseRow,
  "id" | "description" | "amount" | "currency" | "category" | "date" | "photo_urls"
>

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

/** 「找不到你說的那一筆」時的統一說法：請他講清楚，不要讓模型亂猜（規則 6a） */
const REF_NOT_FOUND_TEXT = '😅 我找不到你說的那一筆（可能已經刪掉了，或我沒認出是哪一筆）。\n\n'
  + '請說得具體一點，例如「昨天的拉麵那筆」「9/3 小明付的計程車」，或輸入「編輯支出」「刪除支出」從清單點選。'

/** 交給 AI。呼叫端已經確認 ctx.isBound，而且沒有任何指令認領這句話。 */
export async function handleAiText(ctx: EventContext, route: TextRoute): Promise<void> {
  const { memberName, replyToken, sourceId, speakerLabel, speakerUserId, userState } = ctx
  const { cleanText } = route
  const tripId = userState.current_trip_id as string
  const loadDrafts = ctx.loadDrafts
  const isFollowup = route.trigger === 'followup'

  // 一對一顯示「輸入中…」。不等它 —— 那只是一個動畫，不該拖慢回覆
  runInBackground(showLoading(sourceId))

  const [{ data: trip }, { data: expenses }, { data: history }, itinerary, outstandingDrafts] = await Promise.all([
    supabase.from('trips').select('*').eq('id', tripId).single(),
    supabase.from('expenses')
      // id 是給 ref 用的（uuid 前 8 碼），模型要靠它指名「哪一筆」
      .select('id, description, amount, currency, category, date, photo_urls')
      .eq('trip_id', tripId)
      .is('deleted_at', null)
      .not('is_settlement', 'is', true)
      .order('date', { ascending: false })
      .limit(10),
    // 排除 pending/saved 內部記錄，只取對話歷史。
    // ⚠️ 必須用 descending 取「最近的 N 筆」，之後再反轉回時間順序。
    //    寫成 ascending + limit 會永遠拿到史上最舊的那幾筆，
    //    對話窗口不會前進，AI 會一直停留在很久以前的內容。
    // speaker_name 要一起撈：群組整串歷史是共用的，
    // 少了它 AI 分不出「我付的」是誰講的（L15、M17）。
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
      type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。',
    }], sourceId)
    return
  }

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

  // 全趟的精確彙總（get_trip_summary）。AI 只看得到最近 10 筆，自由查詢（K8–K13）過去一律答錯（M6）。
  // 以前每則訊息都算好塞進 context，現在模型問了才算。
  const getTripSummary = async () => {
    // 刻意不設 limit：「這趟總共花多少」若只看得到一部分，答出來的數字是錯的，比不答更糟。
    // 結清紀錄也要撈進來 —— summarizeTripExpenses 會自己決定哪些數字該含它。
    const { data: all } = await supabase.from('expenses')
      // description 是給「金額最大的幾筆」用的（K13）
      .select('amount, currency, description, category, date, is_settlement, payer_data, split_data')
      .eq('trip_id', tripId)
      .is('deleted_at', null)
    // rates 與主幣別是用來排序「金額最大的幾筆」的：跨幣別不折算就比不出大小
    return {
      summary: summarizeTripExpenses(all ?? [], trip.members ?? [], contextPrecision, {
        rates: trip.rates, baseCurrency: trip.base_currency,
      }),
    }
  }

  // 每一筆都列 ref（uuid 前 8 碼）。以前是 #1～#10 的序號 ——
  // 序號只在「這一次的清單」裡有意義，模型一旦先呼叫 list_expenses 拿到 ref，
  // 兩套編號就會打架。改成從頭到尾只有一種指稱方式。
  const expensesSummary = (expenses ?? []).map((e: RecentExpense) => {
    const photo = e.photo_urls?.length > 0 ? ` 📷×${e.photo_urls.length}` : ''
    return `ref=${expenseRef(e.id)} ${e.date} ${e.description} ${formatAmount(e.amount, e.currency, contextPrecision)} ${e.currency} [${e.category}]${photo}`
  }).join('\n')

  // 還等在聊天室裡、使用者既沒確認也沒取消的草稿。
  // 一定要把 nonce 一起給 AI：使用者說「剛剛那筆改 500」時，
  // 只有 AI 講得出「我在修哪一張」，路由層才知道該讓哪一張卡片失效（H1）。
  const draftSummary = outstandingDrafts.map((d) => {
    const e = d.exp ?? {}
    const payers = Object.keys(e.p ?? {}).join('、') || '未指定'
    const splits = Object.keys(e.s ?? {}).join('、') || '未指定'
    const photo = d.photoIds.length > 0 ? '（附收據照片）' : ''
    return `- nonce=${d.nonce}：${e.d ?? ''} ${e.a ?? ''} ${e.c ?? ''}${photo}（付款：${payers}；分攤：${splits}）`
  }).join('\n')

  // 群組才有模式。「照片怎麼沒反應」「為什麼要 @ 你」這類問題要靠這一行回答 ——
  // 靜音模式下照片根本沒進到機器人，不給它這一行，它只能亂猜是辨識失敗。
  const modeInfo = GROUP_MODE_INFO[ctx.groupMode]
  const groupModeLine = ctx.isGroup
    ? `
【群組模式】${modeInfo.name}：${modeInfo.summary}。`
      + `使用者問照片為什麼沒反應、為什麼要 @ 你時，照這個說明回答；`
      + `要換模式可以按下方的模式按鈕，或輸入「模式:提及模式」「模式:全回應模式」「模式:靜音模式」。`
    : ''

  // 只放「這次對話的當下狀態」。人設與不可變規則已在 YOSHI_SYSTEM_INSTRUCTION，
  // 可以做哪些事則由 function declarations 描述，不必再用文字講一次。
  const tripContext = `【旅程】${trip.name}｜成員：${trip.members.join('、')}｜分類：${trip.categories.join('、')}（預設：${trip.default_category || '無'}）
【幣別】記帳預設：${trip.default_currency || trip.base_currency}（使用者沒明講就填這個）｜結算主幣：${trip.base_currency}（只用於統計，不要拿來當記帳幣別）｜可用：${Object.keys(trip.rates ?? {}).join('、') || '（尚未設定）'}
【今日】${today}｜${trip.is_archived ? '⚠️ 已封存（唯讀，禁止記帳與修改）' : '進行中'}
【記帳偏好（整趟旅程共用）】${trip.ai_preference || '無'}｜傳訊者：${memberName}
【旅程預設付款人】${trip.default_payer?.length ? trip.default_payer.join('、') : '無'}｜預設分攤：${trip.default_split_members?.length ? trip.default_split_members.join('、') : '全員'}${groupModeLine}

【判斷優先權】
- payer_data（墊付）：①旅程預設付款人 ②記帳偏好 ③傳訊者對應的成員 ④成員第一位
- split_details（分攤）：①旅程預設分攤 ②記帳偏好 ③全員均分
- 幣別：使用者明講（currency_source: stated）> 記帳偏好（preference）> 都沒有就填 none，
  currency 一律用上面的「記帳預設」；系統會再驗一次，說謊沒有好處
${memberAliasHint(trip.members)}
【行程表】${itinerary ? `${itineraryTodayLine(itinerary, today)}（細節用 search_itinerary／get_itinerary_day／get_itinerary_overview 查）` : '這趟旅程沒有行程表'}

【近期支出（最近10筆，用來指稱「剛剛那筆」與查明細，不要拿來算總額）】
每一列開頭的 ref 就是指稱這筆支出的編號，要修改、刪除或看收據時把它填進 expense_ref。
不在這 10 筆裡的，先用 list_expenses 找出 ref。
${expensesSummary || '（尚無支出）'}

【尚未確認的草稿】（使用者可能想修正其中一張；修正時 corrects_draft 填它的 nonce）
⚠️ 草稿是「還沒存進帳本」的卡片，與上面【近期支出】那些**已存檔**的是兩回事：
   修正草稿用 propose_expenses + corrects_draft，改已存檔的用 propose_expense_update。
${draftSummary || '（沒有等待確認的草稿）'}`

  // 反轉回時間順序，並丟掉結尾沒有得到回覆的 user 訊息。
  // 留著的話，合併同角色輪次時它會跟「當下這句話」黏成同一輪，
  // 模型就分不清該回應哪一句了。
  const orderedHistory = [...(history ?? [])].reverse()
  while (orderedHistory.length > 0 && orderedHistory[orderedHistory.length - 1].role === 'user') {
    orderedHistory.pop()
  }

  // 真正的多輪對話。以前是把歷史壓成 "U: ... / Y: ..." 塞進單一 prompt，
  // 模型較難分辨哪些是自己說過的話。
  const rawConversation: AiMessage[] = [
    { role: 'user', parts: [{ text: tripContext }] },
    // ⚠️ 這句以前是一段假的 JSON（`{"type":"chat",...}`）。走 function calling 之後
    //    那只會誘導模型在文字裡寫 JSON 而不是呼叫函式，改成純文字。
    { role: 'assistant', parts: [{ text: '了解，我已掌握這趟旅程的設定。' }] },
    // 查詢是新到舊，這裡反轉回舊到新才符合對話順序
    ...orderedHistory.map((h: ChatHistoryRow): AiMessage => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      parts: [{ text: summarizeHistoryEntry(h.role, h.content, h.speaker_name) }],
    })),
    {
      role: 'user',
      parts: [{
        text: isFollowup
          ? `【這句話沒有叫你】是 ${memberName} 在你剛回覆完之後接著說的，可能是在跟群組裡的其他人聊天。`
            + `如果明顯不是在跟你講話，或只是笑、附和、道謝（「哈哈」「好喔」「謝謝」）而沒有要你做什麼，呼叫 ${STAY_SILENT_TOOL}；`
            + `有在問你、要你查或記東西，就照常回答。\n\n${cleanText}`
          : cleanText,
      }],
    },
  ]

  // 兩家都預期 user / assistant 交替。歷史裡可能出現連續兩則 assistant
  // （例如拍照產生的草稿沒有對應的使用者文字），先合併起來避免格式異常。
  const conversation = rawConversation.reduce((acc: AiMessage[], turn: AiMessage) => {
    const prev = acc[acc.length - 1]
    if (prev && prev.role === turn.role) {
      prev.parts.push(...turn.parts)
    } else {
      acc.push({ role: turn.role, parts: [...turn.parts] })
    }
    return acc
  }, [])

  // 如果聊天室裡還有一張沒被確認／取消的收據草稿，把那張收據一起送給 AI。
  // 光看文字是分不出「A 是我吃的」對應多少錢的 —— 必須讓模型重新讀收據品項。
  const photoDraft = outstandingDrafts.find(d => d.photoIds.length > 0) ?? null
  let attachedPhoto = false
  if (photoDraft) {
    const part = await fetchPhotoPart(photoPublicUrl(photoDraft.photoIds[0], photoDraft.tripId))
    if (part) {
      const d = photoDraft.exp ?? {}
      const lastTurn = conversation[conversation.length - 1]
      // ⚠️ 以前這段只寫「調整金額或分攤」，「是艷櫻先付的」這種講付款人的話
      //    模型就判定「不需要重新分配」而只用 reply 回一段文字，卡片沒換。
      //    任何欄位都要列出來，也要講明「沒說改也算」。
      lastTurn.parts.unshift({
        text: `【尚未確認的收據草稿 nonce=${photoDraft.nonce}】${d.d ?? ''} ${d.a ?? ''} ${d.c ?? ''} ${d.dt ?? ''} [${d.cat ?? ''}]\n`
          + `目前付款：${JSON.stringify(d.p ?? {})}｜目前分攤：${JSON.stringify(d.s ?? {})}\n`
          + `下面附上那張收據。若使用者這句話在補充或修正這筆的**任何**內容 ——`
          + `付款人（「是小明付的」）、分攤（「我沒吃」「只有我們三個」）、金額、品名、日期、分類 ——`
          + `就算他沒說「改」也一樣，呼叫 propose_expenses 回傳**一筆**修正後的內容`
          + `（沒提到的欄位沿用上面的草稿；分攤要依品項重算時請重新閱讀收據），`
          + `並把 corrects_draft 填成 ${photoDraft.nonce}。\n`
          + `⚠️ 若他講的是**另一筆與這張收據無關的支出**（例如「計程車 200」），`
          + `corrects_draft 請留空 —— 系統會據此決定新卡片要不要沿用這張收據。\n`
          + `若只是閒聊或詢問，照常呼叫 reply。`,
      })
      lastTurn.parts.push(part)
      attachedPhoto = true
    }
  }

  const toolCtx: ToolContext = {
    db: supabase, trip, today, actorName: memberName,
    loadItinerary: () => loadItinerary(tripId),
  }
  const scope: AiScope = {
    ctx, trip, tripId, today, cleanText,
    precision: contextPrecision,
    outstandingDrafts,
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
    execute: (name: string, args: ToolArgs) => {
      if (name === TRIP_SUMMARY_TOOL) return getTripSummary()
      if (!READ_TOOL_NAMES.includes(name)) {
        return Promise.resolve({ error: `Tool ${name} is not available here` })
      }
      return runTool(name, args, toolCtx)
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
      const nonces = outstandingDrafts.map(d => d.nonce).join('、')
      const retryConversation = conversation.map((m, i) => i === conversation.length - 1
        ? {
          ...m,
          parts: [...m.parts, {
            text: `\n\n【系統提醒】這句話看起來是在補充或修正尚未確認的草稿（nonce：${nonces}），`
              + `沒說「改」也一樣。若是如此，請呼叫 propose_expenses 回傳修正後的完整一筆並填 corrects_draft；`
              + `用 reply 描述草稿的新內容不會改到卡片。只有這句話其實與草稿無關時才用 reply。`,
          }],
        }
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
 * 每一筆都各自走 `prepareExpense()`（與 OCR 路徑、「確認存入」共用同一份實作）、
 * 各自一個 nonce、各自一列 pending —— 這樣「午餐 300 晚餐 500」出兩張卡，
 * 兩張都能獨立確認或取消（C8）。
 */
async function proposeExpenses(scope: AiScope, args: ToolArgs, extraText?: string): Promise<void> {
  const { ctx, trip, tripId, today, cleanText, outstandingDrafts } = scope
  const { boundQR, memberName, replyToken, sourceId } = ctx

  // AI 指名要修正哪一張草稿？只有對得上的 nonce 才算數。
  const correctsNonce = optionalString(args.corrects_draft) ?? ''
  const correctedDraft = correctsNonce
    ? outstandingDrafts.find(d => d.nonce === correctsNonce) ?? null
    : null

  // 第二道防線（T1）：使用者說的是「改」，現場卻沒有任何可以修的草稿，
  // AI 也沒指名 corrects_draft —— 那它多半是把「剛剛那個改250」誤當成新支出了，
  // 照著出卡片會憑空多記一筆。改列已存檔紀錄的編輯清單。
  // （模型本來就該改用 propose_expense_update，這裡是它沒照做時的保險。）
  if (outstandingDrafts.length === 0 && !correctsNonce && mentionsEditingExisting(cleanText)) {
    console.log(`[GUARD] AI proposed a new expense for an edit-sounding message with no draft: "${cleanText}"`)
    await replyEditPicker({
      tripId, sourceId, replyToken, boundQR,
      notice: '看起來你想改已經存入的紀錄。如果其實是要新記一筆，請不要用「改」來描述。',
    })
    return
  }

  const rawList = Array.isArray(args.expenses) ? args.expenses : []
  if (rawList.length === 0) {
    await reply(scope, [{
      type: 'text', text: '😅 我沒看懂要記什麼，可以再說一次嗎？例如「晚餐 300」。', quickReply: boundQR,
    }])
    return
  }

  const overflow = Math.max(0, rawList.length - MAX_PROPOSED_EXPENSES)
  const prepared = rawList.slice(0, MAX_PROPOSED_EXPENSES).map((raw) =>
    // sourceText 給使用者的原話 —— 幣別宣稱 stated 時要拿它驗一次，
    // 文字裡真的有幣別字眼才採信（T3）。
    prepareExpense(toExpenseInput(raw as ToolArgs), trip, {
      today, actorName: memberName, sourceText: cleanText,
    })
  )

  // 先試著把暱稱對應回正式名稱，真的對不上才退回請使用者重講。整批一起擋 ——
  // 名字打錯多半是整句話的問題，只擋其中一筆會讓使用者搞不清楚哪一筆記進去了。
  // （OCR 路徑只警告 —— 那邊照片已經上傳，重拍的代價比重打一句話大得多。）
  const unknownMembers = [...new Set(prepared.flatMap(p => p.unresolvedMembers))]
  if (unknownMembers.length > 0) {
    console.warn(`[TEXT] Unknown members detected: ${unknownMembers.join(', ')}`)
    await reply(scope, [{
      type: 'text',
      text: `😅 我從您的描述中辨識到不存在的成員：${unknownMembers.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n可能是名字打錯或漏字了，請改用正確的成員名稱再說一次。`,
      quickReply: boundQR,
    }])
    return
  }

  // 這趟旅程沒有這個幣別的匯率 —— 存下去統計會以 1:1 換算而失真。
  // （文字路徑沒有照片要留，直接請使用者換一個幣別就好。）
  const rejected = prepared.find(p => p.reject)
  if (rejected?.reject) {
    await reply(scope, [{ type: 'text', text: rejected.reject, quickReply: boundQR }])
    return
  }

  // 金額是 0 或負數：多半是句子裡沒講多少錢（「晚餐」），出一張 0 元的卡片只會讓人困惑
  const noAmount = prepared.find(p => !(p.expense.amount > 0))
  if (noAmount) {
    await reply(scope, [{
      type: 'text',
      text: `😅「${noAmount.expense.description || '這筆'}」多少錢呢？請連金額一起說，例如「晚餐 300」。`,
      quickReply: boundQR,
    }])
    return
  }

  const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
  const cards: OutgoingMessage[] = []
  const pendingWrites: Promise<unknown>[] = []
  const historyRows: { line_user_id: string; role: string; content: string }[] = []

  prepared.forEach((result, idx) => {
    const expense = result.expense
    const nonce = newNonce()
    // 收據只在「確實是在修正那張收據草稿」時才沿用，而且只沿用到**第一筆**。
    // 以前只要聊天室裡有收據草稿，接下來的任何一張新卡片都會被貼上
    // 那張收據的縮圖與 photo_urls —— 傳完收據再打「計程車 200」，
    // 計程車那筆就會掛著別人的發票（H1）。
    const photoIds = (idx === 0 && correctedDraft && correctedDraft.photoIds.length > 0)
      ? correctedDraft.photoIds
      : []

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
      p: photoIds, rc: photoIds.length > 0 && correctedDraft?.receipt === true, tid: tripId,
    }))
    cards.push(buildExpenseCard({
      expense,
      title: '🤖 AI 記帳預覽',
      altText: `確認記帳: ${expense.description}`,
      heroUrl: photoIds.length > 0 ? photoPublicUrl(photoIds[0], trip.id) : null,
      nonce,
      webUrl,
      // 草稿卡片的「✏️ 編輯」只帶 nonce，完整內容 LiffEdit 自己去 pending 列撈（T2）
      liffUrl: buildDraftLiffUrl(trip.id, nonce, sourceId),
    }))
  })

  // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西。
  // ⚠️ 全部併成**一則**文字：LINE 一次只能回 5 則，4 張卡片已經佔掉 4 則。
  const notes = [
    ...(extraText ? [extraText] : []),
    ...new Set(prepared.flatMap(p => p.warnings)),
    ...(overflow > 0 ? [`（一次最多記 ${MAX_PROPOSED_EXPENSES} 筆，另外 ${overflow} 筆請分開再說一次。）`] : []),
  ].filter(Boolean)
  const leadText: OutgoingMessage[] = notes.length > 0
    ? [{ type: 'text', text: notes.join('\n') }]
    : []

  runInBackground(supabase.from('line_chat_history').insert(historyRows))

  // 修正草稿時會送出新卡片，被修正的那一張必須先失效，
  // 否則按舊的「確認存入」會寫進未修正的金額。
  // ⚠️ 只失效被指名的那一張 —— 連續記多筆、群組裡多人同時記帳時，
  //    其他人的卡片必須留著（H1）。
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
 * ⚠️ 這裡**只算不寫**：`prepareExpenseUpdate()` 把改完之後的完整內容與異動清單算出來，
 *    真正的 UPDATE 在使用者按下按鈕之後才發生（handlers/postback.ts 的 `act: 'upd'`）。
 */
async function proposeExpenseUpdate(scope: AiScope, args: ToolArgs, extraText?: string): Promise<void> {
  const { ctx, trip, tripId, today, cleanText, precision } = scope
  const { boundQR, memberName, sourceId } = ctx

  const existing = await findByRef(args.expense_ref, tripId)
  if (!existing) {
    await reply(scope, [{ type: 'text', text: REF_NOT_FOUND_TEXT, quickReply: boundQR }])
    return
  }

  const result = prepareExpenseUpdate(existing, toExpensePatch(args), trip, {
    today, actorName: memberName, sourceText: cleanText,
  })
  if (result.unresolvedMembers.length > 0) {
    await reply(scope, [{
      type: 'text',
      text: `😅 我從您的描述中辨識到不存在的成員：${result.unresolvedMembers.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n請改用正確的成員名稱再說一次。`,
      quickReply: boundQR,
    }])
    return
  }
  if (result.reject) {
    await reply(scope, [{ type: 'text', text: result.reject, quickReply: boundQR }])
    return
  }
  if (!(result.expense.amount > 0)) {
    await reply(scope, [{
      type: 'text', text: '😅 金額必須大於 0。要改成多少呢？例如「改成 500」。', quickReply: boundQR,
    }])
    return
  }
  // 出一張「什麼都沒改」的卡片只會讓人困惑，直接說明
  if (result.changes.length === 0) {
    await reply(scope, [{
      type: 'text',
      text: `🤔 「${existing.description}」本來就是這樣了，沒有需要改的地方。\n\n要改什麼可以講具體一點，例如「改成 500」「日期改昨天」。`,
      quickReply: boundQR,
    }])
    return
  }

  const expense = result.expense
  const nonce = newNonce()
  const ref = expenseRef(existing.id)

  runInBackground(supabase.from('line_chat_history').insert({
    line_user_id: sourceId, role: 'model',
    content: `[修改建議 ${ref}] ${existing.description}：`
      + result.changes.map(c => `${c.field} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join('；'),
  }))

  const notes = [...(extraText ? [extraText] : []), ...result.warnings].filter(Boolean)
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
        amount: formatAmount(existing.amount, existing.currency, precision),
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

  const existing = await findByRef(args.expense_ref, tripId)
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
        amount: formatAmount(existing.amount, existing.currency, precision),
        currency: existing.currency,
        category: existing.category,
      },
      nonce,
    })]),
  ])
}

/**
 * 把模型給的 ref 對回真正的那一筆。
 *
 * `resolveExpenseRef()` 只在**唯一命中**時才回傳，而且擋掉垃圾桶裡的與結清紀錄 ——
 * 改錯或刪錯一筆帳，比誠實說「講清楚一點」糟得多。
 */
function findByRef(ref: unknown, tripId: string): Promise<ExpenseRow | null> {
  const needle = optionalString(ref)
  if (!needle) return Promise.resolve(null)
  return resolveExpenseRef(needle, { db: supabase, trip: { id: tripId } }, { allowSettlement: false })
}

/** 一般聊天／查詢的回覆 */
async function plainReply(scope: AiScope, args: ToolArgs): Promise<void> {
  const { ctx } = scope
  const { boundQR, sourceId } = ctx
  let safeContent = String(args.text ?? '')

  // 最後一道防線：模型現在**可以**提議修改與刪除，但那要使用者按了確認才生效。
  // 它有時仍會回「已經幫您刪除了」—— 使用者信了就以為帳已經改掉，
  // 這種假訊息比直說做不到還糟，所以在送出前換掉。
  if (claimsCompletedAction(safeContent)) {
    console.warn('[GUARD] Blocked a false completion claim:', safeContent.substring(0, 120))
    safeContent = '我可以幫你提議修改或刪除，但要你按了確認卡片才會真的生效 🙇\n\n'
      + '請告訴我是哪一筆（例如「把昨天的拉麵改成 300」），我會出一張確認卡給你。'
  }

  if (safeContent.length > 4900) safeContent = safeContent.substring(0, 4900) + "\n\n...(內容過長已截斷)"
  if (!safeContent) safeContent = 'Yoshi! 🥚 有什麼需要幫忙的嗎？'
  runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: safeContent }))
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
    `${e.description} ${formatAmount(e.amount, e.currency, precision)} ${e.currency}`

  /** 把選定的那一筆的**所有**收據照片一起送去分析並回覆 */
  const analyzeChosen = async (chosen: RecentExpense) => {
    const urls: string[] = (chosen.photo_urls ?? []).map((path: string) => photoPublicUrl(path, tripId))
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
  const byRef = await findByRef(args.expense_ref, tripId)
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
      .select('id, description, amount, currency, category, date, photo_urls')
      .eq('trip_id', tripId)
      .is('deleted_at', null)
      .not('is_settlement', 'is', true)
      .order('date', { ascending: false })

    const withPhotos = (allExpenses ?? []).filter((e: RecentExpense) => e.photo_urls?.length > 0)

    if (withPhotos.length === 0) {
      await pushMessage(sourceId, [{ type: 'text', text: '😅 此旅程中找不到任何帶有收據照片的支出紀錄。', quickReply: boundQR }])
      return
    }

    // 先在程式端縮小範圍：店名多半原封不動出現在問句裡。
    // 命中唯一一筆就不必再叫一次模型（省一次呼叫，也少一次挑錯的機會）。
    // 連原句一起比對：AI 轉述的 question 可能把店名丟掉（「詳細是買了什麼」）
    const narrowed = matchExpensesByQuestion(`${cleanText} ${question}`, withPhotos)
    let chosen: RecentExpense | null = narrowed.length === 1 ? narrowed[0] : null

    if (!chosen) {
      const pool = narrowed.length > 1 ? narrowed : withPhotos
      const expenseList = pool.map((e: RecentExpense, idx: number) =>
        `#${idx + 1} ${e.date} ${e.description} ${formatAmount(e.amount, e.currency, precision)} ${e.currency} [${e.category}] 📷×${e.photo_urls.length}`
      ).join('\n')

      // 這一次額外呼叫仍走 JSON mode（沒有工具要用，只是從清單裡挑一個），
      // 而且只要編號不要網址 —— 網址長又相似，小模型抄不準（T4）
      const selectPrompt = `以下是這趟旅程中附有收據照片的支出記錄：
${expenseList}

使用者問題：${question}

請找出最符合使用者描述的那一筆，回傳 JSON：
若找到 → {"found": true, "ref": "#編號"}
若找不到 → {"found": false}
使用者說「剛剛」「最新」又沒指名店名時，選日期最近的那一筆。`

      const selectText = await ai.generate({
        task: 'text',
        messages: [{ role: 'user', parts: [{ text: selectPrompt }] }],
        json: true,
      })
      const selectRes = JSON.parse(extractJSON(selectText)) as PhotoSelectResponse
      chosen = selectRes.found ? pickExpenseByRef(selectRes.ref, pool) : null
    }

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
