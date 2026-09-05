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
// 現在留在這裡的是「跟 LINE 這個管道有關」的那些：對話歷史摘要、
// 群組的 @提及處理、路由的意圖判斷、餵給 prompt 的全趟彙總。
// 純粹在驗證 AI 回傳內容的那一半已經搬到 _shared/validate.ts，
// 但仍由這裡原樣轉出 —— guards.test.ts 是這兩邊共同的看守者，一行都不必改。
//
// import 只有 _shared/deps.ts（Decimal）、_shared/finance.ts 與 _shared/validate.ts ——
// deps.ts 那層間接就是為了讓 vitest 在 Node 下也載得到，見 vitest.config.ts 的 alias。
// ============================================================

import { Decimal } from "../_shared/deps.ts"
import { formatAmount, getRate } from "../_shared/finance.ts"
import { normalizeName } from "../_shared/validate.ts"

// 轉出 _shared/validate.ts 的驗證函式，讓既有的 import 路徑與 guards.test.ts 不受影響。
// ⚠️ 型別要用 `export type`：混在值的 export 裡會讓 vitest 的 esbuild
//    產生一個執行期並不存在的 export，整個測試檔載入就失敗。
export {
  applyParticipantDefaults,
  CURRENCY_HINTS,
  extractJSON,
  hasCurrencyHint,
  KNOWN_CURRENCIES,
  normalizeCurrency,
  normalizeDate,
  normalizeExpenseAmountMaps,
  normalizeName,
  resolveCategory,
  resolveCurrencyByRule,
  resolveExpenseMembers,
  resolveMember,
  toAmountMap,
} from "../_shared/validate.ts"
export type { CurrencySource, MutableExpense, TripDefaults } from "../_shared/validate.ts"

// 「改 500」「改500」這種「改 + 數字」是最常見的說法，必須涵蓋。
// 不收單獨的「改」，否則「這筆帳我改天再處理」「剛剛那個改天再說」會被誤判。
const EDIT_VERB = /(修改|編輯|更改|改成|改為|改到|改一下|改\s*\d)/
/** 「這句話在講已經記過的東西不對」的其他說法 */
const CORRECTION_HINT = /(不對|錯了|打錯|記錯|更正)/

/**
 * 「這句話聽起來是想改某筆東西」的寬鬆判斷 —— 不要求受詞。
 *
 * P8 的防線（T1）：模型呼叫了 propose_expenses，但如果現場沒有任何未確認的草稿、
 * 它也沒填 corrects_draft，而使用者這句話明明是在講「改」，
 * 那它多半是把「剛剛那個改250」當成新支出了 —— 照著出卡片就會憑空多記一筆。
 * 這種時候改列編輯清單。
 *
 * ⚠️ 路由層原本還有一道 `detectRecordIntent()` 把這類句子攔在 AI 之前，
 *    改用 function calling 之後那道**刻意移除**了 —— 現在「刪除昨天的拉麵」
 *    要進得了 AI，模型才有機會用 propose_expense_delete 直接定位那一筆。
 *
 * 刻意寬鬆（不需要受詞）：到這一步已經知道「沒有草稿可以修」，
 * 誤判的代價只是多看到一張清單，比重複記帳輕得多。
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
 * 用文字取消「尚未確認的草稿」的說法。
 * 精確比對整句 —— 「取消上一筆」是撤銷已存檔的支出，不能混進來。
 */
export const CANCEL_DRAFT_KEYWORDS = [
  '取消', '不要記', '不用記', '算了', '取消這筆', '取消剛剛那筆',
]

/**
 * AI 有時會回「已經幫您刪除了」「我已經修改好了」，但那不是真的 ——
 * 修改與刪除現在只是「提議」，要使用者按下確認卡才會生效。
 * 使用者信了就以為帳已經改掉，這種假訊息比沒有功能更糟，送出前先攔下來。
 *
 * ⚠️ regex 刻意只認**過去式的完成宣稱**，不能連未來式一起殺 ——
 *    改用 function calling 之後，「確認後就會修改好」「按下去才會刪除」
 *    是我們要模型講的正確說法，攔掉它等於逼模型改口說謊。
 *    所以「會／可以／要／才／請」這些字眼在動詞前面時一律放行（下面的 (?<!…)）。
 */
// 動詞前面出現這些字＝在講「之後會發生什麼」，不是完成宣稱。
// 變長的 lookbehind 在 V8（Deno／Node）可以用。
const FUTURE_HINT = '(?<!會|可以|能|要|才|請|想|需|後|再)'
const ACTION_VERB = '(刪除|刪掉|移除|修改|更改|編輯|更新)'
const FALSE_ACTION_CLAIM = new RegExp(
  // 「已（經）刪除」「已經幫您修改」—— 「已」本身就是過去式，不需要再判斷
  `(已經?(幫[你您])?${ACTION_VERB}`
  // 「修改好了」「刪除了」，但「確認後就會修改好了」要放行
  + `|${FUTURE_HINT}${ACTION_VERB}(好了|好囉|完了|完成了|了)`
  // 「幫你刪了」「幫您改了」，但「按下去我就會幫你刪了」要放行
  + `|${FUTURE_HINT}幫[你您](刪|改)了)`,
)

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
  description?: string | null
  category?: string | null
  date?: string | null
  is_settlement?: boolean | null
  payer_data?: Record<string, unknown> | null
  split_data?: Record<string, unknown> | null
}

/** 逐日合計最多列幾天。太長會把 context 灌爆，也稀釋掉當下這句話。 */
export const SUMMARY_MAX_DAYS = 30
/** 「最貴的幾筆」列幾筆 */
export const SUMMARY_TOP_N = 3

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
 *
 * 逐日合計與「最貴的幾筆」是為了 K12、K13 —— 只有總額與分類的話，
 * 「第一天花多少」「最貴的一筆是什麼」仍然只能靠最近 10 筆硬猜。
 *
 * `options.rates` 與 `options.baseCurrency` 用來排序「最貴的幾筆」：
 * 3000 JPY 與 900 TWD 不折算是沒辦法比大小的。沒給就退回用原始金額比，
 * 單一幣別的旅程結果一樣，多幣別則會不準（所以呼叫端請務必傳）。
 */
export function summarizeTripExpenses(
  rows: SummaryRow[],
  members: string[],
  precisionConfig: Record<string, number> = {},
  options: { rates?: Record<string, number> | null; baseCurrency?: string | null } = {},
): string {
  const all = rows ?? []
  const real = all.filter(r => !r.is_settlement)

  if (all.length === 0) return '（這趟旅程還沒有任何支出）'

  const totals: MoneyMap = new Map()
  const byCategory = new Map<string, MoneyMap>()
  const byDate = new Map<string, MoneyMap>()
  const dates: string[] = []

  for (const row of real) {
    addMoney(totals, row.currency, row.amount)

    const category = String(row.category ?? '').trim() || '（未分類）'
    if (!byCategory.has(category)) byCategory.set(category, new Map())
    addMoney(byCategory.get(category)!, row.currency, row.amount)

    const date = String(row.date ?? '').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dates.push(date)
      // 逐日合計（K12）：沒有這個，「第一天花多少」「昨天花多少」只能靠最近 10 筆硬猜
      if (!byDate.has(date)) byDate.set(date, new Map())
      addMoney(byDate.get(date)!, row.currency, row.amount)
    }
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

  // 逐日合計（K12）。太長的旅程只留頭尾 —— 「第一天」與「昨天」都問得到，
  // 中間省略幾天則明講，讓 AI 知道那段它答不出來。
  const sortedDays = [...byDate.keys()].sort()
  const dayCell = (d: string) => `${d} ${renderMoney(byDate.get(d)!, precisionConfig)}`
  let dailyLine: string
  if (sortedDays.length === 0) {
    dailyLine = '（無）'
  } else if (sortedDays.length <= SUMMARY_MAX_DAYS) {
    dailyLine = sortedDays.map(dayCell).join('｜')
  } else {
    const head = sortedDays.slice(0, 1)
    const tail = sortedDays.slice(-(SUMMARY_MAX_DAYS - 1))
    const omitted = sortedDays.length - head.length - tail.length
    dailyLine = [
      ...head.map(dayCell),
      `…（中間 ${omitted} 天省略，這幾天的金額我算不出來）`,
      ...tail.map(dayCell),
    ].join('｜')
  }

  // 金額最大的幾筆（K13）。跨幣別要先折算成主幣別才比得出大小 ——
  // 3000 JPY 與 900 TWD 直接比數字是錯的。
  const baseCurrency = String(options.baseCurrency ?? '').trim()
  const rankValue = (row: SummaryRow) => {
    const amount = new Decimal(Number(row.amount) || 0)
    if (!baseCurrency) return amount
    return amount.times(getRate(row.currency, options.rates, baseCurrency))
  }
  const topRows = [...real]
    .sort((a, b) => rankValue(b).comparedTo(rankValue(a)))
    .slice(0, SUMMARY_TOP_N)
  const topLines = topRows.map((row, idx) => {
    const amountText = `${formatAmount(Number(row.amount) || 0, row.currency, precisionConfig)} ${row.currency}`
    // 已經是主幣別就不必再括號重複一次
    const converted = baseCurrency && row.currency !== baseCurrency
      ? `（折合 ${formatAmount(rankValue(row).toNumber(), baseCurrency, precisionConfig)} ${baseCurrency}）`
      : ''
    const desc = String(row.description ?? '').trim() || '（無描述）'
    const category = String(row.category ?? '').trim() || '（未分類）'
    return `${idx + 1}. ${row.date ?? '（無日期）'} ${desc} ${amountText}${converted} [${category}]`
  })

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
    `逐日合計：${dailyLine}`,
    ...(topLines.length > 0
      ? [`金額最大的 ${topLines.length} 筆${baseCurrency ? `（依折合 ${baseCurrency} 排序）` : ''}：`, ...topLines]
      : []),
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
