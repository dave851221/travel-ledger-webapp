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
// ============================================================

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
const RECORD_NOUN = /(支出|花費|帳|紀錄|記錄|這筆|那筆|上一筆|上上一筆)/
const DELETE_VERB = /(刪除|刪掉|刪了|移除|拿掉|去掉)/
// 「改 500」「改500」這種「改 + 數字」是最常見的說法，必須涵蓋。
// 不收單獨的「改」，否則「這筆帳我改天再處理」會被誤判。
const EDIT_VERB = /(修改|編輯|更改|改成|改為|改到|改一下|改\s*\d)/

export function detectRecordIntent(text: string): 'delete' | 'edit' | null {
  if (!RECORD_NOUN.test(text)) return null
  if (DELETE_VERB.test(text)) return 'delete'
  if (EDIT_VERB.test(text)) return 'edit'
  return null
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
 */
export function summarizeHistoryEntry(role: string, content: string): string {
  if (role !== 'model' || !content.startsWith('[記帳建議]')) {
    return content.length > 300 ? content.slice(0, 300) + '…' : content
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
