// ============================================================
// _shared/assistant/chat.ts —— 文字對話的 AI 核心（LINE、網頁共用）
//
// 「這句話怎麼交給模型、模型回來的提議怎麼驗證」只有這一份：
//   組 context（旅程設定、最近 10 筆、草稿、今天的行程）→ 多輪對話 → ai.runToolLoop
//   → 終結函式（propose_expenses / propose_expense_update / propose_expense_delete / analyze_receipt / reply）
//   → 這裡的 prepare* 驗證 → 由管道決定怎麼畫卡片、怎麼回覆。
//
// LINE（line-webhook/handlers/ai-text.ts）與網頁（web-chat）都只在最後一步不同：
// LINE 畫 Flex 卡片、把草稿存進 pending 列；網頁回 JSON、草稿留在使用者的瀏覽器。
//
// ⚠️ 模型不能直接改資料庫：公開給它的只有唯讀工具與「提議」，真正的寫入一律要使用者按確認。
// 這一層不碰 Deno.env、不建 Supabase client（db 由呼叫端傳進來）。
// ============================================================

import { formatAmount } from "../finance.ts"
import { splitByItems } from "../itemSplit.ts"
import { optionalString, toExpenseInput, toExpensePatch } from "../tools/args.ts"
import {
  expensePrecision,
  expenseRef,
  prepareExpense,
  prepareExpenseUpdate,
  resolveExpenseRef,
} from "../tools/expenses.ts"
import { itineraryTodayLine } from "../tools/itinerary.ts"
import { MAX_PROPOSED_EXPENSES } from "../tools/schemas.ts"
import type { ItineraryDoc, PreparedExpense, ToolArgs } from "../tools/types.ts"
import type { SupabaseClient } from "../deps.ts"
import type { ExpenseRow, TripRow } from "../types.ts"
import { extractJSON, resolveMember } from "../validate.ts"
import type { AiMessage, AiProvider } from "../ai/types.ts"
import { memberAliasHint } from "./ai.ts"
import {
  claimsCompletedAction,
  matchExpensesByQuestion,
  mentionsEditingExisting,
  pickExpenseByRef,
  sanitizeMapLinks,
  summarizeHistoryEntry,
  summarizeTripExpenses,
} from "./guards.ts"
import type { OutstandingDraft, PhotoSelectResponse } from "./types.ts"

/** 近期支出與全庫搜尋只 select 這幾個欄位 */
export type RecentExpense = Pick<
  ExpenseRow,
  "id" | "description" | "amount" | "currency" | "category" | "date" | "photo_urls"
>

export const RECENT_EXPENSE_COLUMNS = 'id, description, amount, currency, category, date, photo_urls'

/** 一則對話歷史（舊到新）。content 是給模型看的摘要，speaker 是群組裡誰講的 */
export interface HistoryTurn {
  role: 'user' | 'model'
  content: string
  speaker_name?: string | null
}

/** 「找不到你說的那一筆」時的統一說法：請他講清楚，不要讓模型亂猜（規則 6a） */
export const REF_NOT_FOUND_TEXT = '😅 我找不到你說的那一筆（可能已經刪掉了，或我沒認出是哪一筆）。\n\n'
  + '請說得具體一點，例如「昨天的拉麵那筆」「9/3 小明付的計程車」，或輸入「編輯支出」「刪除支出」從清單點選。'

// ============================================================
// 資料
// ============================================================

/** 最近 10 筆（不含結清與垃圾桶），模型靠它們的 ref 指稱「剛剛那筆」 */
export async function loadRecentExpenses(db: SupabaseClient, tripId: string): Promise<RecentExpense[]> {
  const { data } = await db.from('expenses')
    // id 是給 ref 用的（uuid 前 8 碼），模型要靠它指名「哪一筆」
    .select(RECENT_EXPENSE_COLUMNS)
    .eq('trip_id', tripId)
    .is('deleted_at', null)
    .not('is_settlement', 'is', true)
    .order('date', { ascending: false })
    .limit(10)
  return (data ?? []) as RecentExpense[]
}

/**
 * 全趟的精確彙總（get_trip_summary）。模型問了才算。
 * 刻意不設 limit：「這趟總共花多少」若只看得到一部分，答出來的數字是錯的，比不答更糟。
 * 結清紀錄也要撈進來 —— summarizeTripExpenses 會自己決定哪些數字該含它。
 */
export async function loadTripSummary(db: SupabaseClient, trip: TripRow): Promise<{ summary: unknown }> {
  const { data: all } = await db.from('expenses')
    // description 是給「金額最大的幾筆」用的（K13）
    .select('amount, currency, description, category, date, is_settlement, payer_data, split_data')
    .eq('trip_id', trip.id)
    .is('deleted_at', null)
  // rates 與主幣別是用來排序「金額最大的幾筆」的：跨幣別不折算就比不出大小
  return {
    summary: summarizeTripExpenses(all ?? [], trip.members ?? [], (trip.precision_config ?? {}) as Record<string, number>, {
      rates: trip.rates, baseCurrency: trip.base_currency,
    }),
  }
}

/**
 * 把模型給的 ref 對回真正的那一筆。
 * `resolveExpenseRef()` 只在**唯一命中**時才回傳，而且擋掉垃圾桶裡的與結清紀錄 ——
 * 改錯或刪錯一筆帳，比誠實說「講清楚一點」糟得多。
 */
export function findExpenseByRef(db: SupabaseClient, tripId: string, ref: unknown): Promise<ExpenseRow | null> {
  const needle = optionalString(ref)
  if (!needle) return Promise.resolve(null)
  return resolveExpenseRef(needle, { db, trip: { id: tripId } }, { allowSettlement: false })
}

// ============================================================
// context 與對話
// ============================================================

export interface TripContextInput {
  trip: TripRow
  today: string
  /** 傳訊者（LINE 名稱、網頁選的「我是誰」） */
  memberName: string
  itinerary: ItineraryDoc | null
  recentExpenses: RecentExpense[]
  drafts: OutstandingDraft[]
  /** 管道自己的補充（例如 LINE 群組的【群組模式】），接在預設付款人那一行後面，要自己帶開頭的換行 */
  channelNote?: string
}

/**
 * 每一則訊息的旅程 context。只放「這次對話的當下狀態」 ——
 * 人設與不可變規則在 YOSHI_SYSTEM_INSTRUCTION，可以做哪些事由 function declarations 描述。
 */
export function buildTripContext(input: TripContextInput): string {
  const { trip, today, memberName, itinerary, recentExpenses, drafts, channelNote = '' } = input
  const precision = (trip.precision_config ?? {}) as Record<string, number>

  // 每一筆都列 ref（uuid 前 8 碼）。以前是 #1～#10 的序號 ——
  // 序號只在「這一次的清單」裡有意義，模型一旦先呼叫 list_expenses 拿到 ref，兩套編號就會打架。
  const expensesSummary = recentExpenses.map((e) => {
    const photo = e.photo_urls?.length > 0 ? ` 📷×${e.photo_urls.length}` : ''
    return `ref=${expenseRef(e.id)} ${e.date} ${e.description} ${formatAmount(e.amount, e.currency, precision)} ${e.currency} [${e.category}]${photo}`
  }).join('\n')

  // 還沒確認也沒取消的草稿。一定要把 nonce 一起給 AI：使用者說「剛剛那筆改 500」時，
  // 只有 AI 講得出「我在修哪一張」，才知道該讓哪一張卡片失效（H1）。
  const draftSummary = drafts.map((d) => {
    const e = d.exp ?? {}
    const payers = Object.keys(e.p ?? {}).join('、') || '未指定'
    const splits = Object.keys(e.s ?? {}).join('、') || '未指定'
    const photo = d.photoIds.length > 0 ? '（附收據照片）' : ''
    // 有品項明細的收據：列出編號，使用者說「雞皮是賢佑的」時 AI 才填得出 item_assignments
    const items = d.items.length > 0
      ? `\n  品項：${d.items.map((it, i) => `#${i} ${it.name}${it.qty ? ` ×${it.qty}` : ''} ${it.amount}`).join('、')}`
      : ''
    return `- nonce=${d.nonce}：${e.d ?? ''} ${e.a ?? ''} ${e.c ?? ''}${photo}（付款：${payers}；分攤：${splits}）${items}`
  }).join('\n')

  return `【旅程】${trip.name}｜成員：${trip.members.join('、')}｜分類：${trip.categories.join('、')}（預設：${trip.default_category || '無'}）
【幣別】記帳預設：${trip.default_currency || trip.base_currency}（使用者沒明講就填這個，單獨的「$」不算明講，不要反問幣別）｜結算主幣：${trip.base_currency}（只用於統計，不要拿來當記帳幣別）｜可用：${Object.keys(trip.rates ?? {}).join('、') || '（尚未設定）'}
【今日】${today}｜${trip.is_archived ? '⚠️ 已封存（唯讀，禁止記帳與修改）' : '進行中'}
【記帳偏好（整趟旅程共用）】${trip.ai_preference || '無'}｜傳訊者：${memberName}
【旅程預設付款人】${trip.default_payer?.length ? trip.default_payer.join('、') : '無'}｜預設分攤：${trip.default_split_members?.length ? trip.default_split_members.join('、') : '全員'}${channelNote}

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
}

/**
 * 組成真正的多輪對話：旅程 context → 歷史（舊到新）→ 這一句。
 *
 * 結尾沒有得到回覆的 user 訊息會被丟掉：留著的話，合併同角色輪次時它會跟「當下這句話」
 * 黏成同一輪，模型就分不清該回應哪一句了。兩家都預期 user / assistant 交替，
 * 連續同角色的輪次（拍照產生的草稿沒有對應的使用者文字）先合併。
 */
export function buildConversation(tripContext: string, history: HistoryTurn[], currentText: string): AiMessage[] {
  const ordered = [...history]
  while (ordered.length > 0 && ordered[ordered.length - 1].role === 'user') ordered.pop()

  const raw: AiMessage[] = [
    { role: 'user', parts: [{ text: tripContext }] },
    // ⚠️ 這句以前是一段假的 JSON。走 function calling 之後那只會誘導模型在文字裡寫 JSON，改成純文字。
    { role: 'assistant', parts: [{ text: '了解，我已掌握這趟旅程的設定。' }] },
    ...ordered.map((h): AiMessage => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      parts: [{ text: summarizeHistoryEntry(h.role, h.content, h.speaker_name ?? null) }],
    })),
    { role: 'user', parts: [{ text: currentText }] },
  ]
  return raw.reduce((acc: AiMessage[], turn: AiMessage) => {
    const prev = acc[acc.length - 1]
    if (prev && prev.role === turn.role) {
      prev.parts.push(...turn.parts)
    } else {
      acc.push({ role: turn.role, parts: [...turn.parts] })
    }
    return acc
  }, [])
}

/**
 * 聊天室裡有一張還沒確認的收據草稿時，把那張收據一起送給 AI 的說明。
 * 光看文字分不出「A 是我吃的」對應多少錢 —— 必須讓模型重新讀收據品項。
 */
export function photoDraftHint(draft: OutstandingDraft): string {
  const d = draft.exp ?? {}
  // ⚠️ 以前這段只寫「調整金額或分攤」，「是艷櫻先付的」這種講付款人的話
  //    模型就判定「不需要重新分配」而只用 reply 回一段文字，卡片沒換。
  //    任何欄位都要列出來，也要講明「沒說改也算」。
  return `【尚未確認的收據草稿 nonce=${draft.nonce}】${d.d ?? ''} ${d.a ?? ''} ${d.c ?? ''} ${d.dt ?? ''} [${d.cat ?? ''}]\n`
    + `目前付款：${JSON.stringify(d.p ?? {})}｜目前分攤：${JSON.stringify(d.s ?? {})}\n`
    + `下面附上那張收據。若使用者這句話在補充或修正這筆的**任何**內容 ——`
    + `付款人（「是小明付的」）、分攤（「我沒吃」「只有我們三個」）、金額、品名、日期、分類 ——`
    + `就算他沒說「改」也一樣，呼叫 propose_expenses 回傳**一筆**修正後的內容`
    + `（沒提到的欄位沿用上面的草稿；分攤要依品項重算時請重新閱讀收據），`
    + `並把 corrects_draft 填成 ${draft.nonce}。\n`
    + `⚠️ 若他講的是**另一筆與這張收據無關的支出**（例如「計程車 200」），`
    + `corrects_draft 請留空 —— 系統會據此決定新卡片要不要沿用這張收據。\n`
    + `若只是閒聊或詢問，照常呼叫 reply。`
}

/** 草稿還在、這句話像在補欄位，模型卻只用 reply 回文字時，再問一次的提醒 */
export function draftRetryHint(nonces: string[]): string {
  return `\n\n【系統提醒】這句話看起來是在補充或修正尚未確認的草稿（nonce：${nonces.join('、')}），`
    + `沒說「改」也一樣。若是如此，請呼叫 propose_expenses 回傳修正後的完整一筆並填 corrects_draft；`
    + `用 reply 描述草稿的新內容不會改到卡片。只有這句話其實與草稿無關時才用 reply。`
}

// ============================================================
// 終結函式的驗證（只算不寫）
// ============================================================

/** 一張提議出來的記帳卡 */
export interface ProposedExpense {
  expense: PreparedExpense
  /** 沿用被修正那張草稿的收據（只有第一筆、而且確實是在修正那張時才有） */
  photoIds: string[]
  receipt: boolean
  items: OutstandingDraft['items']
  subtotal?: number
}

export type ProposalOutcome =
  /** 使用者其實想改已經存檔的紀錄（「剛剛那個改 250」卻沒有草稿），管道該讓他挑是哪一筆 */
  | { kind: 'edit_existing' }
  /** 不能出卡片，回這句話（反問金額、成員對不上、沒有匯率…） */
  | { kind: 'message'; text: string }
  | { kind: 'ok'; proposals: ProposedExpense[]; notes: string[]; correctedDraft: OutstandingDraft | null }

/**
 * propose_expenses：一到四張待確認的記帳卡。
 *
 * 每一筆都各自走 `prepareExpense()`（與 OCR、「確認存入」共用同一份實作）——
 * 「午餐 300 晚餐 500」出兩張卡，兩張都能獨立確認或取消（C8）。
 */
export function prepareProposedExpenses(
  args: ToolArgs,
  scope: {
    trip: TripRow
    today: string
    memberName: string
    cleanText: string
    drafts: OutstandingDraft[]
    /** 模型自己多講的一句話（放在卡片前面） */
    extraText?: string
  },
): ProposalOutcome {
  const { trip, today, memberName, cleanText, drafts } = scope

  // AI 指名要修正哪一張草稿？只有對得上的 nonce 才算數。
  const correctsNonce = optionalString(args.corrects_draft) ?? ''
  const correctedDraft = correctsNonce ? drafts.find(d => d.nonce === correctsNonce) ?? null : null

  // 第二道防線（T1）：使用者說的是「改」，現場卻沒有任何可以修的草稿，AI 也沒指名 corrects_draft ——
  // 它多半是把「剛剛那個改250」誤當成新支出了，照著出卡片會憑空多記一筆。
  if (drafts.length === 0 && !correctsNonce && mentionsEditingExisting(cleanText)) {
    console.log(`[GUARD] AI proposed a new expense for an edit-sounding message with no draft: "${cleanText}"`)
    return { kind: 'edit_existing' }
  }

  const rawList = Array.isArray(args.expenses) ? args.expenses : []
  if (rawList.length === 0) {
    return { kind: 'message', text: '😅 我沒看懂要記什麼，可以再說一次嗎？例如「晚餐 300」。' }
  }

  const overflow = Math.max(0, rawList.length - MAX_PROPOSED_EXPENSES)
  const prepared = rawList.slice(0, MAX_PROPOSED_EXPENSES).map((raw) =>
    // sourceText 給使用者的原話 —— 幣別宣稱 stated 時要拿它驗一次（T3）
    prepareExpense(toExpenseInput(raw as ToolArgs), trip, { today, actorName: memberName, sourceText: cleanText })
  )

  // 名字對不上就整批擋（OCR 路徑只警告 —— 那邊照片已經上傳，重拍的代價比重打一句話大得多）
  const unknownMembers = [...new Set(prepared.flatMap(p => p.unresolvedMembers))]
  if (unknownMembers.length > 0) {
    console.warn(`[TEXT] Unknown members detected: ${unknownMembers.join(', ')}`)
    return {
      kind: 'message',
      text: `😅 我從您的描述中辨識到不存在的成員：${unknownMembers.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n可能是名字打錯或漏字了，請改用正確的成員名稱再說一次。`,
    }
  }

  // 🧾 逐項分（打字版）：「雞皮、啤酒是賢佑的，其他平分」。
  // 模型只負責說「哪幾項是誰的」，金額由程式依品項算（含稅與折扣的比例），加總一定等於總額。
  const assignments = Array.isArray(args.item_assignments) ? args.item_assignments as ToolArgs[] : []
  if (correctedDraft && correctedDraft.items.length > 0 && assignments.length > 0 && prepared[0]) {
    const items = correctedDraft.items
    const owners: string[][] = items.map(() => [])
    const unknownOwners: string[] = []
    const toMembers = (names: unknown): string[] => (Array.isArray(names) ? names : []).flatMap((n) => {
      const m = resolveMember(String(n ?? ''), trip.members)
      if (!m) unknownOwners.push(String(n ?? ''))
      return m ? [m] : []
    })
    for (const a of assignments) {
      const who = toMembers(a.members)
      for (const idx of Array.isArray(a.items) ? a.items : []) {
        const i = Number(idx)
        if (Number.isInteger(i) && i >= 0 && i < items.length) owners[i] = [...new Set([...owners[i], ...who])]
      }
    }
    const othersArg = toMembers(args.others)
    if (unknownOwners.length > 0) {
      return { kind: 'message', text: `😅 對不到這幾個名字：${unknownOwners.join('、')}\n目前成員：${trip.members.join('、')}` }
    }
    const target = prepared[0].expense
    const others = othersArg.length > 0 ? othersArg : Object.keys(correctedDraft.exp?.s ?? target.split_details ?? {})
    const payer = Object.keys(target.payer_data ?? {})[0] ?? null
    const result = splitByItems(Number(target.amount), items, owners, others.length > 0 ? others : trip.members,
      expensePrecision(trip, target.currency), payer)
    console.log(`[ITEMS] Split ${items.length} items by text: ${JSON.stringify(result.split)}`)
    target.split_details = result.split
    target.adjustment_member = result.adjustment
  }

  // 這趟旅程沒有這個幣別的匯率 —— 存下去統計會以 1:1 換算而失真（文字路徑沒有照片要留，請他換一個幣別）
  const rejected = prepared.find(p => p.reject)
  if (rejected?.reject) return { kind: 'message', text: rejected.reject }

  // 金額是 0 或負數：多半是句子裡沒講多少錢（「晚餐」），出一張 0 元的卡片只會讓人困惑
  const noAmount = prepared.find(p => !(p.expense.amount > 0))
  if (noAmount) {
    return {
      kind: 'message',
      text: `😅「${noAmount.expense.description || '這筆'}」多少錢呢？請連金額一起說，例如「晚餐 300」。`,
    }
  }

  const proposals = prepared.map((result, idx): ProposedExpense => {
    // 收據只在「確實是在修正那張收據草稿」時才沿用，而且只沿用到**第一筆** ——
    // 傳完收據再打「計程車 200」，計程車那筆不該掛著別人的發票（H1）。
    const carry = idx === 0 && correctedDraft !== null
    const photoIds = carry && correctedDraft.photoIds.length > 0 ? correctedDraft.photoIds : []
    const items = carry ? correctedDraft.items : []
    return {
      expense: result.expense,
      photoIds,
      receipt: photoIds.length > 0 && correctedDraft?.receipt === true,
      items,
      subtotal: items.length > 0 ? correctedDraft?.subtotal : undefined,
    }
  })

  // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西
  const notes = [
    ...(scope.extraText ? [scope.extraText] : []),
    ...new Set(prepared.flatMap(p => p.warnings)),
    ...(overflow > 0 ? [`（一次最多記 ${MAX_PROPOSED_EXPENSES} 筆，另外 ${overflow} 筆請分開再說一次。）`] : []),
  ].filter(Boolean)

  return { kind: 'ok', proposals, notes, correctedDraft }
}

export type UpdateOutcome =
  | { kind: 'message'; text: string }
  | { kind: 'ok'; result: ReturnType<typeof prepareExpenseUpdate>; existing: ExpenseRow; notes: string[] }

/**
 * propose_expense_update：「✏️ 修改預覽」。這裡**只算不寫**，真正的 UPDATE 在使用者按確認之後。
 * existing 由呼叫端用 findExpenseByRef 查好（null 代表找不到）。
 */
export function prepareProposedUpdate(
  existing: ExpenseRow | null,
  args: ToolArgs,
  scope: { trip: TripRow; today: string; memberName: string; cleanText: string; extraText?: string },
): UpdateOutcome {
  const { trip, today, memberName, cleanText } = scope
  if (!existing) return { kind: 'message', text: REF_NOT_FOUND_TEXT }

  const result = prepareExpenseUpdate(existing, toExpensePatch(args), trip, {
    today, actorName: memberName, sourceText: cleanText,
  })
  if (result.unresolvedMembers.length > 0) {
    return {
      kind: 'message',
      text: `😅 我從您的描述中辨識到不存在的成員：${result.unresolvedMembers.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n請改用正確的成員名稱再說一次。`,
    }
  }
  if (result.reject) return { kind: 'message', text: result.reject }
  if (!(result.expense.amount > 0)) {
    return { kind: 'message', text: '😅 金額必須大於 0。要改成多少呢？例如「改成 500」。' }
  }
  // 出一張「什麼都沒改」的卡片只會讓人困惑，直接說明
  if (result.changes.length === 0) {
    return {
      kind: 'message',
      text: `🤔 「${existing.description}」本來就是這樣了，沒有需要改的地方。\n\n要改什麼可以講具體一點，例如「改成 500」「日期改昨天」。`,
    }
  }
  const notes = [...(scope.extraText ? [scope.extraText] : []), ...result.warnings].filter(Boolean)
  return { kind: 'ok', result, existing, notes }
}

/**
 * reply 送出前的最後一道防線：
 * - 模型說「已經幫您刪除了」—— 那要使用者按了確認才生效，假訊息比直說做不到還糟，換掉
 * - 沒查過的地圖連結拿掉
 * - 太長截斷、空的補一句
 */
export function sanitizeReplyText(text: unknown, seenText: string, maxLength = 4900): string {
  let safe = String(text ?? '')
  if (claimsCompletedAction(safe)) {
    console.warn('[GUARD] Blocked a false completion claim:', safe.substring(0, 120))
    safe = '我可以幫你提議修改或刪除，但要你按了確認卡片才會真的生效 🙇\n\n'
      + '請告訴我是哪一筆（例如「把昨天的拉麵改成 300」），我會出一張確認卡給你。'
  }
  const maps = sanitizeMapLinks(safe, seenText)
  if (maps.removed.length > 0) console.warn('[GUARD] Removed unverified map links:', maps.removed.join(' '))
  safe = maps.text
  if (safe.length > maxLength) safe = safe.substring(0, maxLength) + "\n\n...(內容過長已截斷)"
  if (!safe) safe = 'Yoshi! 🥚 有什麼需要幫忙的嗎？'
  return safe
}

/**
 * 使用者問某一張收據，但模型沒給 ref（或對不上）：從有照片的支出裡挑出他問的那一筆。
 *
 * 先在程式端用店名比對（命中唯一一筆就不必再叫一次模型），仍然不唯一才多叫一次模型從清單裡挑（T4）。
 * 挑不到回 null。
 */
export async function chooseReceiptExpense(
  ai: AiProvider,
  withPhotos: RecentExpense[],
  opts: { question: string; cleanText: string; precision: Record<string, number> },
): Promise<RecentExpense | null> {
  const { question, cleanText, precision } = opts
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
  return chosen
}
