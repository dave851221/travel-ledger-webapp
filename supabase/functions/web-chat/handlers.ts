// ============================================================
// web-chat/handlers.ts —— 網頁聊天的每一種動作
//
// AI 的判斷、驗證、OCR 與 LINE 共用同一份（_shared/assistant/），差別只在輸出：
// LINE 畫 Flex 卡片、草稿存 pending 列；這裡回 JSON 的「區塊」（blocks），
// 草稿與對話紀錄留在使用者的瀏覽器（下一則訊息再帶上來，見 payload.ts）。
//
// 比 LINE 多的：
// - 使用者可以「回覆」某一張卡片（replyTo）：直接告訴模型是哪一張，不必靠它猜；
//   回覆的是草稿而模型只回一筆、又沒填 corrects_draft 時，程式補上
// - 一次可以回好幾個區塊（LINE 一次最多 5 則）
// - 「重讀收據」同步回答（LINE 要先回一句「請稍候」再推播）
//
// ⚠️ 寫入只在使用者按了卡片上的按鈕之後（save / update / delete / undo），
//    模型自己永遠改不到資料庫。整條路徑不寫任何對話紀錄、鎖或狀態到資料庫 ——
//    這趟請求真正寫進去的只有使用者確認的那一筆支出。
// ============================================================

import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import {
  analyzeReceiptPhoto,
  buildTextToolDeclarations,
  createAssistantAi,
  fetchPhotoPart,
  readToolNames,
  TERMINAL_TOOL_NAMES,
  TRIP_SUMMARY_TOOL,
  YOSHI_SYSTEM_INSTRUCTION,
} from "../_shared/assistant/ai.ts"
import {
  buildConversation,
  buildTripContext,
  chooseReceiptExpense,
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
} from "../_shared/assistant/chat.ts"
import { mentionsDraftField } from "../_shared/assistant/guards.ts"
import { createItineraryLoader } from "../_shared/assistant/itinerary.ts"
import { aiUnavailableMessage, ENTRY_LIMIT_MSG, FALLBACK_NOTICES } from "../_shared/assistant/notices.ts"
import { recognizeReceipt } from "../_shared/assistant/receipt.ts"
import { tripToday } from "../_shared/assistant/time.ts"
import type { DraftExpense, OutstandingDraft } from "../_shared/assistant/types.ts"
import type { SupabaseClient } from "../_shared/deps.ts"
import { formatAmountDisplay } from "../_shared/finance.ts"
import { buildSavedText } from "../_shared/savedText.ts"
import { optionalString } from "../_shared/tools/args.ts"
import { commitExpense, commitExpenseUpdate, deleteExpense, expenseRef, resolveExpenseRef } from "../_shared/tools/expenses.ts"
import { runTool } from "../_shared/tools/registry.ts"
import type { PreparedExpense, ToolArgs, ToolContext } from "../_shared/tools/types.ts"
import { countryForTimezone } from "../_shared/tools/weather.ts"
import type { TripRow } from "../_shared/types.ts"
import { consumeAi, quotaReply, userActor, type AiKind } from "../_shared/quota.ts"
import { PERSONA } from "../_shared/assistant/persona.ts"
import { createR2Store, createSupabaseStore, r2ConfigFromEnv, type PhotoStore } from "../_shared/photoStore.ts"
import {
  AI_DEADLINE_MS,
  AI_PROVIDER,
  ANTHROPIC_API_KEY,
  CHAT_HISTORY_TURNS,
  CLAUDE_MODEL,
  DRAFT_RETRY_MIN_MS,
  GEMINI_API_KEY,
  GOOGLE_MAPS_API_KEY,
  IS_PUBLIC,
  RECEIPTS_BUCKET,
  WEB_SEARCH_MAX_USES,
  WEBAPP_URL,
} from "./config.ts"
import {
  type ChatRequest,
  cleanDraft,
  cleanDraftExpense,
  cleanDrafts,
  cleanHistory,
  cleanMemberName,
  cleanReplyTarget,
  cleanText,
  isTripPhotoPath,
  type ReplyTarget,
  toOutstanding,
  type WebDraft,
} from "./payload.ts"

const ai = createAssistantAi({
  provider: AI_PROVIDER,
  geminiApiKey: GEMINI_API_KEY,
  anthropicApiKey: ANTHROPIC_API_KEY,
  claudeModel: CLAUDE_MODEL,
})
const READ_TOOL_NAMES = readToolNames(!!GOOGLE_MAPS_API_KEY)
const TEXT_TOOL_DECLARATIONS = buildTextToolDeclarations(READ_TOOL_NAMES)
/** 行程表：網頁打包的 JSON；開放版的旅程連了 Google 試算表就讀試算表 */
function loadItinerary(trip: TripRow) {
  const sheetId = IS_PUBLIC ? trip.itinerary_sheet : null
  const year = trip.start_date ? Number(trip.start_date.slice(0, 4)) : new Date().getFullYear()
  return createItineraryLoader(WEBAPP_URL, sheetId ? async () => ({ sheetId, title: trip.name, year }) : undefined)(trip.id)
}

// ============================================================
// 回應的形狀（前端 src/features/chat/types.ts 是同一份契約）
// ============================================================

export type ChatBlock =
  | { type: 'text'; text: string }
  /** 一張待確認的記帳卡。replaces：這張是在修正哪一張（前端把舊的標成「已更新」） */
  | { type: 'draft'; draft: WebDraft; title: string; needsAmount?: boolean; unidentified?: boolean; replaces?: string }
  /** 收據的幣別這趟旅程沒有匯率：照片留著，請使用者選一個幣別（金額不換算） */
  | { type: 'currency'; draft: WebDraft; text: string; currencies: string[] }
  /** ✏️ 修改預覽：確認了才寫。exp 是改完之後的完整內容 */
  | {
    type: 'update'
    expenseId: string
    existing: { description: string; date: string; amount: string; currency: string }
    changes: { field: string; label: string; before: string; after: string }[]
    exp: DraftExpense
  }
  /** 🗑 確認刪除 */
  | { type: 'delete'; expenseId: string; existing: { description: string; date: string; amount: string; currency: string; category: string } }
  /** 使用者想改已經存檔的那筆、但沒說是哪一筆：前端列出最近幾筆讓他點 */
  | { type: 'pick_existing'; text: string }

export interface ChatReply {
  blocks: ChatBlock[]
  /** 要接到前端對話紀錄後面的幾輪（下一則訊息再帶上來給模型看） */
  history: HistoryTurn[]
}

export interface ActionReply {
  ok: boolean
  text: string
  expenseId?: string
}

export interface ChatScope {
  db: SupabaseClient
  trip: TripRow
  /** 開放版：登入的帳號（AI 次數記在這裡） */
  userId?: string
}

/** 開放版：叫 AI 前先扣這趟的次數；扣不到回一句說明（舊版一律放行） */
async function chargeAi(scope: ChatScope, kind: AiKind): Promise<ChatReply | null> {
  if (!IS_PUBLIC) return null
  const r = await consumeAi(scope.db, scope.trip.id, userActor(scope.userId ?? 'unknown'), kind)
  return r.ok ? null : { blocks: [{ type: 'text', text: quotaReply(r) }], history: [] }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 刪掉網頁聊天自己上傳、而且還沒有支出用到的照片。
 * 同一個資料夾裡還有 LINE 草稿與表單的照片，只靠「路徑在這趟旅程底下」不夠 ——
 * 這支函式只認旅程 id，不能讓人拿它刪掉已經存好的收據。
 */
async function removeChatPhotos(db: SupabaseClient, tripId: string, candidates: string[]): Promise<void> {
  const paths = candidates
    .filter((p) => isTripPhotoPath(p, tripId) && p.slice(p.lastIndexOf('/') + 1).startsWith('chat_'))
    .slice(0, 10)
  if (paths.length === 0) return
  const { data: used } = await db.from('expenses').select('photo_urls').eq('trip_id', tripId).overlaps('photo_urls', paths)
  const keep = new Set(((used ?? []) as { photo_urls: string[] }[]).flatMap(r => r.photo_urls ?? []))
  const removable = paths.filter(p => !keep.has(p))
  if (removable.length > 0) await photoStore(db).remove(removable)
}

function newNonce(): string {
  return Math.random().toString(36).substring(2, 10)
}

function toShort(e: { description: string; amount: number; currency: string; date: string; category: string; payer_data: Record<string, number>; split_details: Record<string, number> }): DraftExpense {
  return { d: e.description, a: e.amount, c: e.currency, dt: e.date, cat: e.category, p: e.payer_data, s: e.split_details }
}

/** 照片放哪：舊版 Supabase 公開 bucket；開放版 Cloudflare R2（沒設金鑰時退回私有 bucket） */
const R2_CONFIG = IS_PUBLIC ? r2ConfigFromEnv(k => Deno.env.get(k)) : null
function photoStore(db: SupabaseClient): PhotoStore {
  return R2_CONFIG ? createR2Store(R2_CONFIG, db) : createSupabaseStore(db, RECEIPTS_BUCKET, !IS_PUBLIC)
}

/** 讓 AI 讀照片的網址：舊版公開網址；開放版 10 分鐘的簽名網址 */
async function photoUrl(db: SupabaseClient, path: string): Promise<string> {
  try {
    return await photoStore(db).viewUrl(path, 600)
  } catch (e) {
    console.error('[PHOTO] view url failed', e)
    return ''
  }
}

const FIELD_LABELS: Record<string, string> = {
  description: '描述', amount: '金額', currency: '幣別', date: '日期', category: '分類',
  payer_data: '付款人', split_data: '分攤', split_details: '分攤',
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）'
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '（空）'
    return entries.map(([name, amount]) => `${name} ${amount}`).join('、')
  }
  return String(value)
}

// ============================================================
// 文字訊息
// ============================================================

/** 「使用者在回覆哪一張」的說明，放在這句話前面 */
function replyTargetNote(target: ReplyTarget | null, drafts: WebDraft[]): string {
  if (!target) return ''
  if (target.kind === 'draft') {
    const draft = drafts.find(d => d.nonce === target.nonce)
    if (!draft) return ''
    // 有品項的收據：講「哪幾項是誰的」一定要走 item_assignments，金額由程式算（模型自己算的分攤常常是錯的）
    const itemsNote = draft.items.length > 0
      ? `這張有品項清單（見【尚未確認的草稿】的 #編號）。使用者講哪幾項是誰的，就把「品項編號 → 成員」填進 item_assignments、`
        + `其餘由誰分填 others，🚫 不要自己算 split_details。`
      : ''
    return `【使用者是在回覆這張還沒存的草稿 nonce=${target.nonce}】這句話是在補充或修正它，`
      + `請用 propose_expenses 回傳修正後的完整一筆，corrects_draft 填 ${target.nonce}（只是在問問題就用 reply）。${itemsNote}\n\n`
  }
  return `【使用者是在回覆已存檔的支出 ref=${expenseRef(target.id)}${target.label ? `（${target.label}）` : ''}】`
    + `這句話指的就是這一筆：要改用 propose_expense_update、要刪用 propose_expense_delete、問收據用 analyze_receipt，expense_ref 填 ${expenseRef(target.id)}。\n\n`
}

export async function handleMessage(scope: ChatScope, req: ChatRequest): Promise<ChatReply> {
  const { db, trip } = scope
  const text = cleanText(req.text)
  if (!text) return { blocks: [{ type: 'text', text: `想記什麼或問什麼都可以直接打給我 ${PERSONA.emoji}` }], history: [] }
  const blocked = await chargeAi(scope, 'text')
  if (blocked) return blocked

  const memberName = cleanMemberName(req.memberName)
  const drafts = cleanDrafts(req.drafts, trip.id)
  const outstanding = drafts.map(d => toOutstanding(d, trip.id))
  const target = cleanReplyTarget(req.replyTo)
  const history = cleanHistory(req.history, CHAT_HISTORY_TURNS)
  const startedAt = Date.now()

  const [recentExpenses, itinerary] = await Promise.all([
    loadRecentExpenses(db, trip.id),
    loadItinerary(trip),
  ])
  const today = tripToday(trip)
  const precision = (trip.precision_config ?? {}) as Record<string, number>

  const tripContext = buildTripContext({ trip, today, memberName, itinerary, recentExpenses, drafts: outstanding })
  const conversation = buildConversation(tripContext, history, replyTargetNote(target, drafts) + text)

  // 有收據草稿時把那張收據一起送給 AI（「A 是我吃的」要看品項才知道多少錢）。
  // 使用者回覆的是哪一張就送那一張，沒有指定才像 LINE 一樣送最新的那張
  const repliedDraft = target?.kind === 'draft' ? outstanding.find(d => d.nonce === target.nonce) ?? null : null
  const photoDraft = (repliedDraft && repliedDraft.photoIds.length > 0 ? repliedDraft : null)
    ?? outstanding.find(d => d.photoIds.length > 0) ?? null
  let attachedPhoto = false
  if (photoDraft) {
    const part = await fetchPhotoPart(await photoUrl(db, photoDraft.photoIds[0]))
    if (part) {
      const lastTurn = conversation[conversation.length - 1]
      lastTurn.parts.unshift({ text: photoDraftHint(photoDraft) })
      lastTurn.parts.push(part)
      attachedPhoto = true
    }
  }

  const toolCtx: ToolContext = {
    db, trip, today, actorName: memberName,
    loadItinerary: () => loadItinerary(trip),
    placesApiKey: GOOGLE_MAPS_API_KEY || undefined,
  }
  const seenText: string[] = conversation.flatMap((m) => m.parts.map((part) => ('text' in part ? part.text : '')))
  let notice: string | undefined

  const timezone = trip.timezone ?? itinerary?.timeZone ?? undefined
  const searchLocation = {
    city: itinerary?.days.find((d) => d.date === today)?.city,
    country: timezone ? countryForTimezone(timezone) : undefined,
    timezone,
  }

  const runLoop = (messages: typeof conversation, webSearch: boolean) => ai.runToolLoop({
    task: attachedPhoto ? 'vision' : 'text',
    messages,
    system: YOSHI_SYSTEM_INSTRUCTION,
    declarations: TEXT_TOOL_DECLARATIONS,
    terminalNames: TERMINAL_TOOL_NAMES,
    // ⚠️ 只讓模型執行唯讀工具（名字是模型給的字串，這裡再擋一次）
    execute: async (name: string, args: ToolArgs) => {
      if (name === TRIP_SUMMARY_TOOL) return loadTripSummary(db, trip)
      if (!READ_TOOL_NAMES.includes(name)) return { error: `Tool ${name} is not available here` }
      const output = await runTool(name, args, toolCtx)
      seenText.push(JSON.stringify(output))
      return output
    },
    maxRounds: 4,
    deadlineAt: startedAt + AI_DEADLINE_MS,
    temperature: 0.4,
    webSearch: webSearch ? { maxUses: WEB_SEARCH_MAX_USES, location: searchLocation } : undefined,
    onFallback: (reason) => { notice = FALLBACK_NOTICES[reason] },
  })

  const userTurn: HistoryTurn = { role: 'user', content: text }
  const withNotice = (blocks: ChatBlock[]): ChatBlock[] => notice ? [{ type: 'text', text: notice }, ...blocks] : blocks

  try {
    let result = await runLoop(conversation, true)

    // 防線（與 LINE 相同）：草稿還在、這句話像在補欄位，模型卻只用 reply 回文字 —— 帶著提醒再問一次
    if (result.call.name === 'reply' && outstanding.length > 0 && (mentionsDraftField(text) || repliedDraft)
      && startedAt + AI_DEADLINE_MS - Date.now() > DRAFT_RETRY_MIN_MS) {
      console.log(`[GUARD] Reply while a draft is outstanding, asking again: "${text.substring(0, 80)}"`)
      const hint = draftRetryHint(repliedDraft ? [repliedDraft.nonce] : outstanding.map(d => d.nonce))
      const retryConversation = conversation.map((m, i) => i === conversation.length - 1
        ? { ...m, parts: [...m.parts, { text: hint }] }
        : m)
      const retried = await runLoop(retryConversation, false)
      if (retried.call.name === 'propose_expenses') result = retried
    }

    console.log(`[AI] ${result.model} → ${result.call.name} ${JSON.stringify(result.call.args).substring(0, 600)}`)
    const { args, name } = result.call

    if (name === 'propose_expenses') {
      // 使用者明確回覆了某張草稿，模型只回一筆卻忘了填 corrects_draft：那一筆就是在修正它
      const list = Array.isArray(args.expenses) ? args.expenses : []
      if (repliedDraft && !optionalString(args.corrects_draft) && list.length === 1) {
        args.corrects_draft = repliedDraft.nonce
      }
      const outcome = prepareProposedExpenses(args, {
        trip, today, memberName, cleanText: text, drafts: outstanding, extraText: result.extraText,
      })
      if (outcome.kind === 'edit_existing') {
        return {
          blocks: withNotice([{ type: 'pick_existing', text: '看起來你想改已經存入的紀錄，是哪一筆呢？點一下就能改。如果其實是要新記一筆，請不要用「改」來描述。' }]),
          history: [userTurn],
        }
      }
      if (outcome.kind === 'message') {
        return { blocks: withNotice([{ type: 'text', text: outcome.text }]), history: [userTurn, { role: 'model', content: outcome.text }] }
      }
      const blocks: ChatBlock[] = outcome.notes.length > 0 ? [{ type: 'text', text: outcome.notes.join('\n') }] : []
      const modelTurns: HistoryTurn[] = []
      outcome.proposals.forEach((p, idx) => {
        const nonce = newNonce()
        const draft: WebDraft = {
          nonce, exp: toShort(p.expense), photoIds: p.photoIds, receipt: p.receipt, items: p.items, subtotal: p.subtotal,
        }
        blocks.push({
          type: 'draft', draft, title: '🤖 AI 記帳預覽',
          replaces: idx === 0 && outcome.correctedDraft ? outcome.correctedDraft.nonce : undefined,
        })
        // 摘要要帶 nonce，下一輪模型才指名得出它要修正哪一張（與 LINE 同格式）
        modelTurns.push({ role: 'model', content: `[記帳建議] ${JSON.stringify({ ...p.expense, nonce }, null, 2)}` })
      })
      return { blocks: withNotice(blocks), history: [userTurn, ...modelTurns] }
    }

    if (name === 'propose_expense_update') {
      const outcome = prepareProposedUpdate(await findExpenseByRef(db, trip.id, args.expense_ref), args, {
        trip, today, memberName, cleanText: text, extraText: result.extraText,
      })
      if (outcome.kind === 'message') {
        return { blocks: withNotice([{ type: 'text', text: outcome.text }]), history: [userTurn, { role: 'model', content: outcome.text }] }
      }
      const { result: upd, existing, notes } = outcome
      const ref = expenseRef(existing.id)
      const blocks: ChatBlock[] = notes.length > 0 ? [{ type: 'text', text: notes.join('\n') }] : []
      blocks.push({
        type: 'update',
        expenseId: existing.id,
        existing: {
          description: existing.description, date: existing.date,
          amount: formatAmountDisplay(existing.amount, existing.currency, precision), currency: existing.currency,
        },
        changes: upd.changes.map(c => ({
          field: c.field, label: FIELD_LABELS[c.field] ?? c.field,
          before: formatFieldValue(c.before), after: formatFieldValue(c.after),
        })),
        exp: toShort(upd.expense),
      })
      return {
        blocks: withNotice(blocks),
        history: [userTurn, {
          role: 'model',
          content: `[修改建議 ${ref}] ${existing.description}：`
            + upd.changes.map(c => `${c.field} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join('；'),
        }],
      }
    }

    if (name === 'propose_expense_delete') {
      const existing = await findExpenseByRef(db, trip.id, args.expense_ref)
      if (!existing) {
        return { blocks: withNotice([{ type: 'text', text: REF_NOT_FOUND_TEXT }]), history: [userTurn] }
      }
      const blocks: ChatBlock[] = result.extraText ? [{ type: 'text', text: result.extraText }] : []
      blocks.push({
        type: 'delete',
        expenseId: existing.id,
        existing: {
          description: existing.description, date: existing.date,
          amount: formatAmountDisplay(existing.amount, existing.currency, precision),
          currency: existing.currency, category: existing.category,
        },
      })
      return {
        blocks: withNotice(blocks),
        history: [userTurn, {
          role: 'model',
          content: `[刪除建議 ${expenseRef(existing.id)}] ${existing.description} ${existing.amount} ${existing.currency}（等待使用者確認）`,
        }],
      }
    }

    if (name === 'analyze_receipt') {
      const answer = await analyzeReceipt(scope, args, text, precision, photoDraft)
      return { blocks: withNotice([{ type: 'text', text: answer.text }]), history: [userTurn, { role: 'model', content: answer.history }] }
    }

    // reply（或任何不認得的終結函式）
    // 網頁聊天會把網址畫成連結，長度上限放寬一點
    const safe = sanitizeReplyText(args.text, seenText.join('\n'), 8000)
    return { blocks: withNotice([{ type: 'text', text: safe }]), history: [userTurn, { role: 'model', content: safe }] }
  } catch (e) {
    console.error('[AI_ERROR]', e)
    const msg = aiUnavailableMessage(e) ?? '😵 AI 處理時發生錯誤，請稍後再試。'
    // 失敗的這句不進對話紀錄：使用者多半會再講一次
    return { blocks: [{ type: 'text', text: msg }], history: [] }
  }
}

/** 重新閱讀某一筆的收據並回答。LINE 要先回一句再推播；網頁就在同一個請求裡答完 */
async function analyzeReceipt(
  scope: ChatScope,
  args: ToolArgs,
  text: string,
  precision: Record<string, number>,
  photoDraft: OutstandingDraft | null,
): Promise<{ text: string; history: string }> {
  const { db, trip } = scope
  const question = optionalString(args.question) ?? '請詳細描述此收據的所有品項與金額'
  const label = (e: RecentExpense) => `${e.description} ${formatAmountDisplay(e.amount, e.currency, precision)} ${e.currency}`

  const byRef = await findExpenseByRef(db, trip.id, args.expense_ref)
  // 沒指名已存的那一筆、而聊天室裡有一張還沒存的收據草稿：問的就是那一張（LINE 只能找已存的）
  if (!byRef && photoDraft) {
    const d = photoDraft.exp
    const draftLabel = `${d.d ?? ''} ${d.a ?? ''} ${d.c ?? ''}`.trim()
    try {
      const content = await analyzeReceiptPhoto(ai, await Promise.all(photoDraft.photoIds.map(p => photoUrl(db, p))), question, draftLabel)
      return { text: `🔍 ${draftLabel}（還沒存）\n\n${content}`, history: `[收據分析 草稿 ${photoDraft.nonce}] ${content}` }
    } catch (err) {
      console.error('[ANALYZE_DRAFT_PHOTO_ERROR]', err)
    }
  }
  let chosen: RecentExpense | null = byRef && (byRef.photo_urls?.length ?? 0) > 0 ? byRef as RecentExpense : null
  if (!chosen) {
    const { data: all } = await db.from('expenses')
      .select(RECENT_EXPENSE_COLUMNS)
      .eq('trip_id', trip.id)
      .is('deleted_at', null)
      .not('is_settlement', 'is', true)
      .order('date', { ascending: false })
    const withPhotos = ((all ?? []) as RecentExpense[]).filter((e) => e.photo_urls?.length > 0)
    if (withPhotos.length === 0) return { text: '😅 此旅程中找不到任何帶有收據照片的支出紀錄。', history: '找不到帶收據照片的支出' }
    chosen = await chooseReceiptExpense(ai, withPhotos, { question, cleanText: text, precision })
  }
  if (!chosen) {
    return { text: '😅 找不到符合描述的收據照片，請試著描述得更詳細一點，例如加上日期、店名或金額。', history: '找不到符合描述的收據' }
  }
  try {
    const urls = await Promise.all((chosen.photo_urls ?? []).map((path: string) => photoUrl(db, path)))
    const content = await analyzeReceiptPhoto(ai, urls, question, label(chosen))
    // 開頭標明分析的是哪一筆，使用者才看得出有沒有挑錯
    return {
      text: `🔍 ${chosen.date} ${label(chosen)}\n\n${content}`,
      history: `[收據分析 ${expenseRef(String(chosen.id ?? ''))}] ${content}`,
    }
  } catch (err) {
    console.error('[ANALYZE_PHOTO_ERROR]', err)
    return { text: '😵 無法重新分析照片，請稍後再試。', history: '收據分析失敗' }
  }
}

// ============================================================
// 收據照片
// ============================================================

/**
 * 網頁已經把照片傳到 Storage（expenses/{tripId}/…），這裡讀出來辨識。
 * ⚠️ 處理過程拋出 AI 以外的例外時要把照片刪掉，否則會留下沒有支出指向它的孤兒照片
 *    （AI 本身沒回應不算：照片留著、出一張空白卡，與 LINE 一致）。
 */
export async function handlePhoto(scope: ChatScope, req: ChatRequest): Promise<ChatReply> {
  const { db, trip } = scope
  const path = req.photoPath
  if (!isTripPhotoPath(path, trip.id)) {
    return { blocks: [{ type: 'text', text: '❌ 照片路徑不正確，請重新上傳。' }], history: [] }
  }
  if (trip.is_archived) {
    await removeChatPhotos(db, trip.id, [path])
    return { blocks: [{ type: 'text', text: '🔒 此旅程已封存，無法新增支出（照片未儲存）。' }], history: [] }
  }
  const memberName = cleanMemberName(req.memberName)
  const blocked = await chargeAi(scope, 'receipt')
  if (blocked) {
    await removeChatPhotos(db, trip.id, [path])
    return blocked
  }
  try {
    const buf = new Uint8Array(await photoStore(db).download(path))
    const today = tripToday(trip)
    const ocr = await recognizeReceipt(ai, {
      trip, memberName, today,
      tripUrl: `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`,
      imageBase64: encodeBase64(buf),
      mimeType: 'image/jpeg',
    })
    const nonce = newNonce()
    const draft: WebDraft = {
      nonce, exp: toShort(ocr.expense), photoIds: [path], receipt: !ocr.needsAmount,
      items: ocr.items, subtotal: ocr.itemsSubtotal,
    }
    if (ocr.reject) {
      // 這趟旅程沒有這個幣別的匯率：照片留著，選一個幣別就能存（金額不換算，M10）
      const text = `${ocr.fallbackNotice ? `${ocr.fallbackNotice}\n\n` : ''}${ocr.reject}\n\n📷 收據已經先幫你留著了，選一個幣別就能直接存入（金額不會換算）。`
      return {
        blocks: [{ type: 'currency', draft, text, currencies: Object.keys(trip.rates ?? {}) }],
        history: [{ role: 'model', content: `[記帳建議] ${JSON.stringify({ ...ocr.expense, photo_ids: [path], nonce }, null, 2)}` }],
      }
    }
    const blocks: ChatBlock[] = ocr.notes.length > 0 ? [{ type: 'text', text: ocr.notes.join('\n') }] : []
    blocks.push({
      type: 'draft', draft,
      title: ocr.needsAmount ? '📷 照片記帳' : '🔍 AI 辨識結果',
      needsAmount: ocr.needsAmount || undefined,
      unidentified: ocr.unidentified || undefined,
    })
    return {
      blocks,
      // 摘要要帶 nonce：接著打「這是抹茶冰淇淋 600」時模型才知道在補哪一張
      history: [{ role: 'model', content: `[記帳建議] ${JSON.stringify({ ...ocr.expense, photo_ids: [path], nonce }, null, 2)}` }],
    }
  } catch (e) {
    console.error('[OCR_ERROR]', e)
    await removeChatPhotos(db, trip.id, [path])
    const msg = aiUnavailableMessage(e) ?? '😵 處理圖片時發生錯誤，請稍後再試。'
    return { blocks: [{ type: 'text', text: msg }], history: [] }
  }
}

// ============================================================
// 卡片上的按鈕（使用者確認之後才寫）
// ============================================================

function draftToPrepared(exp: DraftExpense): PreparedExpense {
  return {
    description: String(exp.d ?? ''),
    amount: parseFloat(String(exp.a ?? 0)) || 0,
    currency: String(exp.c ?? ''),
    date: String(exp.dt ?? ''),
    category: String(exp.cat ?? ''),
    payer_data: exp.p ?? {},
    split_details: exp.s ?? {},
    adjustment_member: null,
  }
}

/** ✅ 確認存入。commitExpense 會重跑一次分帳與 Σ 檢查（卡片可能是昨天出的，成員早就變了） */
export async function handleSave(scope: ChatScope, req: ChatRequest): Promise<ActionReply> {
  const { db, trip } = scope
  const draft = cleanDraft(req.draft, trip.id)
  if (!draft) return { ok: false, text: '❌ 找不到這張卡片的內容，請重新記帳。' }
  // 前端為這張卡配好的支出 id：重送時主鍵衝突＝上一次已經存進去（commitExpense）
  const saveId = typeof req.saveId === 'string' && UUID_RE.test(req.saveId) ? req.saveId : undefined
  const memberName = cleanMemberName(req.memberName)
  const result = await commitExpense(draftToPrepared(draft.exp), {
    db, trip, today: tripToday(trip), actorName: memberName,
  }, { photoUrls: draft.photoIds, receiptPhotoUrls: draft.receipt ? draft.photoIds : [], id: saveId })

  if (!result.ok) {
    const text = result.reason === 'archived'
      ? '❌ 此旅程已封存，無法新增支出。'
      : result.reason === 'empty_participants'
        ? '😅 這筆的付款人或分攤成員是空的（可能是成員已被移除），無法存入。請在卡片上補上，或按「✏️ 編輯」。'
        : result.reason === 'dropped_members'
          ? `😅 這張卡片上的「${(result.dropped ?? []).join('、')}」已經不在旅程成員裡了，不能就這樣存入 —— 他的那一份會被默默算到別人頭上。\n\n目前成員：${trip.members.join('、')}\n\n請在卡片上重新選分攤的人。`
          : result.reason === 'invalid_amount'
            ? '😅 這筆的金額是 0（可能沒辨識到金額），不能存入。請在卡片上補上金額。'
            : result.reason === 'entry_limit'
              ? ENTRY_LIMIT_MSG
            : result.reason === 'insert_failed'
              ? '❌ 寫入資料庫失敗，這筆還沒存進去。請稍後再按一次「確認存入」。'
              : '❌ 財務運算發生錯誤，請聯絡管理員。'
    return { ok: false, text }
  }
  const text = buildSavedText({
    description: draft.exp.d,
    amount: result.amount,
    currency: String(draft.exp.c ?? ''),
    date: draft.exp.dt,
    category: draft.exp.cat,
    payer_data: result.payer_data,
    split_data: result.split_data,
  }, { header: '✅ 已存入' }, (trip.precision_config ?? {}) as Record<string, number>)
  return { ok: true, text, expenseId: result.id ?? undefined }
}

/** ✅ 確認修改。一定要重新讀那一筆：卡片可能是十分鐘前出的，中間有人改過或刪掉了 */
export async function handleUpdate(scope: ChatScope, req: ChatRequest): Promise<ActionReply> {
  const { db, trip } = scope
  if (!req.expenseId) return { ok: false, text: '❌ 找不到要修改的那一筆。' }
  const existing = await resolveExpenseRef(req.expenseId, { db, trip: { id: trip.id } }, { allowSettlement: false })
  if (!existing) return { ok: false, text: '❌ 這筆支出已不存在（可能已被刪除，或不屬於這趟旅程）。' }
  const prepared = draftToPrepared(cleanDraftExpense(req.exp))
  const result = await commitExpenseUpdate(existing.id, prepared, {
    db, trip, today: tripToday(trip), actorName: cleanMemberName(req.memberName),
  })
  if (!result.ok) {
    const text = result.reason === 'archived'
      ? '❌ 此旅程已封存，無法修改支出。'
      : result.reason === 'not_found'
        ? '❌ 這筆支出已不存在，無法修改。'
        : result.reason === 'empty_participants'
          ? '😅 修改後的付款人或分攤成員是空的（可能是成員已被移除），無法套用。請按「✏️ 編輯」處理。'
          : result.reason === 'dropped_members'
            ? `😅 這張修改卡上的「${(result.dropped ?? []).join('、')}」已經不在旅程成員裡了，不能就這樣套用。\n\n目前成員：${trip.members.join('、')}`
            : result.reason === 'invalid_amount'
              ? '😅 修改後的金額必須大於 0，無法套用。'
              : '❌ 財務運算發生錯誤，請聯絡管理員。'
    return { ok: false, text }
  }
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
    .map(([field]) => FIELD_LABELS[field] ?? field)
  const text = buildSavedText({
    description: prepared.description, amount: prepared.amount, currency: prepared.currency,
    date: prepared.date, category: prepared.category,
    payer_data: prepared.payer_data, split_data: prepared.split_details,
  }, {
    header: '✏️ 已修改',
    note: changed.length > 0 ? `改了：${changed.join('、')}` : '（內容與原本相同）',
  }, (trip.precision_config ?? {}) as Record<string, number>)
  return { ok: true, text, expenseId: existing.id }
}

/** 🗑 確認刪除與 ↩️ 撤銷：軟刪除，24 小時內可從垃圾桶還原 */
export async function handleDelete(scope: ChatScope, req: ChatRequest, mode: 'delete' | 'undo'): Promise<ActionReply> {
  const { db, trip } = scope
  if (!req.expenseId) return { ok: false, text: '❌ 找不到這筆支出。' }
  // 存入、修改都會擋封存，刪除與撤銷也要（deleteExpense 本身不看旅程狀態）
  if (trip.is_archived) return { ok: false, text: `❌ 此旅程已封存，無法${mode === 'undo' ? '撤銷' : '刪除'}支出。` }
  const result = await deleteExpense(req.expenseId, { db, trip: { id: trip.id } })
  if (!result.ok) {
    const text = result.reason === 'already_deleted'
      ? `ℹ️ 「${result.description}」先前已經${mode === 'undo' ? '撤銷' : '刪除'}了。`
      : result.reason === 'not_found'
        ? '❌ 這筆支出已不存在。'
        : `❌ ${mode === 'undo' ? '撤銷' : '刪除'}失敗，請到帳目手動處理。`
    return { ok: result.reason === 'already_deleted', text }
  }
  return {
    ok: true,
    text: mode === 'undo'
      ? `↩️ 已撤銷：${result.description}`
      : `🗑 已刪除：${result.description}\n\n24 小時內可到垃圾桶還原。`,
    expenseId: req.expenseId,
  }
}

/** ❌ 取消草稿：把已經上傳的照片刪掉（只收這趟旅程資料夾裡的） */
export async function handleDiscard(scope: ChatScope, req: ChatRequest): Promise<ActionReply> {
  const { db, trip } = scope
  const paths = (Array.isArray(req.photoIds) ? req.photoIds : []).filter((p): p is string => typeof p === 'string')
  await removeChatPhotos(db, trip.id, paths)
  return { ok: true, text: '❌ 已取消。' }
}
