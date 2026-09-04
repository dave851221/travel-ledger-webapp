// ============================================================
// guards.ts —— LINE Bot 的純函式防線
//
// 這些函式全部是「輸入 → 輸出」，沒有 Deno 專屬 import、沒有 DB、沒有 fetch，
// 因此可以在 vitest（Node）下被直接測試 —— 見 guards.test.ts。
//
// 為什麼要抽出來：index.ts 兩千多行，AI 回傳內容的驗證（成員、幣別、日期）
// 與路由判斷（刪改意圖、假完成宣稱）散在其中，改 prompt 或改路由時很容易
// 連帶把它們弄壞而沒人發現。抽成獨立檔案並加測試，行為就被釘住了。
//
// `npm run check:functions` 只列 index.ts，但這個檔案透過 import 一起被型別檢查。
//
// 唯一的 import 是 _shared/finance.ts 與 _shared/deps.ts（Decimal）——
// deps.ts 那層間接就是為了讓 vitest 在 Node 下也載得到，見 vitest.config.ts 的 alias。
// ============================================================

import { Decimal } from "../_shared/deps.ts"
import { formatAmount } from "../_shared/finance.ts"

/** Gemini 偶爾會用 markdown code block 包裝 JSON，此函式負責安全提取 */
export function extractJSON(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return text.substring(start, end + 1)
  return text.trim()
}

/**
 * 把 AI 回傳的金額欄位統一成 { 成員: 金額 }。
 *
 * 接受兩種形式：
 *   - [{ member, amount }]  ← response_schema 產生的陣列
 *   - { 成員: 金額 }         ← 舊版草稿與沒有 schema 的模型可能仍回這種
 */
export function toAmountMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (Array.isArray(value)) {
    for (const entry of value) {
      const member = String((entry as any)?.member ?? '').trim()
      if (!member) continue
      out[member] = (out[member] ?? 0) + (Number((entry as any)?.amount) || 0)
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = Number(v) || 0
    }
  }
  return out
}

/** 就地把 expense 的金額欄位正規化成 map */
export function normalizeExpenseAmountMaps(expense: any): void {
  if (!expense) return
  expense.payer_data = toAmountMap(expense.payer_data)
  expense.split_details = toAmountMap(expense.split_details ?? expense.split_data)
}

/** 把字串正規化後比較：忽略大小寫、全半形空白與常見標點 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\u3000._-]/g, '')
    .trim()
}

/**
 * 把 AI 給的名字對應回成員清單裡的正式名稱。
 *
 * 依序嘗試：完全相同 → 正規化後相同 → 其中一方是另一方的子字串
 * （涵蓋「小明」對「王小明」、「Amy」對「amy」這類情況）。
 * 仍然對不上就回傳 null，讓呼叫端去問使用者，而不是硬猜。
 */
export function resolveMember(name: string, members: string[]): string | null {
  if (!name) return null
  if (members.includes(name)) return name

  const target = normalizeName(name)
  if (!target) return null

  const exact = members.find(m => normalizeName(m) === target)
  if (exact) return exact

  const partial = members.filter(m => {
    const n = normalizeName(m)
    return n.includes(target) || target.includes(n)
  })
  // 只有唯一解才算數，兩個以上一樣像就代表有歧義，寧可去問
  return partial.length === 1 ? partial[0] : null
}

/**
 * 把 expense 裡的成員 key 盡量對應回正式名稱。
 * 回傳對應後的物件，以及真的對不上的名字。
 */
export function resolveExpenseMembers(
  expense: any,
  members: string[],
): { unresolved: string[] } {
  const unresolved: string[] = []

  for (const field of ['payer_data', 'split_details', 'split_data']) {
    const data = expense?.[field]
    if (!data || typeof data !== 'object') continue

    const remapped: Record<string, number> = {}
    for (const [rawName, value] of Object.entries(data)) {
      const resolved = resolveMember(rawName, members)
      if (resolved) {
        // 同一位成員被指到兩次時金額相加，不要互相覆蓋
        remapped[resolved] = (remapped[resolved] ?? 0) + (Number(value) || 0)
      } else {
        unresolved.push(rawName)
      }
    }
    expense[field] = remapped
  }

  return { unresolved: [...new Set(unresolved)] }
}

/** 旅程層面的最小型別，只列出這些純函式真正會讀到的欄位 */
export interface TripDefaults {
  members: string[]
  default_payer?: string[] | null
  default_split_members?: string[] | null
}

/**
 * 補上缺席的付款人與分攤成員。
 *
 * schema 允許 payer_data / split_details 是空陣列，AI 偶爾真的會回空的 ——
 * 卡片上那一區塊會整片空白，按下確認時 calculateDistribution([], …) 回 {}，
 * 總和 0 不等於總額，使用者收到的是「財務運算發生錯誤，請聯絡管理員」。
 *
 * 規則刻意與前端 src/utils/quickAdd.ts 的 buildQuickAddDraft 一致：
 *   payer_data      空 → 旅程預設付款人 → 傳訊者對應的成員 → 成員第一位
 *   split_details   空 → 旅程預設分攤成員 → 全體成員
 * （兩者都會先濾掉已不存在於成員清單的名字。）
 *
 * 回傳有沒有真的補過。⚠️ 補上的 map 金額是 0 佔位，呼叫端交給 calculateDistribution
 * 時必須把 lockedData 換成 {}（0 會被當成鎖定金額，整筆餘額會落到調整成員身上）。
 */
export function applyParticipantDefaults(
  expense: any,
  trip: TripDefaults,
  speakerName?: string | null,
): { filledPayer: boolean; filledSplit: boolean } {
  const members = trip.members ?? []
  const result = { filledPayer: false, filledSplit: false }
  if (!expense || members.length === 0) return result

  const asMap = (names: string[]): Record<string, number> => {
    const map: Record<string, number> = {}
    names.forEach(n => { map[n] = 0 })
    return map
  }

  if (!expense.payer_data || Object.keys(expense.payer_data).length === 0) {
    const defaults = (trip.default_payer ?? []).filter(m => members.includes(m))
    const speaker = speakerName ? resolveMember(speakerName, members) : null
    const payers = defaults.length > 0 ? defaults : [speaker ?? members[0]]
    expense.payer_data = asMap(payers)
    result.filledPayer = true
  }

  if (!expense.split_details || Object.keys(expense.split_details).length === 0) {
    const defaults = (trip.default_split_members ?? []).filter(m => members.includes(m))
    expense.split_details = asMap(defaults.length > 0 ? defaults : members)
    result.filledSplit = true
  }

  return result
}

/**
 * 判斷使用者是不是想刪除或修改支出。
 *
 * 這是純粹的「語意判斷」，不負責決定要不要攔截 —— 攔或不攔由路由層決定，
 * 因為同一句「剛剛那筆改 500」在有草稿與沒草稿時該走完全不同的路：
 *   有草稿 → 交給 AI 修正那張草稿
 *   沒草稿 → 列出已存檔的紀錄讓使用者點選（AI 沒有修改既有紀錄的能力）
 *
 * 要求同時出現動詞與受詞，避免「改天再說」「取消行程」這類誤判。
 */
// 受詞不只有「那筆」這種正式說法。真機測試回報「剛剛那個改250」（T1）——
// 使用者講的是同一件事，卻因為說成「那個」而整句漏掉，被當成一筆全新的支出記進去。
// 指示代名詞與時間指稱都要算受詞；把關的是下面的動詞，不是這裡。
const RECORD_NOUN =
  /(支出|花費|帳|紀錄|記錄|這筆|那筆|上一筆|上上一筆|那個|這個|剛剛|剛才|上一個|前一個|最後一筆|最近一筆|最新一筆)/
const DELETE_VERB = /(刪除|刪掉|刪了|移除|拿掉|去掉)/
// 「改 500」「改500」這種「改 + 數字」是最常見的說法，必須涵蓋。
// 不收單獨的「改」，否則「這筆帳我改天再處理」「剛剛那個改天再說」會被誤判。
const EDIT_VERB = /(修改|編輯|更改|改成|改為|改到|改一下|改\s*\d)/
/** 「這句話在講已經記過的東西不對」的其他說法 */
const CORRECTION_HINT = /(不對|錯了|打錯|記錯|更正)/

export function detectRecordIntent(text: string): 'delete' | 'edit' | null {
  if (!RECORD_NOUN.test(text)) return null
  if (DELETE_VERB.test(text)) return 'delete'
  if (EDIT_VERB.test(text)) return 'edit'
  return null
}

/**
 * 「這句話聽起來是想改某筆東西」的寬鬆判斷 —— 不要求受詞。
 *
 * 用途與 detectRecordIntent 不同，是 P8 的第二道防線（T1）：
 * AI 回了 type: expense，但如果現場沒有任何未確認的草稿、它也沒填 corrects_draft，
 * 而使用者這句話明明是在講「改」，那它多半是把「剛剛那個改250」當成新支出了 ——
 * 照著出卡片就會憑空多記一筆。這種時候改列編輯清單。
 *
 * 刻意比 detectRecordIntent 寬鬆（不需要受詞），因為到這一步已經知道
 * 「沒有草稿可以修」，誤判的代價只是多看到一張清單，比重複記帳輕得多。
 */
export function mentionsEditingExisting(text: string): boolean {
  if (!text) return false
  return EDIT_VERB.test(text) || CORRECTION_HINT.test(text)
}

/** LINE 的 mention 條目，只列這裡真正會用到的欄位 */
export interface Mentionee {
  index?: number
  length?: number
  isSelf?: boolean
}

/**
 * 只把「提及機器人自己」的那幾段從訊息裡拿掉（M16）。
 *
 * 以前是拿一個「@ 加上任意非空白字元」的正規表示式全域取代 —— 一律刪掉所有 @開頭的詞。
 * 於是「@耀西 @小明 你付的晚餐 300」會變成「你付的晚餐 300」，
 * AI 根本看不到付款人是小明，只好套預設值（L14）。
 *
 * LINE 的 mention.mentionees 每一項都帶 index 與 length，
 * 照著切掉 isSelf 的那幾段就好，其他人的名字原封不動留著。
 *
 * ⚠️ index 是相對於**原始未 trim 的** message.text，所以呼叫端要傳原文進來。
 * 沒有 mention 資料時原樣回傳 —— 沒有東西可以刪，不該亂猜。
 */
export function stripSelfMentions(rawText: string, mentionees?: Mentionee[] | null): string {
  const text = String(rawText ?? '')
  const targets = (mentionees ?? [])
    .filter(m => m?.isSelf === true && typeof m.index === 'number' && typeof m.length === 'number')
    // 由後往前刪，前面幾段的 index 才不會被移動
    .sort((a, b) => (b.index as number) - (a.index as number))

  let out = text
  for (const m of targets) {
    const start = Math.max(0, m.index as number)
    const end = Math.min(out.length, start + (m.length as number))
    if (start >= out.length) continue
    out = out.slice(0, start) + out.slice(end)
  }
  // 刪掉之後常會留下連續空白（「@耀西 晚餐 300」→「 晚餐 300」）
  return out.replace(/[ \u3000]{2,}/g, ' ').trim()
}

/**
 * 把 AI 給的分類對回旅程的分類清單（M18）。
 *
 * 之前完全不驗證：AI 回「美食」但旅程只有「餐飲」，就真的存進一個
 * 不存在的分類 —— 網頁的分類統計會多出一個永遠選不到的欄位（F7）。
 *
 * 對法與 resolveMember 一致：完全相同 → 正規化後相同 → 唯一的子字串。
 * 都對不上就退回預設分類（旅程預設 →「其他」→ 清單第一個）並回一句提醒。
 */
export function resolveCategory(
  category: unknown,
  categories: string[],
  defaultCategory?: string | null,
): { category: string; warning: string | null } {
  const raw = String(category ?? '').trim()
  const list = (categories ?? []).filter(c => typeof c === 'string' && c.trim())

  // 旅程根本沒設分類清單就沒什麼好驗的
  if (list.length === 0) return { category: raw, warning: null }

  const matched = resolveMember(raw, list)
  if (matched) return { category: matched, warning: null }

  const fallback = (defaultCategory && list.includes(defaultCategory))
    ? defaultCategory
    : (list.includes('其他') ? '其他' : list[0])

  return {
    category: fallback,
    warning: raw
      ? `⚠️ 分類「${raw}」不在這趟旅程的清單裡，已改用「${fallback}」。`
      : null,
  }
}

/**
 * 用文字取消「尚未確認的草稿」的說法。
 * 精確比對整句 —— 「取消上一筆」是撤銷已存檔的支出，不能混進來。
 */
export const CANCEL_DRAFT_KEYWORDS = [
  '取消', '不要記', '不用記', '算了', '取消這筆', '取消剛剛那筆',
]

/**
 * AI 有時會回「已經幫您刪除了」「我已經修改好了」，但它根本做不到 ——
 * 這種假訊息比沒有功能更糟，使用者會以為帳已經改掉了。
 * 送出前先攔下來。
 */
const FALSE_ACTION_CLAIM =
  /(已經?(幫[你您])?(刪除|刪掉|移除|修改|更改|編輯|更新)|(刪除|刪掉|移除|修改|更改|編輯|更新)(好|完|了)|幫[你您](刪|改))/

export function claimsCompletedAction(text: string): boolean {
  return FALSE_ACTION_CLAIM.test(text)
}

/**
 * 把歷史紀錄壓成適合當對話輪次的內容。
 *
 * 存進 line_chat_history 的 model 訊息是 `[記帳建議] {整包 JSON}`。
 * 直接把那串 JSON 當成模型自己說過的話餵回去，它很容易改去修那筆舊草稿
 * 而不是回應使用者當下這句話 —— 尤其在有 response_schema 約束的情況下。
 * 壓成一行摘要，既保留「剛剛那筆改 500」需要的指代對象，又不會蓋過新訊息。
 *
 * 摘要會附上草稿的 nonce：AI 要用 corrects_draft 指名修正的是哪一張卡片，
 * 沒有 nonce 它只能靠上下文猜。
 *
 * 群組裡整串歷史是共用的，A 與 B 交錯講話時 AI 看到的是同一串（L15）。
 * 所以 user 訊息前面補上發言者（M17）—— 少了它，「我付的」在多輪對話裡
 * 會被算到當下這位發言者身上，即使那句話是別人講的。
 */
export function summarizeHistoryEntry(
  role: string,
  content: string,
  speakerName?: string | null,
): string {
  if (role !== 'model' || !content.startsWith('[記帳建議]')) {
    const body = content.length > 300 ? content.slice(0, 300) + '…' : content
    const speaker = String(speakerName ?? '').trim()
    return role === 'user' && speaker ? `${speaker}：${body}` : body
  }
  try {
    const draft = JSON.parse(content.slice('[記帳建議]'.length).trim())
    const parts = [draft.description, draft.amount, draft.currency].filter(Boolean).join(' ')
    const tag = draft.nonce ? `，草稿編號 ${draft.nonce}` : ''
    return `（我先前提出的記帳建議：${parts}${tag}）`
  } catch {
    return '（我先前提出過一筆記帳建議）'
  }
}


// ============================================================
// 全趟彙總（M6）
//
// AI 的 context 只放得下最近 10 筆支出，所以「這趟總共花多少」「我還欠多少」
// 「交通花了多少」這類問題它一律答錯 —— 它只能把看得到的那 10 筆加一加。
// 這裡在伺服器端用 Decimal 先算好精確數字放進 tripContext，
// 模型就不必（也不該）自己做算術。
//
// 長期解法是 Gemini function calling，見 docs/MCP_SERVER_DESIGN.md。
// ============================================================

/** 彙總只讀得到這幾個欄位 */
export interface SummaryRow {
  amount: number | string
  currency: string
  category?: string | null
  date?: string | null
  is_settlement?: boolean | null
  payer_data?: Record<string, unknown> | null
  split_data?: Record<string, unknown> | null
}

/** { 幣別: Decimal } 的累加器 */
type MoneyMap = Map<string, InstanceType<typeof Decimal>>

function addMoney(map: MoneyMap, currency: string, amount: unknown): void {
  const cur = String(currency ?? '').trim().toUpperCase()
  if (!cur) return
  const value = new Decimal(Number(amount) || 0)
  map.set(cur, (map.get(cur) ?? new Decimal(0)).plus(value))
}

/** 把累加器印成「12345 JPY・2100 TWD」；空的話回傳 dash */
function renderMoney(
  map: MoneyMap,
  precisionConfig: Record<string, number>,
  options: { signed?: boolean; empty?: string } = {},
): string {
  const parts: string[] = []
  // 幣別排序固定，同一趟旅程每次問到的字串才會一致
  for (const cur of [...map.keys()].sort()) {
    const value = map.get(cur)!
    const text = formatAmount(value.toNumber(), cur, precisionConfig)
    parts.push(`${options.signed && value.greaterThan(0) ? '+' : ''}${text} ${cur}`)
  }
  return parts.length > 0 ? parts.join('・') : (options.empty ?? '0')
}

/**
 * 把整趟旅程的支出壓成一段給 AI 讀的精確彙總。
 *
 * 刻意的取捨：
 *   - 筆數／日期範圍／各幣別合計／各分類合計 **不含結清紀錄** ——
 *     結清是「誰把錢還給誰」，不是這趟花了多少（與快捷查詢的 K19 一致）。
 *   - 每人的已付／應付／淨額 **含結清紀錄** ——
 *     「我還欠多少」要扣掉已經還過的錢，不然數字永遠不會歸零。
 */
export function summarizeTripExpenses(
  rows: SummaryRow[],
  members: string[],
  precisionConfig: Record<string, number> = {},
): string {
  const all = rows ?? []
  const real = all.filter(r => !r.is_settlement)

  if (all.length === 0) return '（這趟旅程還沒有任何支出）'

  const totals: MoneyMap = new Map()
  const byCategory = new Map<string, MoneyMap>()
  const dates: string[] = []

  for (const row of real) {
    addMoney(totals, row.currency, row.amount)

    const category = String(row.category ?? '').trim() || '（未分類）'
    if (!byCategory.has(category)) byCategory.set(category, new Map())
    addMoney(byCategory.get(category)!, row.currency, row.amount)

    const date = String(row.date ?? '').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.push(date)
  }

  // 每人收支：payer_data 是已付、split_data 是應付，兩者都含結清紀錄
  const paid = new Map<string, MoneyMap>()
  const owed = new Map<string, MoneyMap>()
  const bump = (store: Map<string, MoneyMap>, member: string, currency: string, amount: unknown) => {
    if (!store.has(member)) store.set(member, new Map())
    addMoney(store.get(member)!, currency, amount)
  }
  for (const row of all) {
    for (const [member, amount] of Object.entries(row.payer_data ?? {})) {
      bump(paid, member, row.currency, amount)
    }
    for (const [member, amount] of Object.entries(row.split_data ?? {})) {
      bump(owed, member, row.currency, amount)
    }
  }

  dates.sort()
  const range = dates.length > 0
    ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`)
    : '（無）'

  const categoryLine = byCategory.size > 0
    ? [...byCategory.keys()].sort()
        .map(c => `${c} ${renderMoney(byCategory.get(c)!, precisionConfig)}`)
        .join('｜')
    : '（無）'

  // 名單以旅程成員為準，並補上只出現在支出裡的名字（成員被改名或移除過的舊帳）
  const names = [...members]
  for (const name of [...paid.keys(), ...owed.keys()]) {
    if (!names.includes(name)) names.push(name)
  }

  const memberLines = names.map(name => {
    const p = paid.get(name) ?? new Map()
    const o = owed.get(name) ?? new Map()
    if (p.size === 0 && o.size === 0) return `- ${name}：尚無收支`
    // 淨額 = 已付 - 應付。正數代表這個人先墊了錢，別人要還他。
    const net: MoneyMap = new Map()
    for (const cur of new Set([...p.keys(), ...o.keys()])) {
      net.set(cur, (p.get(cur) ?? new Decimal(0)).minus(o.get(cur) ?? new Decimal(0)))
    }
    return `- ${name}：已付 ${renderMoney(p, precisionConfig)}`
      + `｜應付 ${renderMoney(o, precisionConfig)}`
      + `｜淨額 ${renderMoney(net, precisionConfig, { signed: true })}`
  })

  return [
    `筆數：${real.length} 筆（不含結清紀錄）｜日期範圍：${range}`,
    `各幣別合計：${renderMoney(totals, precisionConfig, { empty: '（無）' })}`,
    `各分類合計：${categoryLine}`,
    '每人收支（已付／應付／淨額，含結清紀錄；淨額為正代表別人要還他）：',
    ...memberLines,
  ].join('\n')
}

/**
 * 把 AI 回的「#3」這種編號換回清單裡的那一筆。
 *
 * 為什麼是編號而不是網址（T4）：以前 tripContext 塞的是每筆支出的完整照片網址，
 * 要 AI 逐字抄回來。網址又長又只差幾個字元，小模型常抄錯，或抄成上一輪對話裡
 * 出現過的另一張 —— 使用者問「剛剛 Lawson 那筆」，分析的卻是別筆的收據。
 * 改成只回編號，程式自己去陣列裡取，抄錯的空間就沒了。
 *
 * 只接受 `#3`、`＃3`、`3` 這種「整串就是一個編號」的寫法。
 * 刻意不從長字串裡撈數字 —— 模型若還是照舊習慣回了一整串網址，
 * 撈出來的數字會指到一筆毫不相干的支出，那正是 T4 要修掉的症狀。
 * 超出範圍或格式不符都回 null，讓呼叫端走全庫搜尋。
 */
export function pickExpenseByRef<T>(ref: unknown, list: T[]): T | null {
  const m = String(ref ?? '').trim().match(/^[#＃]?\s*(\d{1,3})$/)
  if (!m) return null
  const idx = parseInt(m[1], 10)
  if (idx < 1 || idx > list.length) return null
  return list[idx - 1]
}

/**
 * 在程式端先用店名縮小範圍，再決定要不要麻煩 AI。
 *
 * 使用者問「剛剛 Lawson 那筆買了什麼」時，描述通常原封不動出現在問句裡；
 * 命中唯一一筆就不必再叫一次模型（省 token，也少一次抄錯的機會）。
 *
 * 比對用 normalizeName()（忽略大小寫與空白），並額外拿「括號前的原文」當 key ——
 * 描述格式是「Lawson (便利商店)」，整串是不會出現在問句裡的。
 * 太短的 key（1 個字）不列入比對，避免整份清單都命中。
 */
export function matchExpensesByQuestion<T extends { description?: string | null }>(
  question: string,
  list: T[],
): T[] {
  const haystack = normalizeName(String(question ?? ''))
  if (!haystack) return []
  return list.filter(e => {
    const desc = String(e.description ?? '')
    const keys = [desc, desc.split(/[(（[【]/)[0]]
    return keys.some(k => {
      const n = normalizeName(k)
      return n.length >= 2 && haystack.includes(n)
    })
  })
}

/**
 * 「使用者的話裡真的出現幣別字眼了嗎」的判斷材料。
 *
 * 分三組是為了避免拉丁代碼在英文單字裡誤判：`NT` 若不加邊界，
 * 「restaurant 300」會被當成使用者明講了台幣。CJK 詞與符號沒有這個問題。
 */
export const CURRENCY_HINTS: RegExp[] = [
  /(日幣|日圓|日元|円|台幣|新台幣|美金|美元|韓元|歐元|港幣|泰銖|人民幣|新幣|馬幣|越南盾)/,
  /[¥￥$＄€₩฿]/,
  /(^|[^A-Za-z])(JPY|TWD|NT|USD|EUR|KRW|CNY|RMB|HKD|THB|MYR|VND|SGD)([^A-Za-z]|$)/i,
]

/** 文字裡有沒有出現任何幣別字眼或符號 */
export function hasCurrencyHint(text: string | null | undefined): boolean {
  if (!text) return false
  return CURRENCY_HINTS.some(re => re.test(text))
}

/** AI 對「這個幣別是哪裡來的」的自我宣告 */
export type CurrencySource = 'stated' | 'preference' | 'none'

/**
 * 決定該用哪個幣別 —— 由程式決定，不靠 prompt 的記性。
 *
 * 為什麼需要這一層（T3）：旅程主幣 TWD、記帳預設 JPY 時，使用者打「夾娃娃300」，
 * 小模型常把 context 裡的「主幣：TWD」當成該填的值，出來的卡片幣別就錯了。
 * 幣別的優先權原本只是 tripContext 裡的一行文字，模型記不住。
 *
 * 規則：
 *   none       → 一律用旅程的記帳預設幣別，完全忽略 AI 填的值
 *   stated     → 再用程式驗一次：文字裡真的有幣別字眼才採信，沒有就視同 none
 *                （OCR 路徑沒有文字可驗，text 傳 null 代表直接信任）
 *   preference → 採用 AI 的值（偏好是自由文字，程式驗不了）
 *
 * 認不得的 source（舊模型、schema 沒填）當成 stated 處理，行為與加這一層之前一致。
 * 回傳值仍要再交給 normalizeCurrency() 做 rates／白名單檢查。
 */
export function resolveCurrencyByRule(
  aiCurrency: unknown,
  source: unknown,
  text: string | null,
  trip: { base_currency: string; default_currency?: string | null },
): { currency: string; overrode: boolean } {
  const raw = String(aiCurrency ?? '').trim().toUpperCase()
  const fallback = trip.default_currency || trip.base_currency
  const src = String(source ?? '').trim().toLowerCase()

  // text === null 代表沒有文字可驗（OCR），此時 stated 直接採信
  const statedIsCredible = text === null || hasCurrencyHint(text)
  const useFallback = src === 'none' || (src !== 'preference' && !statedIsCredible)

  if (useFallback) {
    return { currency: fallback, overrode: !!raw && raw !== fallback }
  }
  return { currency: raw || fallback, overrode: false }
}

/** ISO 4217 常見幣別，用來擋掉 AI 幻想出來的代碼 */
export const KNOWN_CURRENCIES = new Set([
  'TWD', 'JPY', 'USD', 'EUR', 'KRW', 'CNY', 'HKD', 'GBP', 'AUD', 'CAD',
  'SGD', 'THB', 'MYR', 'PHP', 'VND', 'IDR', 'NZD', 'CHF', 'MOP', 'INR',
])

/**
 * 驗證幣別。
 *
 * 之前完全不檢查：AI 回傳的字串直接寫進資料庫，未知幣別會被當成 2 位小數，
 * 結算時匯率當 1，金額就默默失真了。
 * 旅程 rates 裡有的最優先，其次是 ISO 白名單，都不符就退回旅程主幣別。
 */
export function normalizeCurrency(
  currency: unknown,
  trip: { rates?: Record<string, number>; base_currency: string; default_currency?: string },
): { currency: string; warning: string | null; reject: string | null } {
  const raw = String(currency ?? '').trim().toUpperCase()
  const fallback = trip.default_currency || trip.base_currency
  const available = Object.keys(trip.rates ?? {})

  if (!raw) return { currency: fallback, warning: null, reject: null }

  // 旅程有設匯率 → 正常放行
  if (trip.rates && Object.prototype.hasOwnProperty.call(trip.rates, raw)) {
    return { currency: raw, warning: null, reject: null }
  }

  // 是合法幣別，但這趟旅程沒有它的匯率。
  // 不能就這樣存進去：統計會以 1:1 換算，金額直接失真且事後難以察覺。
  if (KNOWN_CURRENCIES.has(raw)) {
    return {
      currency: raw,
      warning: null,
      reject: `🙅 這趟旅程沒有設定 ${raw} 的匯率，先存起來的話統計會算錯。\n\n`
        + `目前可用的幣別：${available.join('、') || '（尚未設定）'}\n\n`
        + `請改用上面其中一種，或先到網頁的「設定 → 匯率精度」加入 ${raw} 的匯率。`,
    }
  }

  // 根本不是幣別代碼 —— 多半是 AI 看錯，退回旅程預設並告知
  return {
    currency: fallback,
    warning: `⚠️ 無法辨識幣別「${raw}」，已改用 ${fallback}。`,
    reject: null,
  }
}

/**
 * 驗證日期。
 *
 * 之前也是直接寫進資料庫，沒有格式或範圍檢查 ——
 * AI 算錯年份就會出現 2019 或 2031 年的支出。
 * 格式錯或超出今天前後一年就退回今天。
 */
export function normalizeDate(date: unknown, today: string): { date: string; warning: string | null } {
  const raw = String(date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { date: today, warning: raw ? `⚠️ 日期格式無法辨識，已改用今天 ${today}。` : null }
  }

  const parsed = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    return { date: today, warning: `⚠️ 日期無效，已改用今天 ${today}。` }
  }
  // Date 會把 2026-02-30 悄悄捲到 3/2，比對回去才擋得住不存在的日期
  if (parsed.toISOString().substring(0, 10) !== raw) {
    return { date: today, warning: `⚠️ 日期 ${raw} 不存在，已改用今天 ${today}。` }
  }

  const todayMs = new Date(`${today}T00:00:00Z`).getTime()
  const ONE_YEAR = 365 * 24 * 60 * 60 * 1000
  if (Math.abs(parsed.getTime() - todayMs) > ONE_YEAR) {
    return { date: today, warning: `⚠️ 日期 ${raw} 距離今天超過一年，已改用今天 ${today}。` }
  }

  return { date: raw, warning: null }
}
