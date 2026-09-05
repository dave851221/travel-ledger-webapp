// ============================================================
// validate.ts —— AI 回傳內容的驗證與正規化（純函式）
//
// 這些函式全部是「輸入 → 輸出」，沒有 Deno 專屬 import、沒有 DB、沒有 fetch。
// 原本住在 line-webhook/guards.ts，因為它們與 LINE 一點關係都沒有 ——
// 未來要接別的記帳管道（見 docs/MCP_SERVER_DESIGN.md）時，
// 「AI 說的成員／幣別／分類／日期到底能不能信」這一關是共用的。
//
// guards.ts 仍然把它們原樣轉出，所以 guards.test.ts 一行都不必改。
//
// ⚠️ 這個檔案只能 import ./deps.ts 與 ./finance.ts —— 目前一個都用不到。
//    加了 DB 或 fetch 就不再是純函式，vitest 也就測不動了。
// ============================================================

/**
 * 三支「就地修改」的函式（normalizeExpenseAmountMaps、resolveExpenseMembers、
 * applyParticipantDefaults）看得到的支出。
 *
 * 金額欄位剛從 AI 回來時是 response_schema 產生的陣列、正規化之後才是 map，
 * 所以只能是 `Record<string, unknown>`；呼叫端在正規化之後才把同一個物件
 * 當成收斂好的草稿來用（見 line-webhook/types.ts 的 ExpenseDraft）。
 *
 * ⚠️ 用 `type` 而不是 `interface` 是必要的：只有 type alias 會取得隱含的
 *    index signature，呼叫端傳自己的具名型別進來才不會被拒絕。
 */
export type MutableExpense = {
  payer_data?: Record<string, unknown>
  split_details?: Record<string, unknown>
  split_data?: Record<string, unknown>
  [key: string]: unknown
}

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
      const member = String((entry as { member?: unknown })?.member ?? '').trim()
      if (!member) continue
      out[member] = (out[member] ?? 0) + (Number((entry as { amount?: unknown })?.amount) || 0)
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
export function normalizeExpenseAmountMaps(expense: MutableExpense | null | undefined): void {
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
  expense: MutableExpense | null | undefined,
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
  expense: MutableExpense | null | undefined,
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
