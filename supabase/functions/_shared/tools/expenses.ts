// ============================================================
// tools/expenses.ts —— 支出的驗證、寫入、查詢
//
// 這裡是「一筆支出怎麼從外面進到資料庫」的**唯一**實作。
// 在它出現以前同一段驗證在 line-webhook 裡有三份（OCR、文字、確認存入），
// 改了其中一份而忘了另外兩份是這個專案反覆出現的 bug 型態。
//
// 兩段式：
//   prepare* -- 只算不寫，可以放心在「還沒確認」的階段跑（LINE 的預覽卡片就是）
//   commit*  -- 只寫不猜，重跑一次分帳與 Σ 檢查才落地
//
// ⚠️ 只 import ../deps.ts、../finance.ts、../validate.ts、../types.ts ——
//    不碰 Deno.env、不建 client，vitest 才測得動（見 expenses.test.ts）。
// ============================================================

import { Decimal } from "../deps.ts"
import { calculateDistribution, DEFAULT_PRECISION } from "../finance.ts"
import {
  applyParticipantDefaults,
  type MutableExpense,
  normalizeCurrency,
  normalizeDate,
  normalizeExpenseAmountMaps,
  resolveCategory,
  resolveCurrencyByRule,
  resolveExpenseMembers,
} from "../validate.ts"
import type { AmountMap, ExpenseRow, TripRow } from "../types.ts"
import type {
  CommitExpenseResult,
  CommitUpdateResult,
  DeleteExpenseResult,
  ExpenseBrief,
  ExpenseInput,
  FieldChange,
  ListExpensesFilters,
  ListExpensesResult,
  PrepareResult,
  PrepareUpdateResult,
  PreparedExpense,
  ResolveRefOptions,
  RestoreExpenseResult,
  ScopedContext,
  ToolContext,
} from "./types.ts"

/** listExpenses 一次最多從資料庫拉幾列（記憶體過濾之前） */
const MAX_SQL_ROWS = 200
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 50

/** 給 AI 看的短編號：uuid 前 8 碼。完整 uuid 太長，模型抄不準（T4）。 */
export function expenseRef(id: string): string {
  return String(id ?? '').substring(0, 8)
}

/** 這個幣別在這趟旅程要用幾位小數。務必走這裡，不要各自寫 `?? 2`。 */
export function expensePrecision(trip: TripRow, currency: string): number {
  return (trip?.precision_config ?? {})[currency] ?? DEFAULT_PRECISION[currency] ?? 2
}

/**
 * 把一組「成員 → 金額」轉成 calculateDistribution 的 lockedData。
 *
 * 全部是 0 代表那只是佔位（applyParticipantDefaults 補的，或 AI 只列了名字），
 * 意思是「請均分」；照原樣傳下去的話 0 會被當成鎖定金額，
 * 整筆餘額會落到調整成員一個人身上（H6）。
 */
function lockedFrom(map: AmountMap): AmountMap {
  const entries = Object.entries(map ?? {})
  if (entries.length === 0) return {}
  if (entries.every(([, v]) => !(Number(v) || 0))) return {}
  const out: AmountMap = {}
  for (const [k, v] of entries) out[k] = Number(v) || 0
  return out
}

/** 餘數要算在誰頭上：優先挑「既付款又分攤」的人，否則分攤名單的第一位 */
function pickAdjustmentMember(payers: string[], splits: string[]): string | null {
  return payers.find((m) => splits.includes(m)) ?? splits[0] ?? null
}

/** Σ(map) === 金額嗎。金額一律走 Decimal（CLAUDE.md 的硬性規則）。 */
function sumsMatch(map: AmountMap, target: InstanceType<typeof Decimal>): boolean {
  const sum = Object.values(map ?? {}).reduce(
    (acc: InstanceType<typeof Decimal>, v) => acc.plus(new Decimal(Number(v) || 0)),
    new Decimal(0),
  )
  return sum.equals(target)
}

export interface PrepareOptions {
  /** 這趟旅程的「今天」，日期驗證的基準 */
  today: string
  /** 這次操作是誰做的。付款人補預設值時會用到。 */
  actorName?: string | null
  /**
   * 使用者原本說的那句話，用來驗證「幣別真的是他講的嗎」。
   * ⚠️ **null 代表沒有文字可驗（收據 OCR），此時 `stated` 直接採信。**
   */
  sourceText: string | null
}

/**
 * 把外面給的一筆支出正規化成可以落地的內容。
 *
 * 順序就是規格，不要重排：
 *   金額欄位轉 map → 成員對應 → 幣別規則 → 幣別驗證 → 日期 → 分類
 *   → 補預設參與者 → 依精度四捨五入 → 分帳
 *
 * 幣別為什麼要兩關（T3）：`resolveCurrencyByRule` 決定「該用哪一個」——
 * 小模型常把 context 裡的結算主幣當成該填的值；`normalizeCurrency` 才檢查
 * 「這趟旅程認不認得它」。少了前者，主幣 TWD／預設 JPY 的旅程打「夾娃娃300」
 * 會出一張 TWD 的卡片。
 */
export function prepareExpense(
  input: ExpenseInput,
  trip: TripRow,
  opts: PrepareOptions,
): PrepareResult {
  const draft: MutableExpense = {
    description: String(input?.description ?? ''),
    amount: Number(input?.amount) || 0,
    currency: input?.currency,
    currency_source: input?.currency_source,
    date: input?.date,
    category: input?.category,
    payer_data: input?.payer_data as Record<string, unknown> | undefined,
    split_details: input?.split_details as Record<string, unknown> | undefined,
  }

  normalizeExpenseAmountMaps(draft)
  const { unresolved } = resolveExpenseMembers(draft, trip?.members ?? [])

  const rule = resolveCurrencyByRule(draft.currency, draft.currency_source, opts.sourceText, trip)
  if (rule.overrode) {
    console.log(`[CURRENCY] Source said ${draft.currency} (source=${draft.currency_source}) but the rule says ${rule.currency}`)
  }
  const currencyCheck = normalizeCurrency(rule.currency, trip)
  const currency = currencyCheck.currency

  const dateCheck = normalizeDate(draft.date, opts.today)
  const categoryCheck = resolveCategory(draft.category, trip?.categories ?? [], trip?.default_category)

  // AI 偶爾會回空的付款人或分攤，卡片上那一區會整片空白，
  // 按下確認才在 Σ 檢查那裡爆掉。先套上與網頁快速記帳一致的預設值（H6）。
  const { filledPayer, filledSplit } = applyParticipantDefaults(draft, trip, opts.actorName)

  const precision = expensePrecision(trip, currency)
  const amount = new Decimal(Number(draft.amount) || 0).toDecimalPlaces(precision).toNumber()

  const payerMap = (draft.payer_data ?? {}) as AmountMap
  const splitMap = (draft.split_details ?? {}) as AmountMap
  const payerMembers = Object.keys(payerMap)
  const splitMembers = Object.keys(splitMap)
  const adjustMember = pickAdjustmentMember(payerMembers, splitMembers)

  // 補上的預設值只是 0 佔位，lockedData 必須傳 {} 讓它均分（H6）
  const payer_data = payerMembers.length > 0
    ? calculateDistribution(amount, payerMembers, filledPayer ? {} : payerMap, payerMembers[0], precision)
    : {}
  const split_details = splitMembers.length > 0
    ? calculateDistribution(amount, splitMembers, filledSplit ? {} : splitMap, adjustMember, precision)
    : {}

  return {
    // ⚠️ reject 有值時也照樣回傳正規化後的內容 —— OCR 的「以 XXX 存入」流程
    //    要靠它把辨識結果先存成 pending，使用者才不必重拍收據（M10）。
    expense: {
      description: String(draft.description ?? ''),
      amount,
      currency,
      date: dateCheck.date,
      category: categoryCheck.category,
      payer_data,
      split_details,
      adjustment_member: adjustMember,
    },
    warnings: [currencyCheck.warning, categoryCheck.warning, dateCheck.warning].filter(Boolean) as string[],
    unresolvedMembers: unresolved,
    reject: currencyCheck.reject,
  }
}

export interface CommitOptions {
  /** Storage 的完整路徑（例如 `expenses/{tripId}/{id}.jpg`）。id → 路徑的轉換留在呼叫端。 */
  photoUrls?: string[]
}

/**
 * 把準備好的支出寫進資料庫。
 *
 * 這裡會**重跑一次**分帳與 Σ 檢查，因為 prepare 與 commit 之間可能隔了很久
 * （LINE 的卡片可能昨天就發出去了），成員清單早就變了。
 *
 * 不設 `is_settlement`：結清紀錄只能從網頁產生，這條路徑進來的一律是消費。
 */
export async function commitExpense(
  prepared: PreparedExpense,
  ctx: ToolContext,
  opts: CommitOptions = {},
): Promise<CommitExpenseResult> {
  const trip = ctx.trip
  // 旅程可能已被後台刪除（見 docs/DB_MAINTENANCE.md）。呼叫端多半已經擋掉，
  // 這裡只是不讓一個 null 把整支函式炸掉。
  if (!trip) return { ok: false, reason: 'trip_missing' }
  if (trip.is_archived) return { ok: false, reason: 'archived' }

  const members = trip.members ?? []
  const payerKeys = Object.keys(prepared.payer_data ?? {})
  const splitKeys = Object.keys(prepared.split_details ?? {})
  const payerMembers = payerKeys.filter((m) => members.includes(m))
  const splitMembers = splitKeys.filter((m) => members.includes(m))

  // 走到這裡還是空的多半是成員在存檔前被刪掉了 —— 以前會一路掉到「Σ != 總額」，
  // 使用者收到的是「財務運算發生錯誤，請聯絡管理員」這種毫無頭緒的訊息。
  if (payerMembers.length === 0 || splitMembers.length === 0) {
    console.warn(`[SAVE] Empty participants after filtering. trip=${trip.id}`)
    return { ok: false, reason: 'empty_participants' }
  }

  // 卡片上有、但成員清單裡已經沒有的名字（M12）。
  // ⚠️ 不能默默存下去：被移除的人的份額會被 calculateDistribution 當成餘數
  //    加到調整成員身上，Σ 仍然等於總額，所以下面的檢查也攔不住 ——
  //    帳面上完全正常，只是有個人平白多背了一份。
  const dropped = [...new Set([
    ...payerKeys.filter((m) => !members.includes(m)),
    ...splitKeys.filter((m) => !members.includes(m)),
  ])]
  if (dropped.length > 0) {
    console.warn(`[SAVE] Members no longer in trip: ${dropped.join(', ')}`)
    return { ok: false, reason: 'dropped_members', dropped }
  }

  const precision = expensePrecision(trip, prepared.currency)
  const target = new Decimal(parseFloat(String(prepared.amount)) || 0).toDecimalPlaces(precision)
  const numAmount = target.toNumber()
  const adjustMember = pickAdjustmentMember(payerMembers, splitMembers)

  const finalPayerData = calculateDistribution(numAmount, payerMembers, prepared.payer_data, payerMembers[0], precision)
  const finalSplitData = calculateDistribution(numAmount, splitMembers, prepared.split_details, adjustMember, precision)

  if (!sumsMatch(finalPayerData, target) || !sumsMatch(finalSplitData, target)) {
    console.error(`[CRITICAL_VALIDATION_ERROR] Sum mismatch. trip=${trip.id} amount=${target}`)
    return { ok: false, reason: 'sum_mismatch' }
  }

  const { data: saved } = await ctx.db.from('expenses').insert({
    trip_id: trip.id,
    description: prepared.description,
    amount: numAmount,
    currency: prepared.currency,
    payer_data: finalPayerData,
    split_data: finalSplitData,
    date: prepared.date,
    category: prepared.category,
    photo_urls: opts.photoUrls ?? [],
    adjustment_member: adjustMember,
  }).select('id').single()

  return { ok: true, id: saved?.id ?? null, adjustment_member: adjustMember }
}

/**
 * 算出「把既有支出改成這樣」之後的完整內容。
 *
 * 規則：
 * - patch 沒給的欄位一律沿用原值，**不重新驗證**（存在資料庫裡的值已經驗過了）
 * - 金額或幣別變了、但 payer／split 沒給 → 沿用原本的參與者重新均分
 *   （與 `src/components/ExpenseModal.tsx` 一致：金額一改就清掉 baseline 讓它重算）
 * - `adjustment_member` 只要還在分攤名單裡就沿用，否則重挑
 * - 幣別變更會依**新幣別的精度**重算金額與分帳
 *   ⚠️ 網頁的 ExpenseModal 不會這樣做（它只換標籤），這是已知差異，見 LINE_SCENARIOS J20
 */
export function prepareExpenseUpdate(
  existing: ExpenseRow,
  patch: Partial<ExpenseInput>,
  trip: TripRow,
  opts: PrepareOptions,
): PrepareUpdateResult {
  const warnings: string[] = []

  // ── 幣別 ──
  let currency = existing.currency
  let reject: string | null = null
  if (patch?.currency !== undefined) {
    const rule = resolveCurrencyByRule(patch.currency, patch.currency_source, opts.sourceText, trip)
    const check = normalizeCurrency(rule.currency, trip)
    currency = check.currency
    reject = check.reject
    if (check.warning) warnings.push(check.warning)
  }

  // ── 分類 ──
  let category = existing.category
  if (patch?.category !== undefined) {
    const check = resolveCategory(patch.category, trip?.categories ?? [], trip?.default_category)
    category = check.category
    if (check.warning) warnings.push(check.warning)
  }

  // ── 日期 ──
  let date = existing.date
  if (patch?.date !== undefined) {
    const check = normalizeDate(patch.date, opts.today)
    date = check.date
    if (check.warning) warnings.push(check.warning)
  }

  const description = patch?.description !== undefined
    ? String(patch.description ?? '')
    : existing.description

  // ── 參與者 ──
  // patch 給了就用 patch 的（先做成員對應），沒給就沿用原本的名單。
  const givenPayer = patch?.payer_data !== undefined
  const givenSplit = patch?.split_details !== undefined
  const participants: MutableExpense = {
    payer_data: (givenPayer ? patch.payer_data : existing.payer_data) as Record<string, unknown>,
    split_details: (givenSplit ? patch.split_details : existing.split_data) as Record<string, unknown>,
  }
  normalizeExpenseAmountMaps(participants)
  const { unresolved } = resolveExpenseMembers(participants, trip?.members ?? [])
  const payerMap = (participants.payer_data ?? {}) as AmountMap
  const splitMap = (participants.split_details ?? {}) as AmountMap

  const precision = expensePrecision(trip, currency)
  const rawAmount = patch?.amount !== undefined ? Number(patch.amount) || 0 : existing.amount
  const amount = new Decimal(rawAmount || 0).toDecimalPlaces(precision).toNumber()

  // 金額或幣別動了而沒指定新的分帳 → 舊金額已經沒有意義，整組重新均分
  const amountChanged = !new Decimal(amount).equals(new Decimal(existing.amount || 0))
  const currencyChanged = currency !== existing.currency
  const redistribute = (amountChanged || currencyChanged)

  const payerMembers = Object.keys(payerMap)
  const splitMembers = Object.keys(splitMap)

  const keepAdjust = existing.adjustment_member && splitMembers.includes(existing.adjustment_member)
  const adjustMember = keepAdjust
    ? existing.adjustment_member
    : pickAdjustmentMember(payerMembers, splitMembers)

  const payerLocked = (redistribute && !givenPayer) ? {} : lockedFrom(payerMap)
  const splitLocked = (redistribute && !givenSplit) ? {} : lockedFrom(splitMap)

  const payer_data = payerMembers.length > 0
    ? calculateDistribution(amount, payerMembers, payerLocked, payerMembers[0], precision)
    : {}
  const split_details = splitMembers.length > 0
    ? calculateDistribution(amount, splitMembers, splitLocked, adjustMember, precision)
    : {}

  const expense: PreparedExpense = {
    description, amount, currency, date, category,
    payer_data, split_details,
    adjustment_member: adjustMember,
  }

  const changes: FieldChange[] = []
  const track = (field: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ field, before, after })
  }
  track('description', existing.description, expense.description)
  track('amount', existing.amount, expense.amount)
  track('currency', existing.currency, expense.currency)
  track('date', existing.date, expense.date)
  track('category', existing.category, expense.category)
  track('payer_data', sortedMap(existing.payer_data), sortedMap(expense.payer_data))
  track('split_data', sortedMap(existing.split_data), sortedMap(expense.split_details))

  return { expense, warnings, unresolvedMembers: unresolved, reject, changes }
}

/** 比對 map 時要忽略 key 的順序，否則「沒改」也會被算成一次異動 */
function sortedMap(map: AmountMap | null | undefined): AmountMap {
  const out: AmountMap = {}
  Object.keys(map ?? {}).sort().forEach((k) => { out[k] = Number((map ?? {})[k]) || 0 })
  return out
}

/**
 * 把修改寫回去。
 *
 * ⚠️ 只動使用者真的改得到的那幾欄。特別是：
 *    - `is_settlement` 不能碰 —— 硬寫 false 會把結清變成一般支出，統計立刻失真（J10）
 *    - `photo_urls` 不能碰 —— 這條路徑沒有照片可傳，寫下去等於把收據弄丟
 *    - `deleted_at` 不能碰 —— 刷新它會讓垃圾桶的 24 小時保留期重算（H3）
 */
export async function commitExpenseUpdate(
  expenseId: string,
  prepared: PreparedExpense,
  ctx: ToolContext,
): Promise<CommitUpdateResult> {
  const trip = ctx.trip
  if (!trip) return { ok: false, reason: 'not_found' }
  if (trip.is_archived) return { ok: false, reason: 'archived' }

  const payerMembers = Object.keys(prepared.payer_data ?? {})
  const splitMembers = Object.keys(prepared.split_details ?? {})
  if (payerMembers.length === 0 || splitMembers.length === 0) {
    return { ok: false, reason: 'empty_participants' }
  }

  const precision = expensePrecision(trip, prepared.currency)
  const target = new Decimal(parseFloat(String(prepared.amount)) || 0).toDecimalPlaces(precision)
  if (!sumsMatch(prepared.payer_data, target) || !sumsMatch(prepared.split_details, target)) {
    console.error(`[CRITICAL_VALIDATION_ERROR] Update sum mismatch. expense=${expenseId}`)
    return { ok: false, reason: 'sum_mismatch' }
  }

  const { data } = await ctx.db.from('expenses')
    .update({
      description: prepared.description,
      amount: target.toNumber(),
      currency: prepared.currency,
      date: prepared.date,
      category: prepared.category,
      payer_data: prepared.payer_data,
      split_data: prepared.split_details,
      adjustment_member: prepared.adjustment_member,
    })
    .eq('id', expenseId)
    .eq('trip_id', trip.id)
    .is('deleted_at', null)
    .select('id')

  // 0 列受影響＝這筆不屬於這趟旅程，或已經在垃圾桶裡了
  if (!data || data.length === 0) return { ok: false, reason: 'not_found' }
  return { ok: true, id: expenseId }
}

/**
 * 軟刪除一筆支出。
 *
 * ⚠️ 已經在垃圾桶裡的**不能再 UPDATE 一次**：`deleted_at` 被刷新的話，
 *    網頁垃圾桶的 24 小時保留期會整個重算（H3）。
 */
export async function deleteExpense(
  expenseId: string,
  ctx: ScopedContext,
): Promise<DeleteExpenseResult> {
  const { data: target } = await ctx.db.from('expenses')
    .select('description, deleted_at')
    .eq('id', expenseId)
    .eq('trip_id', ctx.trip.id)
    .maybeSingle()

  if (!target) return { ok: false, reason: 'not_found' }
  const description = target.description || ''
  if (target.deleted_at) return { ok: false, reason: 'already_deleted', description }

  const { error } = await ctx.db.from('expenses')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', expenseId)
    .eq('trip_id', ctx.trip.id)
    .is('deleted_at', null)
  if (error) return { ok: false, reason: 'update_failed', description }

  return { ok: true, description }
}

/** 從垃圾桶還原。與 deleteExpense 對稱：還原「沒有被刪掉的」是不合理的請求。 */
export async function restoreExpense(
  expenseId: string,
  ctx: ScopedContext,
): Promise<RestoreExpenseResult> {
  const { data: target } = await ctx.db.from('expenses')
    .select('description, deleted_at')
    .eq('id', expenseId)
    .eq('trip_id', ctx.trip.id)
    .maybeSingle()

  if (!target) return { ok: false, reason: 'not_found' }
  const description = target.description || ''
  if (!target.deleted_at) return { ok: false, reason: 'not_deleted', description }

  const { error } = await ctx.db.from('expenses')
    .update({ deleted_at: null })
    .eq('id', expenseId)
    .eq('trip_id', ctx.trip.id)
    .not('deleted_at', 'is', null)
  if (error) return { ok: false, reason: 'update_failed', description }

  return { ok: true, description }
}

/**
 * 條件查詢。
 *
 * 能交給資料庫的（日期、分類、結清、垃圾桶）就交給資料庫，
 * 成員與關鍵字則在記憶體過濾 —— 前者要看 JSONB 的 key，後者要不分大小寫，
 * 兩件事用 PostgREST 表達都很彆扭。SQL 端最多取 200 列封頂，
 * 是為了不讓「整趟旅程」的查詢把 Edge Function 的記憶體吃光。
 */
export async function listExpenses(
  filters: ListExpensesFilters,
  ctx: ScopedContext,
): Promise<ListExpensesResult> {
  const limit = Math.min(Math.max(1, Number(filters?.limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT)

  let query = ctx.db.from('expenses')
    .select('id, date, description, amount, currency, category, payer_data, split_data, photo_urls, is_settlement')
    .eq('trip_id', ctx.trip.id)
    .is('deleted_at', null)
  if (!filters?.includeSettlements) query = query.not('is_settlement', 'is', true)
  if (filters?.from) query = query.gte('date', filters.from)
  if (filters?.to) query = query.lte('date', filters.to)
  if (filters?.category) query = query.eq('category', filters.category)

  const { data } = await query
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MAX_SQL_ROWS)

  const rows = (data ?? []) as ExpenseRow[]
  const keyword = String(filters?.keyword ?? '').trim().toLowerCase()
  const member = String(filters?.member ?? '').trim()
  const payer = String(filters?.payer ?? '').trim()

  const matched = rows.filter((row) => {
    if (member) {
      const inPayer = Object.keys(row.payer_data ?? {}).includes(member)
      const inSplit = Object.keys(row.split_data ?? {}).includes(member)
      if (!inPayer && !inSplit) return false
    }
    if (payer && !Object.keys(row.payer_data ?? {}).includes(payer)) return false
    if (keyword && !String(row.description ?? '').toLowerCase().includes(keyword)) return false
    return true
  })

  const expenses: ExpenseBrief[] = matched.slice(0, limit).map((row) => ({
    ref: expenseRef(row.id),
    id: row.id,
    date: row.date,
    description: row.description,
    amount: Number(row.amount) || 0,
    currency: row.currency,
    category: row.category,
    payers: row.payer_data ?? {},
    splits: row.split_data ?? {},
    hasPhoto: (row.photo_urls?.length ?? 0) > 0,
    isSettlement: !!row.is_settlement,
  }))

  return {
    count: expenses.length,
    truncated: matched.length > expenses.length || rows.length >= MAX_SQL_ROWS,
    expenses,
  }
}

/**
 * 把一個編號對回真正的那一筆。
 *
 * 接受完整 uuid 或前 8 碼（開頭可以有 `#`）。PostgREST 不能對 uuid 欄位做 like，
 * 所以先把這趟旅程的 id 撈回來在記憶體比對前綴。
 *
 * ⚠️ **唯一命中才回傳**：零筆固然是找不到，兩筆以上更不能猜 ——
 *    刪錯或改錯一筆帳，比誠實說「講清楚一點」糟得多。
 */
export async function resolveExpenseRef(
  ref: string,
  ctx: ScopedContext,
  opts: ResolveRefOptions = {},
): Promise<ExpenseRow | null> {
  const needle = String(ref ?? '').trim().replace(/^#/, '').toLowerCase()
  if (!needle) return null

  const { data } = await ctx.db.from('expenses')
    .select('id, is_settlement, deleted_at')
    .eq('trip_id', ctx.trip.id)

  const rows = (data ?? []) as Pick<ExpenseRow, 'id' | 'is_settlement' | 'deleted_at'>[]
  const candidates = rows.filter((row) => {
    if (!opts.includeDeleted && row.deleted_at) return false
    if (!opts.allowSettlement && row.is_settlement) return false
    return String(row.id ?? '').toLowerCase().startsWith(needle)
  })
  if (candidates.length !== 1) return null

  const { data: full } = await ctx.db.from('expenses')
    .select('*')
    .eq('id', candidates[0].id)
    .maybeSingle()
  return (full ?? null) as ExpenseRow | null
}
