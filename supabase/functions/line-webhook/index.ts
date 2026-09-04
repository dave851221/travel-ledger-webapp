import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"
import { encodeBase64, decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { Decimal } from "../_shared/deps.ts"
import {
  calculateDistribution,
  calculateSettlements,
  DEFAULT_PRECISION,
  formatAmount,
  sumByCurrency,
} from "../_shared/finance.ts"
// 純函式（AI 回傳內容的驗證、路由的意圖判斷）集中在 guards.ts，
// 由 guards.test.ts 看守。改這些行為請連同測試一起改。
import {
  applyParticipantDefaults,
  CANCEL_DRAFT_KEYWORDS,
  claimsCompletedAction,
  detectRecordIntent,
  extractJSON,
  matchExpensesByQuestion,
  mentionsEditingExisting,
  normalizeCurrency,
  normalizeDate,
  normalizeExpenseAmountMaps,
  pickExpenseByRef,
  resolveCategory,
  resolveCurrencyByRule,
  resolveExpenseMembers,
  stripSelfMentions,
  summarizeHistoryEntry,
  summarizeTripExpenses,
} from "./guards.ts"

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') || ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const WEBAPP_URL = Deno.env.get('WEBAPP_URL') || 'https://dave851221.github.io/travel-ledger-webapp'


// 收據照片的 bucket。路徑慣例 expenses/{tripId}/{檔名}，
// supabase/scripts/delete_trip.sql 依賴這個前綴清理照片，勿隨意更名。
const RECEIPTS_BUCKET = 'travel-images'

const RATE_LIMIT_MSG = '⚠️ AI 服務暫時達到免費使用量上限，請隔天再試。'
const isRateLimit = (e: any) => String(e?.message).startsWith('RATE_LIMIT:')

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/** 編輯「旅程 AI 記帳偏好」的 LIFF 頁網址（Feature F） */
function preferenceLiffUrl(tripId: string): string {
  return `${WEBAPP_URL}/#/liff/preference?tripId=${tripId}`
}

/**
 * 「設定?」「設定:」的回覆用：把「記帳偏好」按鈕排到第一顆。
 * 一般的 boundQR 也有這顆，但排在最後 —— 使用者正在講偏好，那顆該最顯眼。
 */
function preferenceQuickReply(tripId: string, showGroupToggle: boolean, mentionRequired: boolean) {
  // 不傳 tripId 給 getQuickReply，避免同一顆按鈕出現兩次
  const base = getQuickReply(true, showGroupToggle, mentionRequired)
  return { items: [preferenceQuickReplyItem(tripId), ...base.items] }
}

function preferenceQuickReplyItem(tripId: string) {
  return {
    type: "action",
    action: { type: "uri", label: "⚙️ 記帳偏好", uri: preferenceLiffUrl(tripId) },
  }
}

function getQuickReply(
  bound: boolean,
  showGroupToggle = false,
  mentionRequired = true,
  tripId?: string | null,
) {
  if (!bound) {
    return {
      items: [
        { type: "action", action: { type: "message", label: "❓ 使用說明", text: "使用說明" } },
      ]
    }
  }
  const items: any[] = [
    { type: "action", action: { type: "message", label: "📅 今日支出", text: "今日支出" } },
    { type: "action", action: { type: "message", label: "📊 本月支出", text: "本月支出" } },
    { type: "action", action: { type: "message", label: "💰 結算", text: "結算" } },
    { type: "action", action: { type: "message", label: "🗺️ 旅程總覽", text: "旅程總覽" } },
    { type: "action", action: { type: "message", label: "🗑 刪除支出", text: "刪除支出" } },
    { type: "action", action: { type: "message", label: "✏️ 編輯支出", text: "編輯支出" } },
    { type: "action", action: { type: "message", label: "❓ 使用說明", text: "使用說明" } },
  ]
  // 偏好是旅程層級的，沒有旅程就沒有東西可編輯
  if (tripId) items.push(preferenceQuickReplyItem(tripId))
  if (showGroupToggle) {
    items.push(mentionRequired
      ? { type: "action", action: { type: "message", label: "📣開啟全回應模式", text: "模式:全回應模式" } }
      : { type: "action", action: { type: "message", label: "🎯改回提及模式", text: "模式:提及模式" } }
    )
  }
  return { items }
}

/**
 * 給 AI 的成員別名提示。
 *
 * 以前這段直接把「代杰／阿杰／Jay／小杰」寫死在 prompt 裡，
 * 對其他旅程來說那是一個不存在的人名，只會變成噪音。
 * 改成用這趟旅程實際的成員舉例。
 */
function memberAliasHint(members: string[]): string {
  if (!members || members.length === 0) return ''
  const sample = members[0]
  return `\n【成員名稱】只能使用：${members.join('、')}
使用者可能用暱稱或簡稱（例如把「${sample}」說成別的叫法），請對應回上面清單裡的正式名稱；
對應不出來時就用 chat 反問，不要自己造一個名字。\n`
}

/**
 * 讓非同步工作在回應送出後仍跑得完。
 *
 * Supabase Edge Runtime 會在 Response 回傳後隨時中止函式，
 * 過去那些 `.then(() => {})` 的「射後不理」寫法因此可能整個消失 ——
 * 對話歷史掉了只是可惜，`saved` 紀錄掉了會讓「取消上一筆」撤到更早的一筆。
 * 真正依賴結果的（例如 saved）請直接 await，其餘交給這裡。
 */
function runInBackground(work: PromiseLike<unknown>): void {
  const runtime = (globalThis as any).EdgeRuntime
  const promise = Promise.resolve(work).catch((err) => console.error('[BG_TASK]', err))
  if (runtime && typeof runtime.waitUntil === 'function') {
    runtime.waitUntil(promise)
  }
}

/** 一張還等在聊天室裡、使用者既沒確認也沒取消的記帳草稿 */
interface OutstandingDraft {
  nonce: string
  exp: any
  photoIds: string[]
  tripId: string
}

/**
 * 取出這個聊天目前「還沒被處理」的記帳草稿（最新的在前，最多 5 張）。
 *
 * 「還沒被處理」＝ nonce 不在 line_processed_actions 裡，
 * 也就是使用者既沒按確認存入、也沒按取消，那張卡片還等在聊天室裡。
 *
 * 以前只找「有收據照片」的那一張，因為唯一的用途是逐項重新分帳。
 * 現在還要用來判斷「剛剛那筆改 500」「取消」指的是哪一張卡片，
 * 所以一律回傳，帶不帶照片由呼叫端自己篩。
 */
async function getOutstandingDrafts(sourceId: string): Promise<OutstandingDraft[]> {
  const { data: rows } = await supabase.from('line_chat_history')
    .select('content')
    .eq('line_user_id', sourceId)
    .eq('role', 'pending')
    .order('created_at', { ascending: false })
    .limit(5)
  if (!rows || rows.length === 0) return []

  const candidates: OutstandingDraft[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.content)
      const photoIds = Array.isArray(parsed.p) ? parsed.p : []
      if (parsed.n) {
        candidates.push({ nonce: parsed.n, exp: parsed.exp, photoIds, tripId: parsed.tid })
      }
    } catch { /* skip malformed */ }
  }
  if (candidates.length === 0) return []

  const { data: used } = await supabase.from('line_processed_actions')
    .select('nonce')
    .in('nonce', candidates.map(c => c.nonce))
  const usedSet = new Set((used ?? []).map((u: any) => u.nonce))

  return candidates.filter(c => !usedSet.has(c.nonce))
}

/** 由 photo id 或路徑組出 Storage 的公開網址 */
function photoPublicUrl(photoId: string, tripId: string): string {
  const path = String(photoId).includes('/') ? String(photoId) : `expenses/${tripId}/${photoId}.jpg`
  const { data } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

/** 下載收據照片並轉成 Gemini 需要的 inlineData */
async function fetchPhotoPart(photoUrl: string): Promise<any | null> {
  try {
    const res = await fetch(photoUrl)
    if (!res.ok) {
      console.warn(`[REANALYZE] Failed to fetch photo: ${res.status}`)
      return null
    }
    const buf = await res.arrayBuffer()
    return { inlineData: { mimeType: 'image/jpeg', data: encodeBase64(new Uint8Array(buf)) } }
  } catch (err) {
    console.warn('[REANALYZE] photo fetch error:', err)
    return null
  }
}

/**
 * 讓指定的幾張草稿卡片失效。
 *
 * 做法是把 nonce 直接塞進 line_processed_actions ——
 * 那正是防重複點擊用的鎖，所以舊按鈕會走到既有的「此操作已處理過」分支，
 * 不必另外設計一套失效機制。`action_type` 記成 `superseded`，
 * 好讓 postback 分支能分辨「被取代」與「你剛剛已經按過了」。
 */
async function markDraftsSuperseded(sourceId: string, nonces: string[]): Promise<void> {
  if (nonces.length === 0) return
  // 已存在的 nonce 會衝突，忽略即可（代表那張卡片早就處理過了）
  await supabase.from('line_processed_actions')
    .upsert(
      nonces.map(n => ({ nonce: n, line_user_id: sourceId, action_type: 'superseded' })),
      { onConflict: 'nonce', ignoreDuplicates: true },
    )
}

/**
 * 把剛佔用的 nonce 放掉。
 *
 * 「確認存入」是先寫 nonce 再做事（那是防連點的鎖）。若後面發現不能存
 * （成員被移除、Σ 對不上），鎖留著的話整張卡片就死了 ——
 * 連我們自己叫使用者去按的「✏️ 編輯」都會回「這張卡片已處理過」。
 */
async function releaseNonce(nonce: string | null | undefined): Promise<void> {
  if (!nonce) return
  await supabase.from('line_processed_actions').delete().eq('nonce', nonce)
}

/**
 * 只讓「被修正的那一張」草稿失效。
 *
 * ⚠️ 這裡刻意不是「讓所有舊草稿失效」。原本每送一張新卡片就把先前全部作廢，
 *    結果「晚餐 300」接著「計程車 200」時第一張卡就按不動了，
 *    群組裡兩個人同時記帳也會互相蓋掉（見 docs/LINE_SCENARIOS.md 的 H1）。
 *    只有 AI 明確回報 corrects_draft 時，才該讓那一張失效。
 */
async function supersedeDraft(sourceId: string, nonce: string): Promise<void> {
  await markDraftsSuperseded(sourceId, [nonce])
}

/**
 * 讓這個聊天所有未處理的草稿失效（M13）。
 *
 * 綁定成功、斷開、切換旅程時一定要呼叫：草稿的 payload 裡帶著舊的 `tid`，
 * 換旅程後再按那張卡的「確認存入」會把支出寫進**上一趟**旅程，
 * 或因為照片路徑對不上而壞掉（A16）。一般記帳流程不要呼叫 ——
 * 那會把「連續記多筆」整批作廢，正是 H1 修掉的 bug。
 */
async function supersedeAllDrafts(sourceId: string): Promise<void> {
  const drafts = await getOutstandingDrafts(sourceId)
  await markDraftsSuperseded(sourceId, drafts.map(d => d.nonce))
}

/**
 * 取消一張草稿：讓卡片失效，並把已上傳的收據照片清掉。
 *
 * 卡片上的「❌ 取消」按鈕與文字指令「取消」都走這裡，兩邊行為才會一致。
 */
async function cancelDraft(
  sourceId: string,
  draft: { nonce: string; photoIds: string[]; tripId: string },
): Promise<void> {
  await supabase.from('line_processed_actions')
    .upsert(
      [{ nonce: draft.nonce, line_user_id: sourceId, action_type: 'cancel' }],
      { onConflict: 'nonce', ignoreDuplicates: true },
    )
  if (draft.photoIds.length > 0 && draft.tripId) {
    const urls = draft.photoIds.map((id: string) => id.includes('/') ? id : `expenses/${draft.tripId}/${id}.jpg`)
    console.log(`[PHOTO] Remove photo URL: ${urls}`)
    await supabase.storage.from(RECEIPTS_BUCKET).remove(urls)
  }
}

/**
 * 產生「編輯既有支出」的 LIFF 網址。
 *
 * 只帶 expense id，內容由 LiffEdit 自己查 DB（T2／M2）。
 * ExpenseModal 判斷有 id 就執行 UPDATE，少了它會變成新增一筆重複的。
 *
 * ⚠️ 以前是把整筆支出 base64 塞進網址。那有兩個問題：
 *    ①訊息送出的那一刻資料就凍結了 —— 從清單改完金額再按同一顆「編輯」，
 *      表單填的還是修改前的值；②LINE 的 uri action 上限 1000 字，
 *      多成員、長描述、多照片時整張清單會直接發不出去（J14）。
 *    舊格式 LiffEdit 仍然看得懂，已發出去的卡片不會壞。
 */
function buildEditLiffUrl(expense: any, tripId: string, sourceId: string): string {
  return `${WEBAPP_URL}/#/liff/edit?tripId=${tripId}&id=${expense.id}&u=${encodeURIComponent(sourceId)}`
}

/**
 * 產生「編輯尚未確認的草稿」的 LIFF 網址。
 * 同樣只帶 nonce —— 完整內容已經存在 line_chat_history 的 pending 列，
 * LiffEdit 自己去撈（順便就能發現這張卡片已經被確認或取消過了）。
 */
function buildDraftLiffUrl(tripId: string, nonce: string, sourceId: string): string {
  return `${WEBAPP_URL}/#/liff/edit?tripId=${tripId}&n=${nonce}&u=${encodeURIComponent(sourceId)}`
}

/**
 * 列出近期支出讓使用者點選編輯（每列一顆 LIFF「✏️ 編輯」）。
 *
 * 兩個呼叫端：明確的「編輯支出」／`detectRecordIntent` 判定的修改意圖，
 * 以及 P8 的第二道防線 —— AI 把「剛剛那個改250」當成新支出時（T1），
 * 用 `notice` 補一句話說明為什麼看到的是清單而不是卡片。
 *
 * 清單本身依日期與建立時間倒序，剛存的那一筆一定在第一列，
 * 所以不需要另外做「直接開最新一筆」。
 */
async function replyEditPicker(opts: {
  tripId: string
  sourceId: string
  replyToken: string
  boundQR: { items: any[] }
  notice?: string
}): Promise<void> {
  const { tripId, sourceId, replyToken, boundQR, notice } = opts
  const { data: recent } = await supabase.from('expenses')
    .select('id, description, amount, currency, date, category, payer_data, split_data, photo_urls')
    .eq('trip_id', tripId)
    .is('deleted_at', null)
    // 結清紀錄不是支出：讓它出現在清單裡，使用者用 LIFF 一存就變成一般支出，統計會失真（H4）
    .not('is_settlement', 'is', true)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(6)

  if (!recent || recent.length === 0) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: notice ? `${notice}\n\n目前沒有可編輯的支出紀錄。` : '目前沒有可編輯的支出紀錄。',
      quickReply: boundQR,
    }], sourceId)
    return
  }

  const rows: any[] = []
  recent.forEach((e: any, idx: number) => {
    if (idx > 0) rows.push({ type: 'separator', margin: 'md' })
    rows.push({
      type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', alignItems: 'center',
      contents: [
        {
          type: 'box', layout: 'vertical', flex: 5, contents: [
            { type: 'text', text: String(e.description), size: 'sm', weight: 'bold', wrap: true },
            { type: 'text', text: `${e.date} · ${e.amount} ${e.currency}`, size: 'xxs', color: '#aaaaaa', margin: 'xs' },
          ],
        },
        {
          type: 'button', flex: 2, style: 'primary', color: '#5AC8FA', height: 'sm',
          action: { type: 'uri', label: '✏️ 編輯', uri: buildEditLiffUrl(e, tripId, sourceId) },
        },
      ],
    })
  })

  const noticeRow = notice
    ? [{ type: 'text', text: notice, size: 'xxs', color: '#E08A00', margin: 'sm', wrap: true }]
    : []

  await replyMessage(replyToken, [{
    type: 'flex', altText: '選擇要編輯的支出',
    contents: {
      type: 'bubble', size: 'mega',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '✏️ 選擇要編輯的支出', weight: 'bold', size: 'md' },
          { type: 'text', text: `最近 ${recent.length} 筆 · 點選後會開啟編輯畫面`, size: 'xxs', color: '#aaaaaa', margin: 'xs', wrap: true },
          ...noticeRow,
          { type: 'separator', margin: 'lg' },
          ...rows,
        ],
      },
    },
  }], sourceId)
}

/**
 * 待確認的記帳卡片。
 *
 * OCR、文字記帳、以及「幣別沒匯率 → 選一個幣別」（M10）三條路徑送出的卡片完全一樣，
 * 只差標題與有沒有收據縮圖。以前是三份幾乎相同的 Flex JSON 各自散在流程裡，
 * 改一個按鈕就得記得改三個地方。
 */
function buildExpenseCard(opts: {
  expense: any
  title: string
  altText: string
  heroUrl?: string | null
  nonce: string
  webUrl: string
  liffUrl: string
}): any {
  const { expense, title, altText, heroUrl, nonce, webUrl, liffUrl } = opts
  const amountRows = (data: Record<string, unknown>) =>
    Object.entries(data ?? {}).map(([name, amt]) => ({
      type: "box", layout: "horizontal",
      contents: [
        { type: "text", text: `• ${name}`, size: "xs", color: "#666666" },
        { type: "text", text: `${amt}`, size: "xs", color: "#666666", align: "end" },
      ],
    }))

  return {
    type: "flex", altText,
    contents: {
      type: "bubble",
      hero: heroUrl ? { type: "image", url: heroUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" } : null,
      body: {
        type: "box", layout: "vertical",
        contents: [
          { type: "text", text: title, weight: "bold", color: "#1DB446", size: "sm" },
          { type: "text", text: String(expense.description), weight: "bold", size: "xl", margin: "md", wrap: true },
          { type: "text", text: `📅 ${expense.date} · 🏷️ ${expense.category}`, size: "xs", color: "#aaaaaa", margin: "xs" },
          { type: "separator", margin: "md" },
          { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: [
            { type: "box", layout: "horizontal", contents: [
              { type: "text", text: "總金額", color: "#aaaaaa", size: "sm" },
              { type: "text", text: `${expense.amount} ${expense.currency}`, align: "end", size: "sm", weight: "bold" },
            ]},
            { type: "box", layout: "vertical", margin: "sm", contents: [
              { type: "text", text: "付款人", color: "#aaaaaa", size: "xs" },
              ...amountRows(expense.payer_data),
            ]},
            { type: "box", layout: "vertical", margin: "sm", contents: [
              { type: "text", text: "分帳明細", color: "#aaaaaa", size: "xs" },
              ...amountRows(expense.split_details),
            ]},
          ]},
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: "✅ 確認存入", data: JSON.stringify({ act: "save", n: nonce }) } },
          { type: "box", layout: "horizontal", spacing: "sm", contents: [
            { type: "button", style: "primary", color: "#5AC8FA", action: { type: "uri", label: "✏️ 編輯", uri: liffUrl } },
            { type: "button", style: "secondary", action: { type: "postback", label: "❌ 取消", data: JSON.stringify({ act: "cancel", n: nonce }) } },
          ]},
          { type: "button", style: "primary", color: "#AF52DE", action: { type: "uri", label: "🌐 查看網頁", uri: webUrl } },
        ],
      },
    },
  }
}

/** 餵給 AI 的對話輪數。太多會稀釋掉當下這句話的份量。 */
const CHAT_HISTORY_TURNS = 8

// 將待確認支出暫存於 chat_history，讓 postback 只傳 nonce（避免 300 bytes 上限）
async function storePendingExpense(sourceId: string, nonce: string, data: any) {
  await supabase.from('line_chat_history').insert({
    line_user_id: sourceId,
    role: 'pending',
    content: JSON.stringify({ n: nonce, ...data })
  })
}

/**
 * 舊卡片被按下時要說清楚「為什麼按不動」。
 *
 * 以前一律回「此操作已處理過囉」，使用者看到的是一張自己從沒按過的卡片
 * 卻說已經處理過 —— 那其實是被更新的記帳建議取代了（H1、H12）。
 */
function describeProcessedAction(actionType: string | null | undefined): string {
  switch (actionType) {
    case 'save':
      return '⚠️ 此筆支出已於先前成功存入！'
    case 'cancel':
      return '⚠️ 這張卡片先前已經取消了。'
    case 'superseded':
      return '⚠️ 這張卡片已被較新的記帳建議取代，請改按新的那一張卡片。'
    default:
      return '⚠️ 此操作已處理過囉！'
  }
}

async function getPendingExpense(sourceId: string, nonce: string): Promise<any | null> {
  const { data } = await supabase.from('line_chat_history')
    .select('content')
    .eq('line_user_id', sourceId)
    .eq('role', 'pending')
    .order('created_at', { ascending: false })
    .limit(10)
  if (!data) return null
  for (const row of data) {
    try {
      const parsed = JSON.parse(row.content)
      if (parsed.n === nonce) return parsed
    } catch { /* skip malformed */ }
  }
  return null
}

const BOT_SELF_INTRODUCTION = `您好！我是您的旅遊記帳小幫手「耀西」
您可以透過自然語言對我下指令，或是上傳收據照片，我會自動幫您處理記帳！

📍 綁定旅程：
1. 輸入「ID:您的旅程代碼」
(可從網站設定頁面取得)
2. 輸入「旅程密碼」
(還沒輸入密碼前反悔，可以說「取消綁定」)
3. 綁定後，我會列出目前的成員供您確認。

⚙️ AI 記帳偏好（整趟旅程共用）：
• 按下方「⚙️ 記帳偏好」按鈕編輯，或輸入「設定:預設由我付款，所有人均分金額。」
(這份偏好屬於整趟旅程，網頁的旅程設定頁看到的是同一份；輸入「設定?」可隨時查看)

💰 快速記帳相關功能：
• 基礎：可直接說「晚餐 1200」
• 收據分析：直接上傳照片
• 指定付款：說「小明付了Uber 300」
• 複雜分帳：說「拉麵 3000 日幣，小明先付，大家平分」
• 修正記帳：卡片還沒確認前，說「剛剛那筆改 500」或「取消」
• 撤銷記帳：輸入「取消上一筆」或「刪除上一筆」
• 刪除任一筆：輸入「刪除支出」，會列出近期紀錄讓你點選
• 修改任一筆：輸入「編輯支出」，點選後開啟編輯畫面

📊 快捷查詢（直接輸入或點選下方按鈕）：
• 今日支出 / 本月支出 / 結算 / 旅程總覽

💡 群組提醒：
問我問題時，請"@提及"我，或是喊「耀西」喚醒我，不然我平常都躲在蛋裡睡覺唷！
Yoshi! Yoshi!
`

const CURRENCY_TIMEZONE: Record<string, string> = {
  TWD: 'Asia/Taipei',   JPY: 'Asia/Tokyo',        KRW: 'Asia/Seoul',
  HKD: 'Asia/Hong_Kong', SGD: 'Asia/Singapore',   MYR: 'Asia/Kuala_Lumpur',
  THB: 'Asia/Bangkok',  VND: 'Asia/Ho_Chi_Minh',  IDR: 'Asia/Jakarta',
  PHP: 'Asia/Manila',   CNY: 'Asia/Shanghai',
  AUD: 'Australia/Sydney', NZD: 'Pacific/Auckland',
  GBP: 'Europe/London', EUR: 'Europe/Paris',       CHF: 'Europe/Zurich',
  USD: 'America/New_York', CAD: 'America/Toronto',
}

function getTripTimezone(trip: any): string {
  const candidates = [trip.base_currency, ...Object.keys(trip.rates || {})]
  for (const cur of candidates) {
    if (CURRENCY_TIMEZONE[cur]) return CURRENCY_TIMEZONE[cur]
  }
  return 'UTC'
}

function getTodayString(timezone = 'Asia/Taipei'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

/**
 * 快捷查詢的「各幣別合計」字串。
 *
 * 一律走 Decimal（sumByCurrency）再依 precision_config 格式化 ——
 * 原本用原生 `+=` 累加，USD 旅程的合計會出現 0.30000000000000004（H5）。
 */
function formatTotals(
  rows: { amount: number; currency: string }[],
  precisionConfig: Record<string, number>,
): string {
  return Object.entries(sumByCurrency(rows))
    .map(([currency, total]) => `${formatAmount(total.toNumber(), currency, precisionConfig)} ${currency}`)
    .join('・')
}

// 旅程密碼為選填：access_code 為 NULL 或全空白時代表免密碼，綁定不需驗證
function requiresAccessCode(code: string | null | undefined): boolean {
  return !!(code && code.trim())
}

/** 等待輸入通行碼的有效期限（M1）。超過就自動放棄，不會一直卡在等密碼狀態。 */
const PENDING_BIND_TTL_MS = 10 * 60 * 1000

/**
 * 這個 pending 綁定是不是已經過期了。
 * `pending_at` 為 null 代表是舊資料（欄位加上去之前寫的），一律視為過期 ——
 * 那些狀態本來就已經卡在那裡很久了。
 */
function isPendingExpired(pendingAt: string | null | undefined): boolean {
  if (!pendingAt) return true
  const started = new Date(pendingAt).getTime()
  if (Number.isNaN(started)) return true
  return Date.now() - started > PENDING_BIND_TTL_MS
}

function buildBindSuccessText(tripName: string, members: string[], tripId: string): string {
  return `✅ 綁定成功：\n${tripName}\n\n目前成員：\n${(members || []).join('、')}\n\n旅程網頁：\n${WEBAPP_URL}/#/trip/${tripId}/dashboard\n\n現在您可以直接「打字或上傳收據」請我記帳；想調整分帳習慣，按下方「⚙️ 記帳偏好」或輸入「設定: 預設付款人是我，大家平分」囉！`
}

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !LINE_CHANNEL_SECRET) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  // decodeBase64 回傳 Uint8Array<ArrayBufferLike>，新版 TS lib 不再視為 BufferSource
  const sigBytes = decodeBase64(signature) as unknown as BufferSource
  return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body))
}

/**
 * 重新閱讀某一筆支出的收據並回答問題。
 *
 * ⚠️ 一筆支出可能有多張收據照片（長帳單拍兩張），以前只分析 `photo_urls[0]`，
 *    第二張上的品項使用者永遠問不到 —— 現在全部一起送進去（T4）。
 *    prompt 開頭標明「這幾張是同一筆支出的收據」，模型才不會當成不相干的圖各自作答。
 */
async function analyzeReceiptPhoto(
  photoUrls: string[],
  question: string,
  expenseLabel: string,
): Promise<string> {
  const parts: any[] = []
  for (const url of photoUrls) {
    const part = await fetchPhotoPart(url)
    if (part) parts.push(part)
  }
  if (parts.length === 0) throw new Error('Failed to fetch any receipt photo')

  const analyzePrompt = `以下 ${parts.length} 張是同一筆支出「${expenseLabel}」的收據${parts.length > 1 ? '（同一筆的不同頁／不同張，請合併判讀）' : ''}。
請詳細分析並以繁體中文回答問題。若收據為外文（日文、韓文等），請逐項翻譯。
使用者的問題：${question}
回傳 JSON: {"type":"chat","content":"詳細的繁體中文回答，條列式呈現品項"}`
  const analysisText = await askGemini([{
    role: "user",
    parts: [{ text: analyzePrompt }, ...parts],
  }], { useJsonMode: false, models: GEMINI_OCR_MODELS })
  try {
    const analysisRes = JSON.parse(extractJSON(analysisText))
    return analysisRes.content || analysisText
  } catch {
    return analysisText.substring(0, 4900)
  }
}

async function pushMessage(to: string, messages: any[]) {
  console.log(`[LINE] Pushing to ${to}...`)
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  })
  if (!res.ok) console.error(`[LINE] Push Error: ${await res.text()}`)
}

async function replyMessage(replyToken: string, messages: any[], to?: string) {
  console.log(`[LINE] Replying to ${replyToken}...`)
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[LINE] Reply Error: ${errorText}`);
    if (to) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
        body: JSON.stringify({ to, messages: [{ type: 'text', text: `⚠️ 訊息發送失敗：\n${errorText}` }] }),
      })
    }
  }
}

// ============================================================
// 結構化輸出
//
// 以前是在 prompt 裡手寫 JSON 範例，靠 extractJSON 撈括號硬救格式錯誤。
// 交給 response_schema 之後，格式由 API 保證，prompt 只需專注在「內容」。
// ============================================================

// Gemini 的 response_schema 不支援 additionalProperties，
// 所以「成員 → 金額」不能寫成動態 key 的物件，只能用陣列表達。
// 解析後由 toAmountMap() 轉回程式內部慣用的 { 成員: 金額 }。
const AMOUNT_LIST_SCHEMA = {
  type: 'ARRAY',
  description: '每位成員分到的金額',
  items: {
    type: 'OBJECT',
    properties: {
      member: { type: 'STRING', description: '成員名稱，必須一字不差地來自成員清單' },
      amount: { type: 'NUMBER' },
    },
    required: ['member', 'amount'],
  },
}

const EXPENSE_DATA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    description: { type: 'STRING', description: '品項或商店名稱。外文請保留原文並在括號附繁體中文' },
    amount: { type: 'NUMBER', description: '總金額' },
    currency: { type: 'STRING', description: 'ISO 幣別代碼，例如 TWD / JPY / USD。只在 currency_source 不是 none 時才有意義' },
    // 幣別由程式決定而不是靠 prompt 記性（T3）：模型只需誠實回報「這個幣別是哪裡來的」，
    // 真正要填哪一個由 resolveCurrencyByRule() 依規則決定。
    currency_source: {
      type: 'STRING',
      enum: ['stated', 'preference', 'none'],
      description: 'stated＝使用者這句話（或收據上）明確出現幣別字眼或符號；preference＝記帳偏好指定；none＝都沒有',
    },
    date: { type: 'STRING', description: 'YYYY-MM-DD' },
    category: { type: 'STRING', description: '從分類清單中挑一個' },
    payer_data: AMOUNT_LIST_SCHEMA,
    split_details: AMOUNT_LIST_SCHEMA,
  },
  required: ['description', 'amount', 'currency', 'currency_source', 'date', 'category', 'payer_data', 'split_details'],
}

/** 文字對話：可能是記帳、聊天／查詢，或請系統重新分析某張收據 */
const TEXT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['expense', 'chat', 'analyze_photo'] },
    data: EXPENSE_DATA_SCHEMA,
    content: { type: 'STRING', description: 'type 為 chat 時的回覆內容' },
    // 只回編號，不要網址：要模型逐字抄回長網址，它常抄成上一輪對話裡的另一張（T4）
    expense_ref: {
      type: 'STRING',
      description: 'analyze_photo 時填近期支出的編號，例如 #3；不在清單裡就留空字串',
    },
    question: { type: 'STRING', description: 'type 為 analyze_photo 時使用者的問題' },
    corrects_draft: {
      type: 'STRING',
      description: '若這句話是在修正某張尚未確認的記帳草稿，填該草稿的 nonce；否則留空字串',
    },
  },
  required: ['type'],
}

/** 收據 OCR：認得出來就回 expense，不是收據就回 not_receipt */
const OCR_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['expense', 'not_receipt'] },
    data: EXPENSE_DATA_SCHEMA,
  },
  required: ['type'],
}

/**
 * 不隨對話變動的規則。放進 system_instruction 與每次的旅程 context 分開，
 * 模型比較不會在長對話中把人設或格式規則忘掉。
 */
const YOSHI_SYSTEM_INSTRUCTION = `你是旅遊記帳小幫手「耀西」，瑪利歐系列的角色，講話親切、偶爾穿插「Yoshi!」叫聲。
你的工作是把使用者的自然語言轉成記帳資料，或回答關於這趟旅程花費的問題。

不可違反的規則：
1. payer_data 與 split_details 的 key **只能**是使用者訊息中提供的「成員清單」裡的字串，一字不差。
   使用者用暱稱、諧音或縮寫時，可以合理推測對應到清單裡最接近的成員，並改用清單上的正式名稱。
   若沒把握對應到誰，寧可回傳 chat 詢問，**絕對不可以**自創或音譯出清單外的名字。
2. 金額盡量不帶小數，但 payer_data 與 split_details 的各自總和都必須完全等於 amount。
   🚫 **嚴禁換算匯率。** 使用者說「3000 日幣」就填 amount: 3000、currency: "JPY"，
   不可以自行換成旅程的主幣別。換算由系統在統計時處理。
   訊息裡**沒有出現幣別字眼**（日幣／円／¥／台幣／NT／美金／$ 之類）時，
   currency_source 填 "none"，currency 填旅程的**記帳預設幣別**（不是結算主幣別）。
3. 旅程已封存時，一律不可回傳 expense，改用 chat 說明無法記帳。
4. 歷史支出僅供查詢參考，不要把既有的支出重複記一次。
5. 查詢類的回答用條列式、簡短，適合在手機上閱讀。
6. 🚫 你**沒有**刪除或修改「已經存檔」的支出的能力。
   絕對不可以說「已經幫你刪除了」「我已經改好了」這類話 —— 那是假的。
   使用者想刪除或修改既有紀錄時，請回覆：請輸入「刪除支出」或「編輯支出」，
   系統會列出近期紀錄讓他點選。
   （你能做的只有：提出新的記帳建議、修正尚未存檔的草稿、以及查詢。）
7. 🚫 **金額類的問題不要自己做算術。** 訊息裡的【全趟彙總】是伺服器用 Decimal 算好的
   精確數字（總額、每人已付／應付／淨額、各分類、筆數、日期範圍），直接引用即可。
   【近期支出】只有最近 10 筆，把它們加起來當成總額一定是錯的。
   彙總裡沒有的切片（例如「第一天花多少」）就照實說目前算不出來，請他到網頁看，不要硬湊。
8. analyze_photo 的 expense_ref 只填近期支出清單上的編號（例如 "#3"），不要填網址或店名。
   使用者說「剛剛」「最新」又沒指名店名時，選清單裡日期最近且有 📷 的那一筆。
   問的那筆不在清單上就把 expense_ref 留空字串，系統會自己去全庫找。`

// For text tasks: start with the thinking model (better reasoning)
const GEMINI_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite', // 500 RPD free tier
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
]

// For OCR (vision + JSON mode): gemini-2.0-flash is more reliable than thinking models.
// Thinking models (gemini-2.5-flash) tend to output minimal valid JSON ("not_receipt")
// even for real receipts when JSON mode is enforced.
const GEMINI_OCR_MODELS = [
  'gemini-3.1-flash-lite', // 500 RPD free tier
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
]

interface AskGeminiOptions {
  /** 要求回傳 JSON。搭配 schema 時模型會被結構化輸出約束住 */
  useJsonMode?: boolean
  models?: string[]
  /** 不隨對話變動的規則（人設、輸出約束），與每次的旅程 context 分開 */
  systemInstruction?: string
  /** 回應的 JSON schema。給了就不必在 prompt 裡手寫格式範例 */
  responseSchema?: Record<string, unknown>
  /** 記帳要穩定，聊天可以活潑一點 */
  temperature?: number
}

async function askGemini(contents: any[], options: AskGeminiOptions = {}) {
  const {
    useJsonMode = true,
    models = GEMINI_FALLBACK_MODELS,
    systemInstruction,
    responseSchema,
    temperature,
  } = options

  const generationConfig: Record<string, unknown> = {}
  if (useJsonMode) generationConfig.response_mime_type = 'application/json'
  // 結構化輸出：由 API 保證格式，比在 prompt 裡描述 JSON 範例可靠得多
  if (useJsonMode && responseSchema) generationConfig.response_schema = responseSchema
  if (temperature !== undefined) generationConfig.temperature = temperature

  const body: Record<string, unknown> = { contents, generationConfig }
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] }
  }

  let lastError: string | null = null

  for (const model of models) {
    console.log(`[AI] Calling Gemini model: ${model}`)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      // 連線失敗／逾時也換下一個模型，不要整個放棄
      lastError = `fetch failed: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[AI] ${model} ${lastError}, trying next model...`)
      continue
    }

    if (response.status === 429) {
      lastError = 'rate limited'
      console.warn(`[AI] Rate limited on ${model}, trying next model...`)
      continue
    }
    if (response.status === 404 || response.status === 400) {
      // 404：模型已下架。400：這個模型不支援送出的設定（例如舊模型不吃 response_schema）
      lastError = `HTTP ${response.status}`
      console.warn(`[AI] ${model} rejected the request (${response.status}), trying next model...`)
      continue
    }
    if (response.status >= 500) {
      lastError = `HTTP ${response.status}`
      console.warn(`[AI] ${model} server error ${response.status}, trying next model...`)
      continue
    }
    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini API error ${response.status}: ${errText}`)
    }

    const data = await response.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      // 安全機制擋下或思考預算用盡都可能回空，換模型比直接失敗好
      lastError = `empty response (finishReason: ${data?.candidates?.[0]?.finishReason ?? 'unknown'})`
      console.warn(`[AI] ${model} returned ${lastError}, trying next model...`)
      continue
    }
    return text
  }

  throw new Error(`RATE_LIMIT: All Gemini models are currently rate limited or unavailable. Last error: ${lastError}`)
}

/**
 * 取得發言者的 LINE 顯示名稱。
 *
 * 三種來源三個 endpoint —— 原本只處理 group，
 * 導致多人聊天室的發言者永遠是「未知」，還被當成身分餵進 prompt。
 * 一對一也一樣抓不到，`我付的晚餐 300` 只能靠偏好設定猜付款人是誰。
 */
async function getChatMemberName(
  sourceType: 'user' | 'group' | 'room',
  chatId: string,
  userId: string,
): Promise<string> {
  try {
    const endpoint = sourceType === 'group'
      ? `https://api.line.me/v2/bot/group/${chatId}/member/${userId}`
      : sourceType === 'room'
        ? `https://api.line.me/v2/bot/room/${chatId}/member/${userId}`
        : `https://api.line.me/v2/bot/profile/${userId}`
    const response = await fetch(
      endpoint,
      { headers: { "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    if (!response.ok) {
      console.error(`[LINE API Error] 無法取得成員名稱: ${await response.text()}`);
      return "";
    }
    const profile = await response.json();
    console.log(`[PROFILE in GROUP] ${JSON.stringify(profile, null, 2)}`)
    return profile.displayName;
  } catch (error) {
    console.error("[Fetch Error] 呼叫 LINE API 失敗:", error);
    return "";
  }
}

serve(async (req) => {
  try {
    const signature = req.headers.get('x-line-signature')
    const bodyText = await req.text()
    if (!(await verifySignature(bodyText, signature))) return new Response('Unauthorized', { status: 401 })

    const { events } = JSON.parse(bodyText)
    for (const event of events) {
      console.log(`[EVENT_RAW] Received event type: ${event.type}`)

      const replyToken = event.replyToken
      const sourceId = event.source.groupId || event.source.roomId || event.source.userId
      const sourceType = event.source.type
      const isGroup = sourceType !== 'user'
      console.log(`[EVENT] ${JSON.stringify(event, null, 2)}`);

      // 群組／聊天室共用同一份綁定與偏好（刻意的設計，讓大家都能記同一本帳），
      // 但每次互動仍要看得出是誰做的。
      const speakerUserId: string | null = event.source.userId ?? null
      let memberName = "未知";
      // postback 也要查：存檔確認訊息是在 postback 分支送出的，
      // 少了這個就會顯示「由 未知 記錄」。
      const needsMemberName =
        (event.type === 'message' && (event.message?.type === 'text' || event.message?.type === 'image'))
        || event.type === 'postback';
      if (needsMemberName && speakerUserId) {
        const chatId = event.source.groupId || event.source.roomId || speakerUserId
        const fetchedName = await getChatMemberName(sourceType, chatId, speakerUserId);
        // 群組抓不到名字時至少給個可區分的代號；一對一就維持「未知」，
        // 那只是拿來餵 prompt，寫個假名字反而會誤導 AI 去對應成員。
        memberName = fetchedName || (isGroup ? `User_${speakerUserId.substring(0, 8)}` : '未知');
      }
      // 一對一的回覆不需要「由 X 記錄」這種贅述，只有群組才標記發言者。
      // 但 memberName 兩邊都要有：AI 靠它把「我付的」對應到成員（見 H9）。
      const speakerLabel = isGroup ? memberName : null

      let { data: userState } = await supabase.from('line_user_states').select('*').eq('line_user_id', sourceId).maybeSingle()
      if (!userState) {
        console.log(`[DB] Registering new state for sourceId: ${sourceId}`)
        const { data: newState } = await supabase.from('line_user_states').insert({ line_user_id: sourceId }).select().single()
        userState = newState
      }
      // 等密碼等太久就自動放棄（M1）。
      //
      // 以前沒有逾時也沒有取消指令，只能輸入正確密碼或另一個 ID 才脫身；
      // 群組裡更糟 —— 半小時後有人隨口講一句話，還是會被當成密碼回「密碼錯誤」。
      if (userState?.pending_trip_id && isPendingExpired(userState.pending_at)) {
        console.log(`[BIND] pending_trip_id expired for ${sourceId}, clearing`)
        await supabase.from('line_user_states')
          .update({ pending_trip_id: null, pending_at: null })
          .eq('line_user_id', sourceId)
        userState = { ...userState, pending_trip_id: null, pending_at: null }
      }
      // ⚠️ 不再要求 current_trip_id 為空（M1）：切換旅程時舊的綁定要留著，
      //    新旅程的密碼驗證成功了才換過去，中途放棄不該變成「沒綁定」。
      const isBinding = !!userState?.pending_trip_id
      const isBound = !!userState?.current_trip_id
      const mentionRequired = userState?.mention_required ?? true
      // last_active_at 原本是從沒被更新過的死欄位（M1 順手處理）。
      // 不影響回覆，交給背景寫。
      runInBackground(supabase.from('line_user_states')
        .update({ last_active_at: new Date().toISOString() })
        .eq('line_user_id', sourceId))
      // 預計算綁定狀態下的快速回覆（含群組切換按鈕與旅程偏好按鈕），整個 event 共用
      const boundQR = getQuickReply(true, isGroup, mentionRequired, userState?.current_trip_id)

      // --- 被加進群組／聊天室（M19）---
      // 以前完全不處理 join，機器人進來之後一片安靜，
      // 沒人知道它會做什麼、也不知道要先輸入 ID:代碼 綁定旅程。
      if (event.type === 'join') {
        console.log(`[JOIN] Added to ${sourceType} ${sourceId}`)
        await replyMessage(replyToken, [{
          type: 'text',
          text: BOT_SELF_INTRODUCTION,
          quickReply: isBound ? boundQR : getQuickReply(false),
        }], sourceId)
        continue
      }

      // --- Postback 處理 ---
      if (isBound && (event.type === 'postback')) {
        let postbackData: any
        try {
          postbackData = JSON.parse(event.postback.data)
        } catch {
          console.error('[POSTBACK] Failed to parse postback data:', event.postback.data)
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 無效的操作資料，請重試。' }], sourceId)
          continue
        }

        console.log(`[POSTBACK] Data: ${event.postback.data}`)

        // 撤銷存入（postback 按鈕）
        //
        // postback 只帶 eid：描述放進去的話，外文店名＋中文說明很容易讓整包
        // 超過 LINE 的 300 bytes 上限，整則「已存入」回覆會直接發送失敗（H12）。
        // 描述在這裡回查即可。舊卡片仍可能帶 d，留著當後備。
        if (postbackData.act === 'undo') {
          const expenseId = postbackData.eid
          if (!expenseId) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到可撤銷的記錄。' }], sourceId)
            continue
          }
          const { data: target } = await supabase.from('expenses')
            .select('description, deleted_at')
            .eq('id', expenseId)
            .eq('trip_id', userState.current_trip_id)
            .maybeSingle()
          const description = target?.description || postbackData.d || '該筆支出'

          if (!target) {
            await replyMessage(replyToken, [{
              type: 'text', text: '❌ 找不到這筆支出，可能已被永久刪除，或不屬於目前綁定的旅程。',
            }], sourceId)
            continue
          }
          // 已經撤銷過就別再 UPDATE 一次：deleted_at 被刷新的話，
          // 網頁垃圾桶的 24 小時保留期會整個重算（H3）。
          if (target.deleted_at) {
            await replyMessage(replyToken, [{
              type: 'text', text: `ℹ️ 「${description}」先前已經撤銷了。`, quickReply: boundQR,
            }], sourceId)
            continue
          }

          const { error } = await supabase.from('expenses')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', expenseId)
            .is('deleted_at', null)
          if (error) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 撤銷失敗，請至網頁手動刪除。' }], sourceId)
          } else {
            await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${description}`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        // 「以 XXX 存入」—— 收據的幣別在這趟旅程沒有匯率時的補救（M10）。
        // 照片與辨識結果已經先存成 pending，這裡只是換個幣別重新出卡，
        // 使用者不必為了改一個幣別重拍收據。
        if (postbackData.act === 'cur') {
          const oldNonce = postbackData.n
          const chosen = String(postbackData.c ?? '').toUpperCase()
          const pending = oldNonce ? await getPendingExpense(sourceId, oldNonce) : null
          if (!pending) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新傳送收據。' }], sourceId)
            continue
          }

          // 佔用舊 nonce，避免同一則訊息的按鈕被連按兩次而出兩張卡
          const { error: lockErr } = await supabase.from('line_processed_actions')
            .insert({ nonce: oldNonce, line_user_id: sourceId, action_type: 'superseded' })
          if (lockErr) {
            const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', oldNonce).maybeSingle()
            await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId)
            continue
          }

          const tripIdForCur = pending.tid || userState.current_trip_id
          const { data: curTrip } = await supabase.from('trips')
            .select('id, rates, precision_config, base_currency, default_currency, members').eq('id', tripIdForCur).maybeSingle()
          if (!curTrip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。' }], sourceId)
            continue
          }
          if (!Object.prototype.hasOwnProperty.call(curTrip.rates ?? {}, chosen)) {
            await replyMessage(replyToken, [{ type: 'text', text: `❌ 這趟旅程沒有 ${chosen} 的匯率，請先到網頁設定。` }], sourceId)
            continue
          }

          // 🚫 只換幣別標籤，金額不換算 —— 與兩個 prompt 的規則一致。
          //    但精度會變（USD 2 位 → TWD 0 位），所以分帳要照新精度重算：
          //    把原本的分配當成 lockedData 交回去，餘數由 calculateDistribution
          //    強制加到調整成員身上，Σ 一定等於總額。
          const src = pending.exp ?? {}
          const curPrecision = (curTrip.precision_config as any)?.[chosen] ?? DEFAULT_PRECISION[chosen] ?? 2
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
            p: photoIds, tid: tripIdForCur,
          })
          await replyMessage(replyToken, [buildExpenseCard({
            expense: curExpense,
            title: `🔍 已改用 ${chosen}`,
            altText: `確認記帳: ${curExpense.description}`,
            heroUrl: photoIds.length > 0 ? photoPublicUrl(photoIds[0], tripIdForCur) : null,
            nonce: newNonce,
            webUrl: `${WEBAPP_URL}/#/trip/${tripIdForCur}/dashboard`,
            liffUrl: buildDraftLiffUrl(tripIdForCur, newNonce, sourceId),
          })], sourceId)
          continue
        }

        // 從「刪除支出」清單點選的刪除
        if (postbackData.act === 'del') {
          const expenseId = postbackData.eid
          if (!expenseId) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這筆支出。' }], sourceId)
            continue
          }
          const { data: target } = await supabase.from('expenses')
            .select('description, deleted_at').eq('id', expenseId).maybeSingle()

          if (!target) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 這筆支出已不存在。' }], sourceId)
            continue
          }
          if (target.deleted_at) {
            await replyMessage(replyToken, [{
              type: 'text', text: `ℹ️ 「${target.description}」先前已經刪除了。`, quickReply: boundQR,
            }], sourceId)
            continue
          }

          const { error } = await supabase.from('expenses')
            .update({ deleted_at: new Date().toISOString() }).eq('id', expenseId)
          if (error) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 刪除失敗，請至網頁操作。' }], sourceId)
          } else {
            const by = speakerLabel ? `（由 ${speakerLabel} 刪除）` : ''
            await replyMessage(replyToken, [{
              type: 'text',
              text: `🗑 已刪除：${target.description}${by}\n\n24 小時內可到網頁的垃圾桶還原。`,
              quickReply: boundQR,
            }], sourceId)
          }
          continue
        }

        if (postbackData.action === 'save_expense' || postbackData.act === 'save') {
          const { n: nonce_short, expense: exp_old, exp: exp_new, photo_urls: p_old, p: p_new } = postbackData
          const nonce = nonce_short || postbackData.nonce

          // 優先從 chat_history 取得 pending 資料（避免 300 bytes 限制）
          let expenseRaw = exp_new || exp_old || postbackData.expense
          let photo_ids = p_new || p_old || postbackData.photo_urls || []
          let trip_id = postbackData.trip_id || userState?.current_trip_id

          if (!expenseRaw && nonce) {
            const pending = await getPendingExpense(sourceId, nonce)
            if (pending) {
              expenseRaw = pending.exp
              photo_ids = pending.p || []
              trip_id = pending.tid || trip_id
            }
          }

          if (!expenseRaw) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到待確認的支出資料，請重新記帳。' }], sourceId); continue
          }

          if (nonce) {
            const { error: nonceInsertError } = await supabase
              .from('line_processed_actions')
              .insert({ nonce, line_user_id: sourceId, action_type: 'save' });
            if (nonceInsertError) {
              // 查詢 action_type，給予更明確的重複操作提示
              const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
              await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId); continue
            }
          }

          if (!trip_id) {
            await replyMessage(replyToken, [{ type: 'text', text: `❌ 找不到對應旅程，請重新綁定。` }], sourceId); continue
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

          const { data: trip } = await supabase.from('trips')
            .select('precision_config, members, is_archived, default_payer, default_split_members')
            .eq('id', trip_id).single()

          if (!trip) {
            // 旅程可能已被刪除（見 docs/DB_MAINTENANCE.md），此時舊卡片的按鈕不該讓整個函式崩掉
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId);
            continue;
          }
          if (trip.is_archived) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 此旅程已封存，無法新增支出。' }], sourceId);
            continue;
          }

          const precision = (trip.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
          const numAmount = new Decimal(parseFloat(expense.amount as any) || 0).toDecimalPlaces(precision).toNumber()
          const payerMembers = Object.keys(expense.payer_data).filter(m => trip.members.includes(m))
          const splitMembers = Object.keys(expense.split_details).filter(m => trip.members.includes(m))

          // 空的付款人或分攤名單過去會一路走到「Σ != 總額」，
          // 使用者收到的是「財務運算發生錯誤，請聯絡管理員」這種毫無頭緒的訊息。
          // 卡片產生時已經補過預設值（applyParticipantDefaults），
          // 走到這裡還是空的多半是成員在存檔前被刪掉了，只能請使用者重新編輯。
          if (payerMembers.length === 0 || splitMembers.length === 0) {
            console.warn(`[SAVE] Empty participants after filtering. trip=${trip_id}`)
            // 沒有存成功就把 nonce 放掉，卡片上的按鈕才還能用（不然連「✏️ 編輯」都會說已處理過）
            await releaseNonce(nonce)
            await replyMessage(replyToken, [{
              type: 'text',
              text: '😅 這筆的付款人或分攤成員是空的（可能是成員已被移除），無法存入。\n\n請按卡片上的「✏️ 編輯」補上，或直接重說一次。',
              quickReply: boundQR,
            }], sourceId)
            continue
          }

          // 卡片上有、但成員清單裡已經沒有的名字（M12）。
          //
          // ⚠️ 不能默默存下去：被移除的人的份額會被 calculateDistribution
          //    當成餘數加到調整成員身上，Σ 仍然等於總額，所以下面的檢查也攔不住 ——
          //    帳面上完全正常，只是有個人平白多背了一份。
          const droppedPayers = Object.keys(expense.payer_data).filter(m => !trip.members.includes(m))
          const droppedSplits = Object.keys(expense.split_details).filter(m => !trip.members.includes(m))
          const dropped = [...new Set([...droppedPayers, ...droppedSplits])]
          if (dropped.length > 0) {
            console.warn(`[SAVE] Members no longer in trip: ${dropped.join(', ')}`)
            await releaseNonce(nonce)
            await replyMessage(replyToken, [{
              type: 'text',
              text: `😅 這張卡片上的「${dropped.join('、')}」已經不在旅程成員裡了，不能就這樣存入 —— `
                + `他的那一份會被默默算到別人頭上。\n\n`
                + `目前成員：${trip.members.join('、')}\n\n`
                + `請按卡片上的「✏️ 編輯」重新分攤，或直接重說一次。`,
              quickReply: boundQR,
            }], sourceId)
            continue
          }

          const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
          const finalPayerData = calculateDistribution(numAmount, payerMembers, expense.payer_data, payerMembers[0], precision)
          const finalSplitData = calculateDistribution(numAmount, splitMembers, expense.split_details, adjustMember, precision)

          const checkSum = (data: any) => Object.values(data).reduce((a: Decimal, b: any) => a.plus(new Decimal(b)), new Decimal(0))
          const payerSum = checkSum(finalPayerData)
          const splitSum = checkSum(finalSplitData)
          const target = new Decimal(numAmount).toDecimalPlaces(precision)

          if (!payerSum.equals(target) || !splitSum.equals(target)) {
            console.error(`[CRITICAL_VALIDATION_ERROR] Sum mismatch. P:${payerSum}, S:${splitSum}, T:${target}`)
            // 同上：沒存成功就把鎖放掉，卡片還能重按或改用「✏️ 編輯」
            await releaseNonce(nonce)
            await replyMessage(replyToken, [{ type: 'text', text: `❌ 財務運算發生錯誤，請聯絡管理員。` }], sourceId)
            continue
          }

          const { data: savedExpense } = await supabase.from('expenses').insert({
            trip_id: trip_id, description: expense.description, amount: target.toNumber(), currency: expense.currency,
            payer_data: finalPayerData, split_data: finalSplitData, date: expense.date, category: expense.category,
            photo_urls: photo_urls, adjustment_member: adjustMember
          }).select('id').single()

          // 記錄 expense_id 供文字指令「取消上一筆」使用。
          // ⚠️ 必須 await：Edge Runtime 會在回應送出後中止未完成的 promise，
          //    這一列掉了就會讓「取消上一筆」撤到更早的一筆支出（H11）。
          if (savedExpense?.id) {
            await supabase.from('line_chat_history').insert({
              line_user_id: sourceId, role: 'saved',
              content: JSON.stringify({
                expense_id: savedExpense.id,
                description: expense.description,
                by: speakerLabel,
              }),
              speaker_user_id: speakerUserId, speaker_name: speakerLabel,
            })
          }

          // 存入後附帶撤銷快速按鈕，讓使用者可即時反悔。
          // postback 只帶 eid —— 塞進描述會讓長店名超過 300 bytes，整則訊息發不出去（H12）。
          const undoItems = savedExpense?.id
            ? [{ type: "action", action: { type: "postback", label: "↩️ 撤銷", data: JSON.stringify({ act: "undo", eid: savedExpense.id }) } }]
            : []
          // 群組裡標明是誰記的，一對一就不必贅述
          const savedBy = speakerLabel ? `\n（由 ${speakerLabel} 記錄）` : ''
          await replyMessage(replyToken, [{
            type: 'text', text: `✅ 已存入：${expense.description}${savedBy}`,
            quickReply: { items: [...undoItems, ...boundQR.items] }
          }], sourceId)

        } else if (postbackData.action === 'cancel' || postbackData.act === 'cancel') {
          const nonce = postbackData.n ?? postbackData.nonce
          let photo_ids = postbackData.p ?? postbackData.photo_urls ?? []
          let trip_id = postbackData.trip_id ?? userState?.current_trip_id

          // 從 pending 取得照片資訊（用於刪除 Storage 的照片）
          if (photo_ids.length === 0 && nonce) {
            const pending = await getPendingExpense(sourceId, nonce)
            if (pending) {
              photo_ids = pending.p || []
              trip_id = pending.tid || trip_id
            }
          }

          if (nonce) {
            const { error: nonceInsertError } = await supabase
              .from('line_processed_actions')
              .insert({ nonce, line_user_id: sourceId, action_type: 'cancel' })
            if (nonceInsertError) {
              const { data: processed } = await supabase.from('line_processed_actions').select('action_type').eq('nonce', nonce).maybeSingle()
              await replyMessage(replyToken, [{ type: 'text', text: describeProcessedAction(processed?.action_type) }], sourceId); continue
            }
          }

          if (photo_ids.length > 0 && trip_id) {
            const urls = photo_ids.map((id: string) => id.includes('/') ? id : `expenses/${trip_id}/${id}.jpg`)
            console.log(`[PHOTO] Remove photo URL: ${urls}`)
            await supabase.storage.from(RECEIPTS_BUCKET).remove(urls)
          }

          await replyMessage(replyToken, [{ type: 'text', text: photo_ids.length > 0 ? '❌ 已取消並刪除照片。' : '❌ 已取消。' }], sourceId)
        }

        continue
      }

      // --- 圖片處理 (收據 OCR) ---
      if (isBound && (event.type === 'message' && event.message.type === 'image')) {
        const messageId = event.message.id

        if (!userState?.current_trip_id) {
          await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程，再傳送收據照片喔！' }], sourceId)
          continue
        }

        const tripId = userState.current_trip_id
        const filePath = `expenses/${tripId}/${messageId}.jpg`
        try {
          console.log(`[IMAGE] Downloading messageId: ${messageId}`)
          const [lineRes, { data: trip }] = await Promise.all([
            fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
              headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
            }),
            supabase.from('trips').select('*').eq('id', tripId).single()
          ])
          if (!lineRes.ok) throw new Error('Failed to download image from LINE')

          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
          // 照片還沒上傳，直接回覆就好，不需要清理 Storage。
          // 以前是靜默 continue —— 使用者傳了照片卻什麼都沒發生，
          // 與文件寫的「回覆已封存」不符（H8）。
          if (trip.is_archived) {
            console.log(`[PHOTO] Trip ${tripId} is archived, ignoring photo from ${sourceId}`)
            await replyMessage(replyToken, [{
              type: 'text', text: '🔒 此旅程已封存，無法新增支出（照片未儲存）。', quickReply: boundQR,
            }], sourceId)
            continue
          }

          const imageBuffer = await lineRes.arrayBuffer()

          console.log(`[STORAGE] Uploading to: ${filePath}`)
          const { error: uploadErr } = await supabase.storage.from(RECEIPTS_BUCKET).upload(filePath, imageBuffer, {
            contentType: 'image/jpeg', upsert: true
          })
          if (uploadErr) throw uploadErr

          const { data: { publicUrl } } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(filePath)
          const base64Image = encodeBase64(new Uint8Array(imageBuffer))
          const today = getTodayString(getTripTimezone(trip))

          const ocrPrompt = `
### 你的身份
你是一位專業又貼心的旅遊記帳小幫手「耀西」，是瑪利歐系列的一位知名角色。
在遊戲中的叫聲通常是高亢、可愛的「Yoshi! Yoshi!」或「嗯——嗯！」，與使用者聊天時，偶爾可以適當穿插這樣的叫聲。

### 你的任務
這是一張消費收據或發票的照片。請扮演專業的記帳小幫手並進行解析。

### 背景資訊
- 旅程：${trip.name} (網址: ${WEBAPP_URL}/#/trip/${tripId}/dashboard)
- 成員清單(僅能從中選擇成員)：${trip.members.join(', ')}
- 分類：${trip.categories.join(', ')} (預設: ${trip.default_category || '無'})
- 記帳預設幣別：${trip.default_currency || trip.base_currency}（收據上看不出幣別時填這個）
- 結算主幣別：${trip.base_currency}（只用於統計，不要拿來當記帳幣別）；可用幣別：${Object.keys(trip.rates ?? {}).join(', ') || '（尚未設定）'}
- 今日：${today}
- 封存狀態：${trip.is_archived ? '已封存 (唯讀)' : '進行中'}
- 記帳偏好(整趟旅程共用)：${trip.ai_preference || '無'}
- 使用者名稱(傳訊息的人)：${memberName}
- 旅程預設付款人：${trip.default_payer?.length ? trip.default_payer.join(', ') : '無'}
- 旅程預設分攤成員：${trip.default_split_members?.length ? trip.default_split_members.join(', ') : '全部成員'}

### 任務規則
1. 辨識「總金額」與「幣別」。
   - 🚫 **嚴禁換算匯率。** amount 必須是收據上印的那個數字，currency 必須是收據本身的幣別。
     例如日本的收據寫 3,200 円，就填 amount: 3200、currency: "JPY"，
     **絕對不可以**幫忙換成台幣，也不可以因為旅程的主幣別是 TWD 就改寫金額。
     換算是系統在統計時自己會做的事，你只要忠實照抄。
   - 幣別從符號、地址或語系判斷 (¥/JPY、$/USD、NT/TWD、€/EUR、₩/KRW、฿/THB)。
   - 收據上真的看不出幣別時，才依序參考：記帳偏好提及的幣別 → 背景資訊的記帳預設幣別。
   - currency_source 要誠實回報幣別是哪裡來的：收據上看得出來填 "stated"、
     只能靠記帳偏好推斷填 "preference"、兩者都沒有填 "none"
     （填 none 時系統會自動改用記帳預設幣別，不必勉強猜）。
2. 辨識「日期」。若收據上無明確日期，請使用今日。
3. 辨識「品項描述」。提取商店名稱或主要品項。
   - 外文店名請保留原文，並在括號內補上簡短的繁體中文說明，讓人看得懂那是什麼店，
     例如「肉の匠家 (和牛燒肉店)」、「一蘭ラーメン (拉麵)」、「ドン・キホーテ (驚安殿堂．藥妝百貨)」。
   - 括號裡寫「這是什麼」而不是逐字直譯；只寫原文別人會看不懂，只寫中文又失去原始資訊。
4. 辨識「分類」。若無法判別，可以先看是否有"其他"類別，若無"其他"類別可優先使用預設分類。
5. 請詳讀「記帳偏好」，再來決定 payer_data (墊付) 與 split_details (應付)。
   - 分帳時盡量不要有小數點(除非總金額有小數點)，按照以下規則分配好金額後，請務必確保總數加起來相等。
   - 🚫 payer_data 及 split_details 的 key **絕對只能**寫「成員清單」中已列出的字串，一字不差。
     若使用者用了暱稱、口誤、諧音或縮寫，可以合理推測對應到清單裡最接近的成員，並使用清單上的正式名稱。
     但若沒把握、找不到夠接近的對應，請寧可走「成員第一位 / 全員均分」的預設邏輯，**絕對不可以**自創、音譯、或把不存在的名字寫進 JSON。
   - 墊付邏輯的優先權(payer_data):
     1. 旅程預設付款人（若有設定）
     2. 記帳偏好內所提及的預設付款人
     3. 根據上述的「使用者名稱」，判斷是否可對應到某一名成員，即該成員擔任付款人。(對應關係可能會在記帳偏好中提及，但請注意務必要用「成員清單」內定義的名字)
     4. 由成員中第一位擔任付款人
   - 金額分攤邏輯的優先權(split_details):
     1. 旅程預設分攤成員（若有設定）
     2. 記帳偏好所提及的分攤方式
     3. 全員均分
6. 回傳格式由系統的 response schema 約束，type 請填 "expense"。
   payer_data 與 split_details 都是陣列，每個元素是 { "member": "成員名稱", "amount": 金額 }。
7. 如果這看起來**與消費無關**（例如：人物照、風景照、風景明信片、與消費無關的截圖），
   請回傳 type: "not_receipt"，無需任何說明或讚美，系統會自動清除照片。
   ⚠️ 但**付款成功畫面與交易通知一律視為收據**，照常回 type: "expense"：
   行動支付（LINE Pay、街口、PayPay、Suica、悠遊卡）的付款完成畫面、
   信用卡的消費通知簡訊或 App 推播、轉帳成功畫面、電子發票畫面、訂單確認頁。
   這些沒有紙本收據的品項描述，就用商店名稱或服務名稱當描述。
8. **重要限制**：若封存狀態為「已封存」，一律回傳 type: "not_receipt"，系統會另行告知使用者旅程已封存。
`

          const aiResponse = await askGemini([
            { role: "user", parts: [
              { text: ocrPrompt },
              { inlineData: { mimeType: "image/jpeg", data: base64Image } }
            ]}
          ], { models: GEMINI_OCR_MODELS, responseSchema: OCR_RESPONSE_SCHEMA, temperature: 0.2 })

          let res: any
          try {
            res = JSON.parse(extractJSON(aiResponse))
          } catch {
            console.error('[OCR] Non-JSON response:', aiResponse.substring(0, 200))
            await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
            await replyMessage(replyToken, [{ type: 'text', text: '😅 收據辨識格式異常，請重新傳送照片。' }], sourceId)
            continue
          }
          if (res.type === 'expense') {
            const expense = res.data

            normalizeExpenseAmountMaps(expense)

            // 成員名稱：先嘗試對應回正式名稱（暱稱、大小寫、部分符合都能救回來）。
            // 對不上的名字由 resolveExpenseMembers 從 map 裡拿掉，後面的
            // applyParticipantDefaults 會補上旅程預設 —— 照片留著、卡片照出，
            // 使用者按「✏️ 編輯」改就好（M10）。
            // 以前是刪照片、要人家重傳一次，只為了改一個名字。
            const { unresolved } = resolveExpenseMembers(expense, trip.members)
            const memberWarning = unresolved.length > 0
              ? `⚠️ 收據的分帳裡有對不上的名字：${unresolved.join('、')}\n`
                + `（目前成員：${trip.members.join('、')}）\n`
                + '已改用旅程的預設分攤，不對的話請按卡片上的「✏️ 編輯」。'
              : null
            if (unresolved.length > 0) console.warn(`[OCR] Unresolvable members: ${unresolved.join(', ')}`)

            // 幣別與日期的把關。以前這兩個欄位是 AI 講什麼就寫什麼，
            // 幻想出來的幣別會讓金額在統計時默默失真，錯誤的年份則會讓支出跑到別的月份去。
            // 幣別先走規則（T3）：AI 說 none 就一律用旅程的記帳預設幣別。
            // OCR 沒有使用者文字可以驗證 stated，所以 text 傳 null 代表直接採信。
            const ocrRule = resolveCurrencyByRule(expense.currency, expense.currency_source, null, trip)
            if (ocrRule.overrode) {
              console.log(`[CURRENCY] OCR said ${expense.currency} (source=${expense.currency_source}), using ${ocrRule.currency}`)
            }
            expense.currency = ocrRule.currency
            const ocrCurrency = normalizeCurrency(expense.currency, trip)
            if (ocrCurrency.reject) {
              // 這趟旅程沒有這個幣別的匯率。直接存下去統計會以 1:1 換算而失真，
              // 所以還是不能存 —— 但**照片要留著**（M10）。
              // 以前是連照片一起刪掉，使用者設好匯率後還得把收據重拍一次。
              // 改成把辨識結果暫存起來，附上「以 XXX 存入」的快速回覆讓他當場選一個幣別。
              const available = Object.keys(trip.rates ?? {})
              applyParticipantDefaults(expense, trip, memberName)
              const pendingNonce = Math.random().toString(36).substring(2, 10)
              await storePendingExpense(sourceId, pendingNonce, {
                exp: {
                  d: expense.description, a: expense.amount, c: expense.currency,
                  dt: normalizeDate(expense.date, today).date, cat: expense.category,
                  p: expense.payer_data, s: expense.split_details,
                },
                p: [messageId], tid: tripId,
              })
              // 幣別按鈕 + 取消。快速回覆上限 13 顆，留一顆給取消。
              const currencyItems = available.slice(0, 12).map(cur => ({
                type: 'action',
                action: {
                  type: 'postback', label: `以 ${cur} 存入`,
                  data: JSON.stringify({ act: 'cur', n: pendingNonce, c: cur }),
                },
              }))
              await replyMessage(replyToken, [{
                type: 'text',
                text: `${ocrCurrency.reject}\n\n📷 收據已經先幫你留著了，選一個幣別就能直接存入（金額不會換算）。`,
                quickReply: {
                  items: [
                    ...currencyItems,
                    { type: 'action', action: { type: 'postback', label: '❌ 取消', data: JSON.stringify({ act: 'cancel', n: pendingNonce }) } },
                  ],
                },
              }], sourceId)
              continue
            }
            expense.currency = ocrCurrency.currency
            const ocrDate = normalizeDate(expense.date, today)
            expense.date = ocrDate.date
            // 分類也要驗（M18）：AI 回「美食」但旅程只有「餐飲」時，
            // 以前會原封不動存進去，網頁的分類統計就多出一個永遠選不到的欄位（F7）。
            const ocrCategory = resolveCategory(expense.category, trip.categories, trip.default_category)
            expense.category = ocrCategory.category
            const ocrWarnings = [memberWarning, ocrCurrency.warning, ocrCategory.warning, ocrDate.warning].filter(Boolean) as string[]

            // AI 偶爾會回空的付款人或分攤，卡片會出現整片空白的區塊，
            // 按下確認才在 Σ 檢查那裡爆掉。先套上與網頁快速記帳一致的預設值（H6）。
            // 補上的預設值只是 0 佔位：分配時必須改傳 {} 當 lockedData，
            // 否則 0 會被 calculateDistribution 當成「鎖定金額」，整筆餘額落到調整成員身上。
            const { filledPayer, filledSplit } = applyParticipantDefaults(expense, trip, memberName)

            const precision = (trip?.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
            expense.amount = new Decimal(expense.amount || 0).toDecimalPlaces(precision).toNumber()
            const payerMembers = Object.keys(expense.payer_data)
            const splitMembers = Object.keys(expense.split_details)
            const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
            if (payerMembers.length > 0) {
              expense.payer_data = calculateDistribution(expense.amount, payerMembers, filledPayer ? {} : expense.payer_data, payerMembers[0], precision)
            }
            if (splitMembers.length > 0) {
              expense.split_details = calculateDistribution(expense.amount, splitMembers, filledSplit ? {} : expense.split_details, adjustMember, precision)
            }

            const photo_ids = [messageId]
            const nonce = Math.random().toString(36).substring(2, 10)
            const exp_short = {
              d: expense.description, a: expense.amount, c: expense.currency,
              dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
            }

            // ⚠️ 這裡刻意不讓舊草稿失效。一次選兩張收據送出時，
            //    第二張會讓第一張作廢，使用者只記得到最後一張（H1、H7）。
            //    卡片失效只發生在 AI 明確指出「這句是在修正某張草稿」的時候。
            await storePendingExpense(sourceId, nonce, { exp: exp_short, p: photo_ids, tid: tripId })

            // 摘要要帶 nonce：AI 才有辦法用 corrects_draft 指名它要修正哪一張卡片
            const historySummary = `[記帳建議] ${JSON.stringify({ ...expense, photo_ids, nonce }, null, 2)}`
            runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary }))

            const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
            // 草稿卡片的「✏️ 編輯」只帶 nonce，完整內容 LiffEdit 自己去 pending 列撈（T2）
            const liffUrl = buildDraftLiffUrl(trip.id, nonce, sourceId)

            // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西
            const ocrWarningMsg = ocrWarnings.length > 0
              ? [{ type: 'text' as const, text: ocrWarnings.join('\n') }]
              : []

            await replyMessage(replyToken, [...ocrWarningMsg, buildExpenseCard({
              expense,
              title: "🔍 AI 辨識結果",
              altText: `收據辨識預覽: ${expense.description}`,
              heroUrl: publicUrl,
              nonce, webUrl, liffUrl,
            })], sourceId)
          } else if (res.type === 'not_receipt') {
            console.log(`[PHOTO] Not a receipt, deleting: ${filePath}`)
            await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
            // 群組維持靜默（大家常在群裡貼風景照，不該每張都被機器人回一句），
            // 但一對一非回不可 —— 使用者傳了照片卻什麼都沒發生，
            // 根本不知道是沒收到、當機了、還是被判定不是收據（M8）。
            if (!isGroup) {
              await replyMessage(replyToken, [{
                type: 'text',
                text: '🤔 這張看起來不是收據，所以我沒有記帳（照片也沒有留下）。\n\n'
                  + '如果要記這一筆，直接打字就可以，例如「晚餐 300」。\n'
                  + '行動支付的付款完成畫面、信用卡消費通知截圖我也讀得懂，可以再試一次。',
                quickReply: boundQR,
              }], sourceId)
            }
          } else {
            console.log(`[PHOTO] Non-expense photo response, deleting: ${filePath}`)
            await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
            await replyMessage(replyToken, [{ type: 'text', text: res.content || '抱歉，這張照片我辨識不出來。' }], sourceId)
          }
        } catch (e) {
          console.error('[OCR_ERROR]', e)
          await supabase.storage.from(RECEIPTS_BUCKET).remove([filePath])
          const msg = isRateLimit(e) ? RATE_LIMIT_MSG : '😵 處理圖片時發生錯誤，請稍後再試。'
          await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
        }
        continue
      }

      // --- 非文字訊息則跳過處理 ---
      if (event.type !== 'message' || event.message.type !== 'text') {
        console.log(`[SKIP] Not a text message event.`)
        continue
      }

      // ⚠️ mentionees 的 index 是相對於**原始未 trim 的** text，切 mention 要用原文（M16）
      const rawText: string = event.message.text
      const mentionees = event.message.mention?.mentionees as any[] | undefined
      const userText = rawText.trim()
      console.log(`[USER_TEXT] "${userText}"`)

      const isMentioned = mentionees?.some((m: any) => m.isSelf === true)
      const isIdCommand = userText.toUpperCase().startsWith('ID:') || userText.toUpperCase().startsWith('ID：')
      const QUICK_CMD_KEYWORDS = ['今日支出', '今天支出', '本週支出', '近期支出', '本月支出', '結算', '旅程總覽']
      const UNDO_KEYWORDS = ['取消上一筆', '撤銷上一筆', '刪除上一筆', '刪掉上一筆', '移除上一筆']
      const DELETE_LIST_KEYWORDS = ['刪除支出', '刪除紀錄', '刪除記錄', '管理支出', '刪除哪一筆']
      const EDIT_LIST_KEYWORDS = ['編輯支出', '編輯紀錄', '編輯記錄', '修改支出', '修改紀錄']
      const isUndoKeyword = UNDO_KEYWORDS.includes(userText)
      const isDeleteListKeyword = DELETE_LIST_KEYWORDS.includes(userText)
      const isEditListKeyword = EDIT_LIST_KEYWORDS.includes(userText)
      const isToggleKeyword = userText === '模式:全回應模式' || userText === '模式:提及模式'
      // ⚠️ 只認真正的偏好指令（M3）。以前是 startsWith('設定')，
      //    群組裡的「設定好了嗎」「設定完再跟我說」都會被當成管理指令送進 AI。
      const isPreferenceCmd = /^設定[:：]/.test(userText) || userText === '設定?' || userText === '設定？'
      const isBindCancelKeyword = userText === '取消綁定' || userText === '放棄綁定'
      const isManagement = isPreferenceCmd || userText === '斷開' || userText === '切換旅程' || isBindCancelKeyword || QUICK_CMD_KEYWORDS.includes(userText) || isUndoKeyword || isDeleteListKeyword || isEditListKeyword || isToggleKeyword

      // 「耀西」必須出現在訊息開頭（去除 @mention 前綴後），避免誤觸
      // 只拿掉「提及機器人」的那幾段，其他人的 @名字要留著（M16）——
      // 以前一律刪掉所有 @開頭的詞，「@耀西 @小明 你付的晚餐 300」的付款人整個消失（L14）。
      const withoutSelfMention = stripSelfMentions(rawText, mentionees)
      const startsWithYoshi = withoutSelfMention.startsWith('耀西')

      // 群組觸發邏輯：
      //   - 全回應模式（mention_required=false）→ 處理所有訊息
      //   - 快捷指令、設定指令 → 免觸發
      //   - AI 記帳/聊天 → 須 @提及 或名字開頭
      let shouldProcess = !isGroup
      if (isGroup) {
        if (!mentionRequired) {
          // 全回應模式：群組所有訊息皆處理
          shouldProcess = true
        } else if (isMentioned || startsWithYoshi) {
          // @提及 或名字開頭：完整處理
          shouldProcess = true
        } else if (!isBound) {
          // 未綁定：僅允許 ID 綁定流程
          if (isIdCommand || isBinding) shouldProcess = true
        } else if (isBound && (isIdCommand || isManagement)) {
          // 已綁定：管理指令（含切換觸發模式）免觸發
          shouldProcess = true
        }
      }

      if (!shouldProcess) {
        console.log(`[SKIP] Group message without trigger/mention.`)
        continue
      }

      const cleanText = withoutSelfMention.replace(/^耀西\s*/, '').trim()

      // 0a. 明確想看使用說明 → 完整介紹
      const HELP_KEYWORDS = ['使用說明', '說明', '教學', '怎麼用', '怎麼使用', '如何使用', 'help', 'HELP', 'Help', '功能']
      if (HELP_KEYWORDS.includes(cleanText)) {
        await replyMessage(replyToken, [{ type: 'text', text: BOT_SELF_INTRODUCTION, quickReply: isBound ? boundQR : getQuickReply(false) }], sourceId)
        continue
      }

      // 0b. 只是被叫到（純提及或只打「耀西」）→ 一句話 + 按鈕就好。
      //     大多數時候使用者只是想看有哪些按鈕可以按，不是要讀整篇說明。
      if (cleanText === '' || cleanText === '耀西') {
        const shortMsg = isBound
          ? 'Yoshi! 🥚 需要什麼？直接打「晚餐 300」就能記帳，或用下面的按鈕。'
          : 'Yoshi! 🥚 請先輸入「ID:旅程代碼」來連結旅程。'
        await replyMessage(replyToken, [{
          type: 'text',
          text: shortMsg,
          quickReply: isBound ? boundQR : getQuickReply(false),
        }], sourceId)
        continue
      }

      // 1. ID 綁定 / 切換旅程
      if (cleanText.toUpperCase().startsWith('ID:') || cleanText.toUpperCase().startsWith('ID：')) {
        const linebotId = cleanText.substring(3).trim().toUpperCase()
        const { data: mapping } = await supabase.from('line_trip_id_mapping').select('trip_id').eq('linebot_id', linebotId).maybeSingle()
        if (mapping) {
          if (userState?.current_trip_id === mapping.trip_id) {
            await replyMessage(replyToken, [{ type: 'text', text: '✅ 您已綁定此旅程，無需重複綁定。' }], sourceId)
          } else {
            const { data: targetTrip } = await supabase.from('trips').select('access_code, name, members').eq('id', mapping.trip_id).maybeSingle()
            if (targetTrip && !requiresAccessCode(targetTrip.access_code)) {
              // 免密碼旅程：略過驗證步驟，直接完成綁定
              await supabase.from('line_user_states')
                .update({ current_trip_id: mapping.trip_id, pending_trip_id: null, pending_at: null })
                .eq('line_user_id', sourceId)
              // 換了旅程，舊草稿的 tid 指向上一趟，必須全部失效（M13）
              await supersedeAllDrafts(sourceId)
              await replyMessage(replyToken, [{
                type: 'text',
                text: buildBindSuccessText(targetTrip.name, targetTrip.members, mapping.trip_id),
                // boundQR 是綁定前算的：沒有「記帳偏好」按鈕，切換旅程時還會指到舊旅程
                quickReply: getQuickReply(true, isGroup, mentionRequired, mapping.trip_id)
              }], sourceId)
            } else {
              // ⚠️ 這裡**不動 current_trip_id**（M1）。
              //    以前是當下就清空，使用者打錯代碼或改變主意就變成完全沒綁定，
              //    而且沒有任何指令可以退回去。現在原本的旅程照常用，
              //    等新旅程的密碼驗證成功了才切換。
              const msg = userState?.current_trip_id
                ? '🔄 已找到旅程！請輸入新旅程密碼以切換（10 分鐘內有效；想放棄請輸入「取消綁定」，原旅程的綁定會保留）。'
                : '🔍 已找到旅程！請輸入密碼驗證（10 分鐘內有效，想放棄請輸入「取消綁定」）。'
              await supabase.from('line_user_states')
                .update({ pending_trip_id: mapping.trip_id, pending_at: new Date().toISOString() })
                .eq('line_user_id', sourceId)
              await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
            }
          }
        } else {
          await replyMessage(replyToken, [{ type: 'text', text: `❌ 找不到代碼 [${linebotId}]` }], sourceId)
        }
        continue
      }

      // 1b. 放棄綁定（M1）——「輸入 ID 後反悔」以前完全沒有出口
      if (cleanText === '取消綁定' || cleanText === '放棄綁定') {
        if (!isBinding) {
          await replyMessage(replyToken, [{
            type: 'text',
            text: 'ℹ️ 目前沒有在等待密碼。想解除已綁定的旅程請輸入「斷開」。',
            quickReply: isBound ? boundQR : getQuickReply(false),
          }], sourceId)
          continue
        }
        await supabase.from('line_user_states')
          .update({ pending_trip_id: null, pending_at: null })
          .eq('line_user_id', sourceId)
        await replyMessage(replyToken, [{
          type: 'text',
          text: isBound
            ? '✅ 已取消綁定流程，維持原本綁定的旅程。'
            : '✅ 已取消綁定流程。要重新開始請輸入「ID:您的代碼」。',
          quickReply: isBound ? boundQR : getQuickReply(false),
        }], sourceId)
        continue
      }

      // 2. 斷開
      if (isBound && (cleanText === '斷開' || cleanText === '切換旅程')) {
        await supabase.from('line_user_states')
          .update({ current_trip_id: null, pending_trip_id: null, pending_at: null })
          .eq('line_user_id', sourceId)
        // 沒有旅程可以存進去了，留著的卡片按下去只會出錯（M13）
        await supersedeAllDrafts(sourceId)
        await replyMessage(replyToken, [{ type: 'text', text: '❌ 已解除連接。如需重新連接，請輸入 ID:您的代碼', quickReply: getQuickReply(false) }], sourceId); continue
      }

      // 3. 切換群組回應模式
      if (isBound && (cleanText === '模式:全回應模式' || cleanText === '模式:提及模式')) {
        const newMentionRequired = cleanText === '模式:提及模式'
        await supabase.from('line_user_states').update({ mention_required: newMentionRequired }).eq('line_user_id', sourceId)
        const msg = newMentionRequired
          ? '🎯 已切換為提及模式。\n群組中需 @提及 或以「耀西」開頭才會回應。'
          : '📣 已切換為全回應模式。\n群組中所有訊息都會被耀西處理！'
        await replyMessage(replyToken, [{ type: 'text', text: msg, quickReply: getQuickReply(true, isGroup, newMentionRequired) }], sourceId)
        continue
      }

      // 4. 查看旅程的 AI 記帳偏好
      //    偏好存在 trips.ai_preference，整趟旅程共用一份，網頁的設定頁看到的是同一份。
      if (isBound && (cleanText === '設定?' || cleanText === '設定？')) {
        const { data: prefTrip } = await supabase.from('trips')
          .select('ai_preference').eq('id', userState.current_trip_id).maybeSingle()
        if (!prefTrip) {
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
          continue
        }
        const config = prefTrip.ai_preference
        const msg = config
          ? `⚙️ 這趟旅程目前的 AI 記帳偏好：\n\n${config}\n\n（整趟旅程共用一份，網頁的旅程設定頁也看得到）\n\n要修改請按下方「⚙️ 記帳偏好」，或輸入「設定: 新的內容」。`
          : '⚙️ 這趟旅程還沒設定 AI 記帳偏好。\n\n按下方「⚙️ 記帳偏好」開啟編輯畫面，或輸入「設定: 預設由我付款，大家均分」。'
        await replyMessage(replyToken, [{
          type: 'text', text: msg, quickReply: preferenceQuickReply(userState.current_trip_id, isGroup, mentionRequired),
        }], sourceId)
        continue
      }

      // 4. 設定旅程的 AI 記帳偏好（文字捷徑；完整編輯走 LIFF 表單）
      if (isBound && (cleanText.startsWith('設定:') || cleanText.startsWith('設定：'))) {
        const config = cleanText.substring(3).trim()
        if (!config) {
          await replyMessage(replyToken, [{
            type: 'text',
            text: '⚙️ 設定內容不能為空，請輸入偏好內容，例如：\n「設定: 預設由我付款，大家均分」\n\n要清空請輸入「設定:清除」。',
            quickReply: preferenceQuickReply(userState.current_trip_id, isGroup, mentionRequired),
          }], sourceId)
          continue
        }
        // 「清除」是唯一的保留字：否則會把「清除」兩個字原封不動存成偏好內容
        const isClear = config === '清除' || config === '清空'
        const { error: prefError } = await supabase.from('trips')
          .update({ ai_preference: isClear ? null : config })
          .eq('id', userState.current_trip_id)
        if (prefError) {
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 偏好儲存失敗，請稍後再試或改用網頁設定頁。' }], sourceId)
          continue
        }
        const msg = isClear
          ? '⚙️ 已清空這趟旅程的 AI 記帳偏好。'
          : '⚙️ 已更新這趟旅程的 AI 記帳偏好，之後記帳時會參考它。\n（整趟旅程共用一份，網頁的旅程設定頁也看得到）'
        await replyMessage(replyToken, [{
          type: 'text', text: msg, quickReply: preferenceQuickReply(userState.current_trip_id, isGroup, mentionRequired),
        }], sourceId)
        continue
      }

      // 5. 密碼驗證
      if (isBinding) {
        const { data: trip } = await supabase.from('trips').select('access_code, name, members').eq('id', userState.pending_trip_id).maybeSingle()
        // 免密碼旅程（例如等待輸入期間密碼被移除）也直接放行
        const matched = !!trip && (!requiresAccessCode(trip.access_code) || trip.access_code === cleanText)

        if (matched) {
          // 驗證成功「才」切換 current_trip_id（M1）
          await supabase.from('line_user_states')
            .update({ current_trip_id: userState.pending_trip_id, pending_trip_id: null, pending_at: null })
            .eq('line_user_id', sourceId)
          // 換旅程了，舊草稿的 tid 指向上一趟，全部失效（M13）
          await supersedeAllDrafts(sourceId)
          await replyMessage(replyToken, [{
            type: 'text',
            text: buildBindSuccessText(trip!.name, trip!.members, userState.pending_trip_id),
            // 同上：要用剛綁定的旅程算快速回覆，boundQR 裡沒有偏好按鈕
            quickReply: getQuickReply(true, isGroup, mentionRequired, userState.pending_trip_id)
          }], sourceId)
          continue
        }

        if (!isBound) {
          // 全新綁定：這個聊天現在沒有別的事可做，所以密碼錯了就要講。
          // 但群組裡別人的閒聊不該收到「密碼錯誤」（A13、M1）——
          // 只有明確對機器人講話（@提及或以「耀西」開頭）才回覆，其餘靜默。
          if (!isGroup || isMentioned || startsWithYoshi) {
            await replyMessage(replyToken, [{
              type: 'text',
              text: '❌ 密碼錯誤。再試一次，或輸入「取消綁定」放棄（10 分鐘沒動作也會自動放棄）。',
            }], sourceId)
          } else {
            console.log(`[BIND] Ignoring group chatter while waiting for access code: ${sourceId}`)
          }
          continue
        }

        // 切換旅程中（已綁定 + 等新旅程密碼）。
        // 明確對機器人講的話一律當成密碼嘗試回「密碼錯誤」——
        // 直接放行到 AI 的話，打錯的密碼「1235」會被當成一筆 1235 元的支出。
        // 群組裡沒 @ 的閒聊才放行給原旅程的正常流程（提及模式下本來也不會處理）。
        if (!isGroup || isMentioned || startsWithYoshi) {
          await replyMessage(replyToken, [{
            type: 'text',
            text: '❌ 密碼錯誤。再試一次，或輸入「取消綁定」放棄切換（原旅程的綁定會保留；10 分鐘沒動作也會自動放棄）。',
          }], sourceId)
          continue
        }
        console.log(`[BIND] Group chatter during trip switch; falling through to the current trip.`)
      }

      // 6. AI 核心
      if (isBound) {
        const tripId = userState.current_trip_id

        // 一次查、整個 event 共用。文字路徑有兩個地方要用到還沒確認的草稿：
        // 這裡的路由判斷，以及後面餵給 AI 的 context。
        let draftsCache: OutstandingDraft[] | null = null
        const loadDrafts = async (): Promise<OutstandingDraft[]> => {
          if (!draftsCache) draftsCache = await getOutstandingDrafts(sourceId)
          return draftsCache
        }

        // 明確指令，或用自然語言表達的同一個意圖。
        // 兩者都必須在進 AI 之前處理掉，否則會變成重複記帳或收到假的完成訊息。
        const recordIntent = detectRecordIntent(cleanText)
        const isDeleteListKeyword = DELETE_LIST_KEYWORDS.includes(cleanText)
        const isEditListKeyword = EDIT_LIST_KEYWORDS.includes(cleanText)
        const isCancelDraftKeyword = CANCEL_DRAFT_KEYWORDS.includes(cleanText)

        // 同一句話在「有沒有未確認的草稿」時該走完全不同的路：
        //   有草稿 → 「剛剛那筆改 500」是要修那張卡片（交給 AI），「取消」是要丟掉它
        //   沒草稿 → 兩者都是在講已存檔的紀錄，只能列清單讓使用者點選
        // 以前一律走清單，自我介紹宣傳的「剛剛那筆改 500」因此永遠到不了 AI（H2）。
        // 明確打「編輯支出」「刪除支出」「刪除上一筆」的人是要管理既有紀錄，不受草稿影響。
        const wantsDraftAction = !isDeleteListKeyword && !isEditListKeyword
          && !UNDO_KEYWORDS.includes(cleanText)
          && (isCancelDraftKeyword || recordIntent !== null)
        const drafts = wantsDraftAction ? await loadDrafts() : []
        const hasDraft = drafts.length > 0

        if (hasDraft && (isCancelDraftKeyword || recordIntent === 'delete')) {
          const draft = drafts[0]
          await cancelDraft(sourceId, draft)
          const desc = draft.exp?.d ?? draft.exp?.description ?? '這筆'
          await replyMessage(replyToken, [{
            type: 'text',
            // 取消的是「還沒存入」的那張卡片。使用者若本來是想刪已存檔的支出，
            // 這句話要讓他一眼看出走錯路了，並知道正確的入口。
            text: (draft.photoIds.length > 0
              ? `🗑 已取消尚未確認的草稿：${desc}（收據照片也已刪除）`
              : `🗑 已取消尚未確認的草稿：${desc}`)
              + '\n\n（要刪除已經存入的支出，請輸入「刪除支出」。）',
            quickReply: boundQR,
          }], sourceId)
          continue
        }

        const isDeleteListIntent = isDeleteListKeyword
          || (recordIntent === 'delete' && !UNDO_KEYWORDS.includes(cleanText))
        // 有草稿時「改 500」交給 AI 去修那張草稿，不要跳到已存檔紀錄的清單
        const isEditListIntent = isEditListKeyword || (recordIntent === 'edit' && !hasDraft)

        // 列出近期支出讓使用者點選編輯。
        // 「剛剛那筆改 500」交給 AI 會變成再記一筆重複的支出 ——
        // 它只會產生新的草稿，沒有能力修改已存檔的紀錄。
        if (isEditListIntent) {
          await replyEditPicker({ tripId, sourceId, replyToken, boundQR })
          continue
        }

        // 列出近期支出讓使用者點選刪除。
        // 比「撤銷上一筆」好用：可以刪任何一筆，而不只是最後一筆。
        if (isDeleteListIntent) {
          const { data: recent } = await supabase.from('expenses')
            .select('id, description, amount, currency, date')
            .eq('trip_id', tripId)
            .is('deleted_at', null)
            .not('is_settlement', 'is', true)
            .order('date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(8)

          if (!recent || recent.length === 0) {
            await replyMessage(replyToken, [{
              type: 'text', text: '目前沒有可刪除的支出紀錄。', quickReply: boundQR,
            }], sourceId)
            continue
          }

          // 每一列：左邊是描述與金額，右邊固定一顆小按鈕。
          // 按鈕文字刻意固定為「🗑 刪除」—— 把描述放進按鈕會讓按鈕寬度爆掉。
          const rows: any[] = []
          recent.forEach((e: any, idx: number) => {
            if (idx > 0) rows.push({ type: 'separator', margin: 'md' })
            rows.push({
              type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', alignItems: 'center',
              contents: [
                {
                  type: 'box', layout: 'vertical', flex: 5, contents: [
                    { type: 'text', text: String(e.description), size: 'sm', weight: 'bold', wrap: true },
                    { type: 'text', text: `${e.date} · ${e.amount} ${e.currency}`, size: 'xxs', color: '#aaaaaa', margin: 'xs' },
                  ],
                },
                {
                  type: 'button', flex: 2, style: 'secondary', height: 'sm',
                  action: { type: 'postback', label: '🗑 刪除', data: JSON.stringify({ act: 'del', eid: e.id }) },
                },
              ],
            })
          })

          await replyMessage(replyToken, [{
            type: 'flex', altText: '選擇要刪除的支出',
            contents: {
              type: 'bubble', size: 'mega',
              body: {
                type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: '🗑 選擇要刪除的支出', weight: 'bold', size: 'md' },
                  { type: 'text', text: `最近 ${recent.length} 筆 · 刪除後 24 小時內可於網頁還原`, size: 'xxs', color: '#aaaaaa', margin: 'xs', wrap: true },
                  { type: 'separator', margin: 'lg' },
                  ...rows,
                ],
              },
            },
          }], sourceId)
          continue
        }

        // 撤銷上一筆（文字指令）
        //
        // 取最近 5 筆 saved 而不是 1 筆：連說兩次「取消上一筆」時，
        // 只看最新一筆會重複撤同一筆支出，還會把 deleted_at 刷新，
        // 讓網頁垃圾桶的 24 小時保留期整個重算（H3）。
        const isUndoText = UNDO_KEYWORDS.includes(cleanText)
        if (isUndoText) {
          const { data: savedHistory } = await supabase.from('line_chat_history')
            .select('content')
            .eq('line_user_id', sourceId)
            .eq('role', 'saved')
            .order('created_at', { ascending: false })
            .limit(5)

          const savedEntries: { expense_id: string; description?: string; by?: string }[] = []
          for (const row of savedHistory ?? []) {
            try {
              const parsed = JSON.parse(row.content)
              if (parsed?.expense_id) savedEntries.push(parsed)
            } catch { /* skip malformed */ }
          }

          if (savedEntries.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到可以撤銷的最近記錄。' }], sourceId)
            continue
          }

          // 一次查回這幾筆的狀態，挑第一筆「還沒被刪掉」的來撤
          const { data: targets } = await supabase.from('expenses')
            .select('id, description, deleted_at')
            .in('id', savedEntries.map(e => e.expense_id))
            .eq('trip_id', tripId)
          const targetById = new Map((targets ?? []).map((t: any) => [t.id, t]))
          const undoable = savedEntries.find(e => {
            const t = targetById.get(e.expense_id)
            return t && !t.deleted_at
          })

          if (!undoable) {
            await replyMessage(replyToken, [{
              type: 'text',
              text: '✅ 最近由 LINE 存入的支出都已經撤銷過了。\n\n想刪除其他筆請輸入「刪除支出」，我會列出近期紀錄讓你點選。',
              quickReply: boundQR,
            }], sourceId)
            continue
          }

          const description = targetById.get(undoable.expense_id)?.description || undoable.description || '該筆支出'
          const { error } = await supabase.from('expenses')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', undoable.expense_id)
            .eq('trip_id', tripId)
            .is('deleted_at', null)
          if (error) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 撤銷失敗，請至網頁手動刪除。' }], sourceId)
            continue
          }
          // 群組內任何人都能撤銷任何人的紀錄（刻意保留），但要講清楚撤掉的是誰記的那筆
          const originalBy = undoable.by && undoable.by !== speakerLabel ? `（原由 ${undoable.by} 記錄）` : ''
          await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${description}${originalBy}`, quickReply: boundQR }], sourceId)
          continue
        }

        // ── 快捷指令（直接查 DB，不走 AI）──
        if (cleanText === '今日支出' || cleanText === '今天支出') {
          const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates, default_currency, precision_config').eq('id', tripId).single()
          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
          const precisionConfig = (trip.precision_config ?? {}) as Record<string, number>
          const today = getTodayString(getTripTimezone(trip))
          const { data: todayExp } = await supabase.from('expenses')
            .select('description, amount, currency, category')
            .eq('trip_id', tripId).eq('date', today)
            .is('deleted_at', null).not('is_settlement', 'is', true)
            .order('created_at', { ascending: true })
          if (!todayExp || todayExp.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: `📅 今日（${today.substring(5)}）尚無支出記錄。`, quickReply: boundQR }], sourceId)
          } else {
            const lines = todayExp.map((e: any) => `• ${e.description}  ${formatAmount(e.amount, e.currency, precisionConfig)} ${e.currency}  [${e.category}]`)
            const totalStr = formatTotals(todayExp, precisionConfig)
            await replyMessage(replyToken, [{ type: 'text', text: `📅 今日支出（${today.substring(5)}）\n\n${lines.join('\n')}\n\n共 ${todayExp.length} 筆 · 合計 ${totalStr}`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '本週支出' || cleanText === '近期支出') {
          const { data: trip } = await supabase.from('trips').select('name, base_currency, rates, default_currency, precision_config').eq('id', tripId).single()
          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
          const precisionConfig = (trip.precision_config ?? {}) as Record<string, number>
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          const fromDate = new Intl.DateTimeFormat('en-CA', { timeZone: getTripTimezone(trip) }).format(sevenDaysAgo)
          const { data: weekExp } = await supabase.from('expenses')
            .select('description, amount, currency, category, date')
            .eq('trip_id', tripId).gte('date', fromDate)
            .is('deleted_at', null).not('is_settlement', 'is', true)
            .order('date', { ascending: false }).limit(30)
          if (!weekExp || weekExp.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: '📊 近 7 天內尚無支出記錄。', quickReply: boundQR }], sourceId)
          } else {
            const byDate: Record<string, any[]> = {}
            weekExp.forEach((e: any) => { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e) })
            const lines: string[] = []
            Object.entries(byDate).forEach(([date, exps]) => {
              lines.push(`📌 ${date.substring(5)}`)
              exps.forEach((e: any) => lines.push(`  • ${e.description}  ${formatAmount(e.amount, e.currency, precisionConfig)} ${e.currency}`))
            })
            await replyMessage(replyToken, [{ type: 'text', text: `📊 近 7 天支出\n\n${lines.join('\n')}\n\n共 ${weekExp.length} 筆 · 合計 ${formatTotals(weekExp, precisionConfig)}`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '本月支出') {
          const { data: trip } = await supabase.from('trips').select('name, base_currency, rates, default_currency, precision_config').eq('id', tripId).single()
          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
          const precisionConfig = (trip.precision_config ?? {}) as Record<string, number>
          const tz = getTripTimezone(trip)
          const todayStr = getTodayString(tz)
          const monthStart = todayStr.substring(0, 7) + '-01'
          const { data: monthExp } = await supabase.from('expenses')
            .select('description, amount, currency, category, date')
            .eq('trip_id', tripId).gte('date', monthStart)
            .is('deleted_at', null).not('is_settlement', 'is', true)
            .order('date', { ascending: false }).limit(50)
          if (!monthExp || monthExp.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: `📊 本月（${monthStart.substring(0, 7)}）尚無支出記錄。`, quickReply: boundQR }], sourceId)
          } else {
            const byDate: Record<string, any[]> = {}
            monthExp.forEach((e: any) => { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e) })
            const lines: string[] = []
            Object.entries(byDate).forEach(([date, exps]) => {
              lines.push(`📌 ${date.substring(5)}`)
              exps.forEach((e: any) => lines.push(`  • ${e.description}  ${formatAmount(e.amount, e.currency, precisionConfig)} ${e.currency}`))
            })
            const totalStr = formatTotals(monthExp, precisionConfig)
            let text = `📊 本月支出（${monthStart.substring(0, 7)}）\n\n${lines.join('\n')}\n\n共 ${monthExp.length} 筆 · 合計 ${totalStr}`
            if (text.length > 4900) text = text.substring(0, 4900) + '\n...(過多省略)'
            await replyMessage(replyToken, [{ type: 'text', text, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '結算') {
          const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates, precision_config').eq('id', tripId).single()
          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
          const { data: allExp } = await supabase.from('expenses')
            .select('amount, currency, payer_data, split_data')
            .eq('trip_id', tripId).is('deleted_at', null)
          const rates = trip.rates || {}
          const baseCurrency = trip.base_currency
          const grandTotal: Record<string, Decimal> = {}
          trip.members.forEach((m: string) => { grandTotal[m] = new Decimal(0) })
          // 所有紀錄（含結清）都要計入餘額，用來計算誰該給誰多少錢
          ;(allExp || []).forEach((e: any) => {
            const rate = e.currency === baseCurrency ? 1 : (rates[e.currency] || 1)
            trip.members.forEach((m: string) => {
              const net = new Decimal(e.payer_data?.[m] || 0).minus(new Decimal(e.split_data?.[m] || 0))
              grandTotal[m] = grandTotal[m].plus(net.times(rate))
            })
          })
          const grandTotalNum: Record<string, number> = {}
          Object.entries(grandTotal).forEach(([m, v]) => { grandTotalNum[m] = v.toNumber() })
          const settlements = calculateSettlements(grandTotalNum)
          if (settlements.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: '✅ 目前一切已結清，無需轉帳！', quickReply: boundQR }], sourceId)
          } else {
            // Math.round 會把 12.50 USD 顯示成 13 —— 一律依旅程的 precision_config 格式化（H5）
            const settlePrecision = (trip.precision_config ?? {}) as Record<string, number>
            const lines = settlements.map(s => `${s.from} → ${s.to}  ${formatAmount(s.amount, baseCurrency, settlePrecision)} ${baseCurrency}`)
            await replyMessage(replyToken, [{ type: 'text', text: `💰 結算試算建議（折合 ${baseCurrency}）\n\n${lines.join('\n')}\n\n🌐 詳細：${WEBAPP_URL}/#/trip/${tripId}/dashboard`, quickReply: boundQR }], sourceId)
          }
          continue
        }

        if (cleanText === '旅程總覽') {
          const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates, is_archived, precision_config').eq('id', tripId).single()
          if (!trip) {
            await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
            continue
          }
          const precisionConfig = (trip.precision_config ?? {}) as Record<string, number>
          const today = getTodayString(getTripTimezone(trip))
          const { data: allExp } = await supabase.from('expenses')
            .select('amount, currency').eq('trip_id', tripId)
            .is('deleted_at', null).not('is_settlement', 'is', true)
          const totals = sumByCurrency(allExp ?? [])
          const totalStr = Object.keys(totals).length > 0
            ? Object.entries(totals).map(([c, a]) => `  ${formatAmount(a.toNumber(), c, precisionConfig)} ${c}`).join('\n')
            : '  （尚無支出）'
          const status = trip.is_archived ? '已封存 🔒' : '進行中 ✈️'
          await replyMessage(replyToken, [{ type: 'text', text: `🗺️ ${trip.name}（${status}）\n\n👥 成員：${trip.members.join('、')}\n📅 今日：${today}\n💵 主幣別：${trip.base_currency}\n\n📊 支出總計：\n${totalStr}\n\n🌐 ${WEBAPP_URL}/#/trip/${tripId}/dashboard`, quickReply: boundQR }], sourceId)
          continue
        }

        const [{ data: trip }, { data: expenses }, { data: history }, { data: allForSummary }] = await Promise.all([
          supabase.from('trips').select('*').eq('id', tripId).single(),
          supabase.from('expenses')
            // id 是給 analyze_photo 的歷史標記用的（`[收據分析 #xxxxxxxx]`）
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
          // 全趟支出，只為了算彙總（M6）。刻意不設 limit：
          // 「這趟總共花多少」若只看得到一部分，答出來的數字是錯的，比不答更糟。
          // 結清紀錄也要撈進來 —— summarizeTripExpenses 會自己決定哪些數字該含它。
          supabase.from('expenses')
            .select('amount, currency, category, date, is_settlement, payer_data, split_data')
            .eq('trip_id', tripId)
            .is('deleted_at', null),
        ])
        // 旅程可能已被後台刪除（見 docs/DB_MAINTENANCE.md）。
        // 以前這裡直接讀 trip.name，整個 event 丟出例外 → 500 → LINE 會重送同一則訊息（M5）。
        if (!trip) {
          await replyMessage(replyToken, [{
            type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。',
          }], sourceId)
          continue
        }

        // 不阻塞主流程，但交給 waitUntil 保證回應送出後仍寫得完
        runInBackground(supabase.from('line_chat_history').insert({
          line_user_id: sourceId, role: 'user', content: cleanText,
          speaker_user_id: speakerUserId, speaker_name: speakerLabel,
        }))

        // 舊紀錄的清理已改由資料庫的 pg_cron 排程負責（每天一次，見
        // supabase/migrations/20260903_cron_purge_line_history.sql）。
        // 原本是在這裡以約 10% 機率順手清一次，但沒人講話就不會清，
        // 而且會在使用者等回覆的時候多做兩次 DELETE。

        const today = getTodayString(getTripTimezone(trip))

        // 有編號、沒有網址。編號是 analyze_photo 唯一要 AI 回的東西 ——
        // 網址長又相似，小模型抄不準，還白白吃掉一堆 token（T4）。
        const contextPrecision = (trip.precision_config ?? {}) as Record<string, number>
        // 全趟的精確彙總。AI 只看得到最近 10 筆，自由查詢（K8–K13）過去一律答錯（M6）。
        const tripSummary = summarizeTripExpenses(allForSummary ?? [], trip.members ?? [], contextPrecision)
        const expensesSummary = (expenses ?? []).map((e: any, idx: number) => {
          const photo = e.photo_urls?.length > 0 ? ` 📷×${e.photo_urls.length}` : ''
          return `#${idx + 1} ${e.date} ${e.description} ${formatAmount(e.amount, e.currency, contextPrecision)} ${e.currency} [${e.category}]${photo}`
        }).join('\n')

        // 還等在聊天室裡、使用者既沒確認也沒取消的草稿。
        // 一定要把 nonce 一起給 AI：使用者說「剛剛那筆改 500」時，
        // 只有 AI 講得出「我在修哪一張」，路由層才知道該讓哪一張卡片失效（H1）。
        const outstandingDrafts = await loadDrafts()
        const draftSummary = outstandingDrafts.map((d) => {
          const e = d.exp ?? {}
          const payers = Object.keys(e.p ?? {}).join('、') || '未指定'
          const splits = Object.keys(e.s ?? {}).join('、') || '未指定'
          const photo = d.photoIds.length > 0 ? '（附收據照片）' : ''
          return `- nonce=${d.nonce}：${e.d ?? ''} ${e.a ?? ''} ${e.c ?? ''}${photo}（付款：${payers}；分攤：${splits}）`
        }).join('\n')

        // 只放「這次對話的當下狀態」。人設與不可變規則已在 YOSHI_SYSTEM_INSTRUCTION，
        // 輸出格式則交給 TEXT_RESPONSE_SCHEMA，不必再用文字描述一次。
        const tripContext = `【旅程】${trip.name}｜成員：${trip.members.join('、')}｜分類：${trip.categories.join('、')}（預設：${trip.default_category || '無'}）
【幣別】記帳預設：${trip.default_currency || trip.base_currency}（使用者沒明講就填這個）｜結算主幣：${trip.base_currency}（只用於統計，不要拿來當記帳幣別）｜可用：${Object.keys(trip.rates ?? {}).join('、') || '（尚未設定）'}
【今日】${today}｜${trip.is_archived ? '⚠️ 已封存（唯讀，禁止記帳）' : '進行中'}
【記帳偏好（整趟旅程共用）】${trip.ai_preference || '無'}｜傳訊者：${memberName}
【旅程預設付款人】${trip.default_payer?.length ? trip.default_payer.join('、') : '無'}｜預設分攤：${trip.default_split_members?.length ? trip.default_split_members.join('、') : '全員'}

【判斷優先權】
- payer_data（墊付）：①旅程預設付款人 ②記帳偏好 ③傳訊者對應的成員 ④成員第一位
- split_details（分攤）：①旅程預設分攤 ②記帳偏好 ③全員均分
- 幣別：使用者明講（currency_source: stated）> 記帳偏好（preference）> 都沒有就填 none，
  currency 一律用上面的「記帳預設」；系統會再驗一次，說謊沒有好處
${memberAliasHint(trip.members)}
【全趟彙總】（伺服器用 Decimal 算好的精確數字）
⚠️ 回答金額類問題（總共花多少、誰付最多、我還欠多少、某分類多少）時**一律引用這裡的數字**，
   絕對不要自己去加總下面那 10 筆 —— 那只是最近的一部分，加起來一定是錯的。
${tripSummary}

【近期支出（最近10筆，只用來指稱「剛剛那筆」與查明細，不要拿來算總額）】
${expensesSummary || '（尚無支出）'}

【尚未確認的草稿】（使用者可能想修正其中一張；修正時 corrects_draft 填它的 nonce）
${draftSummary || '（沒有等待確認的草稿）'}

【回應方式】
- 想記一筆新支出 → type: expense，corrects_draft 留空字串
- 想修正上面某一張「尚未確認的草稿」→ type: expense，帶上**完整**的修正後內容，
  並把 corrects_draft 填成那張草稿的 nonce（沒指名的話系統只會多出一張卡片，舊的不會消失）
- 詢問某筆有收據照片的支出細節（品項明細、外文翻譯等）→ type: analyze_photo，
  expense_ref 填上面那筆的編號（例如 "#3"，只有標了 📷 的才有照片可分析；
  不在清單裡就填空字串，系統會自動全庫搜尋），question 填使用者的問題
- 其他聊天或查詢 → type: chat`

        // 反轉回時間順序，並丟掉結尾沒有得到回覆的 user 訊息。
        // 留著的話，合併同角色輪次時它會跟「當下這句話」黏成同一輪，
        // 模型就分不清該回應哪一句了。
        const orderedHistory = [...(history ?? [])].reverse()
        while (orderedHistory.length > 0 && orderedHistory[orderedHistory.length - 1].role === 'user') {
          orderedHistory.pop()
        }

        // 真正的多輪對話。以前是把歷史壓成 "U: ... / Y: ..." 塞進單一 prompt，
        // 模型較難分辨哪些是自己說過的話。
        const rawConversation: any[] = [
          { role: 'user', parts: [{ text: tripContext }] },
          { role: 'model', parts: [{ text: '{"type":"chat","content":"了解，我已掌握這趟旅程的設定。"}' }] },
          // 查詢是新到舊，這裡反轉回舊到新才符合對話順序
          ...orderedHistory.map((h: any) => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: summarizeHistoryEntry(h.role, h.content, h.speaker_name) }],
          })),
          { role: 'user', parts: [{ text: cleanText }] },
        ]

        // Gemini 的 contents 預期 user / model 交替。歷史裡可能出現連續兩則 model
        // （例如拍照產生的草稿沒有對應的使用者文字），先合併起來避免格式異常。
        const conversation = rawConversation.reduce((acc: any[], turn: any) => {
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
            lastTurn.parts.unshift({
              text: `【尚未確認的收據草稿 nonce=${photoDraft.nonce}】${d.d ?? ''} ${d.a ?? ''} ${d.c ?? ''}\n`
                + `目前分攤：${JSON.stringify(d.s ?? {})}\n`
                + `下面附上那張收據。若使用者這句話是在調整這筆的金額或分攤，`
                + `請重新閱讀收據上的各品項，依照他說的分配方式重算 payer_data 與 split_details，`
                + `回傳 type: expense（description、amount、currency、date 沿用上面的草稿，除非使用者另有指示），`
                + `並把 corrects_draft 填成 ${photoDraft.nonce}。\n`
                + `⚠️ 若他講的是**另一筆與這張收據無關的支出**（例如「計程車 200」），`
                + `corrects_draft 請留空字串 —— 系統會據此決定新卡片要不要沿用這張收據。\n`
                + `若只是閒聊或詢問，照常回 chat。`,
            })
            lastTurn.parts.push(part)
            attachedPhoto = true
          }
        }

        try {
          const aiResponse = await askGemini(conversation, {
            systemInstruction: YOSHI_SYSTEM_INSTRUCTION,
            responseSchema: TEXT_RESPONSE_SCHEMA,
            temperature: 0.4,
            // 有附收據時改用視覺模型清單
            models: attachedPhoto ? GEMINI_OCR_MODELS : GEMINI_FALLBACK_MODELS,
          })
          const res = JSON.parse(extractJSON(aiResponse))
          if (res.type === 'expense') {
            const expense = res.data

            // 第二道防線（T1）：使用者說的是「改」，現場卻沒有任何可以修的草稿，
            // AI 也沒指名 corrects_draft —— 那它是把「剛剛那個改250」誤當成新支出了，
            // 照著出卡片會憑空多記一筆。改列已存檔紀錄的編輯清單。
            // 第一道防線是 detectRecordIntent（路由層，訊息還沒進 AI 就攔下）。
            if (
              outstandingDrafts.length === 0
              && !String(res.corrects_draft ?? '').trim()
              && mentionsEditingExisting(cleanText)
            ) {
              console.log(`[GUARD] AI returned expense for an edit-sounding message with no draft: "${cleanText}"`)
              await replyEditPicker({
                tripId, sourceId, replyToken, boundQR,
                notice: '看起來你想改已經存入的紀錄。如果其實是要新記一筆，請不要用「改」來描述。',
              })
              continue
            }

            normalizeExpenseAmountMaps(expense)

            // 同上：先試著把暱稱對應回正式名稱
            const { unresolved: unknownMembers } = resolveExpenseMembers(expense, trip.members)
            if (unknownMembers.length > 0) {
              console.warn(`[TEXT] Unknown members detected: ${unknownMembers.join(', ')}`)
              await replyMessage(replyToken, [{
                type: 'text',
                text: `😅 我從您的描述中辨識到不存在的成員：${unknownMembers.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n可能是名字打錯或漏字了，請改用正確的成員名稱再說一次。`,
                quickReply: boundQR
              }], sourceId)
              continue
            }

            // 幣別與日期的把關，與 OCR 路徑相同。
            // 幣別先走規則（T3）：小模型常把 context 裡的「結算主幣」當成該填的值，
            // 「夾娃娃300」在主幣 TWD／預設 JPY 的旅程就會出 TWD 的卡片。
            // 這裡不信 AI 的判斷 —— stated 還要文字裡真的有幣別字眼才算數。
            const textRule = resolveCurrencyByRule(expense.currency, expense.currency_source, cleanText, trip)
            if (textRule.overrode) {
              console.log(`[CURRENCY] AI said ${expense.currency} (source=${expense.currency_source}) but "${cleanText}" has no currency hint, using ${textRule.currency}`)
            }
            expense.currency = textRule.currency
            const textCurrency = normalizeCurrency(expense.currency, trip)
            if (textCurrency.reject) {
              await replyMessage(replyToken, [{
                type: 'text', text: textCurrency.reject, quickReply: boundQR,
              }], sourceId)
              continue
            }
            expense.currency = textCurrency.currency
            const textDate = normalizeDate(expense.date, today)
            expense.date = textDate.date
            // 分類的把關，與 OCR 路徑相同（M18）
            const textCategory = resolveCategory(expense.category, trip.categories, trip.default_category)
            expense.category = textCategory.category
            const textWarnings = [textCurrency.warning, textCategory.warning, textDate.warning].filter(Boolean) as string[]

            // AI 偶爾會回空的付款人或分攤，補上與網頁快速記帳一致的預設值（H6）
            // 補上的預設值只是 0 佔位：分配時必須改傳 {} 當 lockedData，
            // 否則 0 會被 calculateDistribution 當成「鎖定金額」，整筆餘額落到調整成員身上。
            const { filledPayer, filledSplit } = applyParticipantDefaults(expense, trip, memberName)

            const precision = (trip.precision_config as any)?.[expense.currency] ?? DEFAULT_PRECISION[expense.currency] ?? 2
            expense.amount = new Decimal(expense.amount || 0).toDecimalPlaces(precision).toNumber()
            const payerMembers = Object.keys(expense.payer_data)
            const splitMembers = Object.keys(expense.split_details)
            const adjustMember = payerMembers.find(m => splitMembers.includes(m)) ?? splitMembers[0]
            if (payerMembers.length > 0) {
              expense.payer_data = calculateDistribution(expense.amount, payerMembers, filledPayer ? {} : expense.payer_data, payerMembers[0], precision)
            }
            if (splitMembers.length > 0) {
              expense.split_details = calculateDistribution(expense.amount, splitMembers, filledSplit ? {} : expense.split_details, adjustMember, precision)
            }

            // AI 指名要修正哪一張草稿？只有對得上的 nonce 才算數。
            const correctsNonce = String(res.corrects_draft ?? '').trim()
            const correctedDraft = correctsNonce
              ? outstandingDrafts.find(d => d.nonce === correctsNonce) ?? null
              : null

            const exp_short = {
              d: expense.description, a: expense.amount, c: expense.currency,
              dt: expense.date, cat: expense.category, p: expense.payer_data, s: expense.split_details
            }
            const nonce = Math.random().toString(36).substring(2, 10)
            // 收據只在「確實是在修正那張收據草稿」時才沿用。
            // 以前只要聊天室裡有收據草稿，接下來的任何一張新卡片都會被貼上
            // 那張收據的縮圖與 photo_urls —— 傳完收據再打「計程車 200」，
            // 計程車那筆就會掛著別人的發票（H1）。
            const photo_ids = correctedDraft && correctedDraft.photoIds.length > 0
              ? correctedDraft.photoIds
              : (expense.photo_ids || [])

            // 摘要要帶 nonce，AI 下一輪才有辦法指名它要修正哪一張
            const historySummary = `[記帳建議] ${JSON.stringify({ ...expense, nonce }, null, 2)}`
            runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: historySummary }))

            // 沿用收據草稿時才有縮圖
            const heroUrl = photo_ids.length > 0 ? photoPublicUrl(photo_ids[0], trip.id) : null

            const webUrl = `${WEBAPP_URL}/#/trip/${trip.id}/dashboard`
            // 草稿卡片的「✏️ 編輯」只帶 nonce，完整內容 LiffEdit 自己去 pending 列撈（T2）
            const liffUrl = buildDraftLiffUrl(trip.id, nonce, sourceId)

            // 幣別或日期被修正過就一併告知，不要默默改掉使用者看不到的東西
            const textWarningMsg = textWarnings.length > 0
              ? [{ type: 'text' as const, text: textWarnings.join('\n') }]
              : []

            // 修正草稿時會送出新卡片，被修正的那一張必須先失效，
            // 否則按舊的「確認存入」會寫進未修正的金額。
            // ⚠️ 只失效被指名的那一張 —— 連續記多筆、群組裡多人同時記帳時，
            //    其他人的卡片必須留著（H1）。
            if (correctedDraft) await supersedeDraft(sourceId, correctedDraft.nonce)

            // storePendingExpense 與 replyMessage 並行執行，縮短回覆延遲
            await Promise.all([
              storePendingExpense(sourceId, nonce, { exp: exp_short, p: photo_ids, tid: tripId }),
              replyMessage(replyToken, [...textWarningMsg, buildExpenseCard({
                expense,
                title: "🤖 AI 記帳預覽",
                altText: `確認記帳: ${expense.description}`,
                heroUrl,
                nonce, webUrl, liffUrl,
              })], sourceId),
            ])
          } else if (res.type === 'analyze_photo') {
            const question = res.question || '請詳細描述此收據的所有品項與金額'

            // AI 只回編號，照片由程式自己找（T4）。
            // 以前是把完整網址塞進 context 要它逐字抄回來 —— 網址長又只差幾個字元，
            // 小模型常抄錯，或抄成上一輪對話裡出現過的另一張，
            // 使用者問「剛剛 Lawson 那筆」，回的卻是別筆收據的內容。
            const label = (e: any) =>
              `${e.description} ${formatAmount(e.amount, e.currency, contextPrecision)} ${e.currency}`

            /** 把選定的那一筆的**所有**收據照片一起送去分析並回覆 */
            const analyzeChosen = async (chosen: any) => {
              const urls: string[] = (chosen.photo_urls ?? []).map((path: string) => photoPublicUrl(path, tripId))
              const content = await analyzeReceiptPhoto(urls, question, label(chosen))
              // 開頭標明分析的是哪一筆，使用者才看得出有沒有挑錯
              const answer = `🔍 ${chosen.date} ${label(chosen)}\n\n${content}`
              // 歷史加上支出標記，下一輪追問（「那第二項是什麼」）才有指代對象
              runInBackground(supabase.from('line_chat_history').insert({
                line_user_id: sourceId, role: 'model',
                content: `[收據分析 #${String(chosen.id ?? '').substring(0, 8)}] ${content}`,
              }))
              await pushMessage(sourceId, [{ type: 'text', text: answer.substring(0, 4900), quickReply: boundQR }])
            }

            // ① 先用編號在剛剛查出的近期 10 筆裡找（同一次查詢的結果，不重查）
            const refPick = pickExpenseByRef(res.expense_ref, expenses ?? [])
            const recentPick = refPick && (refPick as any).photo_urls?.length > 0 ? refPick : null

            if (recentPick) {
              await replyMessage(replyToken, [{ type: 'text', text: '🔍 正在重新分析收據照片，請稍候...' }], sourceId)
              try {
                await analyzeChosen(recentPick)
              } catch (photoErr) {
                console.error('[ANALYZE_PHOTO_ERROR]', photoErr)
                await pushMessage(sourceId, [{ type: 'text', text: '😵 無法重新分析照片，請稍後再試。', quickReply: boundQR }])
              }
            } else {
              // ② 不在近期 10 筆裡 → 全庫找有照片的支出
              await replyMessage(replyToken, [{ type: 'text', text: '🔍 正在查詢符合描述的支出紀錄...' }], sourceId)
              try {
                const { data: allExpenses } = await supabase.from('expenses')
                  .select('id, description, amount, currency, category, date, photo_urls')
                  .eq('trip_id', tripId)
                  .is('deleted_at', null)
                  .not('is_settlement', 'is', true)
                  .order('date', { ascending: false })

                const withPhotos = (allExpenses ?? []).filter((e: any) => e.photo_urls?.length > 0)

                if (withPhotos.length === 0) {
                  await pushMessage(sourceId, [{ type: 'text', text: '😅 此旅程中找不到任何帶有收據照片的支出紀錄。', quickReply: boundQR }])
                  continue
                }

                // 先在程式端縮小範圍：店名多半原封不動出現在問句裡。
                // 命中唯一一筆就不必再叫一次模型（省一次呼叫，也少一次挑錯的機會）。
                // 連原句一起比對：AI 轉述的 question 可能把店名丟掉（「詳細是買了什麼」）
                const narrowed = matchExpensesByQuestion(`${cleanText} ${question}`, withPhotos)
                let chosen: any = narrowed.length === 1 ? narrowed[0] : null

                if (!chosen) {
                  const pool = narrowed.length > 1 ? narrowed : withPhotos
                  const expenseList = pool.map((e: any, idx: number) =>
                    `#${idx + 1} ${e.date} ${e.description} ${formatAmount(e.amount, e.currency, contextPrecision)} ${e.currency} [${e.category}] 📷×${e.photo_urls.length}`
                  ).join('\n')

                  // 這裡同樣只要編號，不要網址
                  const selectPrompt = `以下是這趟旅程中附有收據照片的支出記錄：
${expenseList}

使用者問題：${question}

請找出最符合使用者描述的那一筆，回傳 JSON：
若找到 → {"found": true, "ref": "#編號"}
若找不到 → {"found": false}
使用者說「剛剛」「最新」又沒指名店名時，選日期最近的那一筆。`

                  const selectText = await askGemini([{ role: "user", parts: [{ text: selectPrompt }] }])
                  const selectRes = JSON.parse(extractJSON(selectText))
                  chosen = selectRes.found ? pickExpenseByRef(selectRes.ref, pool) : null
                }

                if (!chosen) {
                  await pushMessage(sourceId, [{ type: 'text', text: '😅 找不到符合描述的收據照片，請試著描述得更詳細一點，例如加上日期、店名或金額。', quickReply: boundQR }])
                } else {
                  await pushMessage(sourceId, [{ type: 'text', text: `✅ 找到了！正在分析「${chosen.description}」的收據照片...` }])
                  try {
                    await analyzeChosen(chosen)
                  } catch (analyzeErr) {
                    console.error('[ANALYZE_PHOTO_AFTER_SEARCH_ERROR]', analyzeErr)
                    await pushMessage(sourceId, [{ type: 'text', text: '😵 照片分析失敗，請稍後再試。', quickReply: boundQR }])
                  }
                }
              } catch (searchErr) {
                console.error('[SEARCH_PHOTO_ERROR]', searchErr)
                await pushMessage(sourceId, [{ type: 'text', text: '😵 查詢過程發生錯誤，請稍後再試。', quickReply: boundQR }])
              }
            }
          } else {
            let safeContent = res.content || ""

            // 最後一道防線：AI 沒有刪除或修改既有支出的能力，
            // 但它有時會回「已經幫您刪除了」。使用者信了就以為帳已經改掉，
            // 這種假訊息比直說做不到還糟，所以在送出前換掉。
            if (claimsCompletedAction(safeContent)) {
              console.warn('[GUARD] Blocked a false completion claim:', safeContent.substring(0, 120))
              safeContent = '我沒辦法直接刪除或修改已經存檔的支出 🙇\n\n'
                + '請輸入「刪除支出」或「編輯支出」，我會列出近期紀錄讓你點選。'
            }

            if (safeContent.length > 4900) safeContent = safeContent.substring(0, 4900) + "\n\n...(內容過長已截斷)"
            if (!safeContent) safeContent = 'Yoshi! 🥚 有什麼需要幫忙的嗎？'
            runInBackground(supabase.from('line_chat_history').insert({ line_user_id: sourceId, role: 'model', content: safeContent }))
            await replyMessage(replyToken, [{ type: 'text', text: safeContent, quickReply: boundQR }], sourceId)
          }
        } catch (e) {
          console.error('[AI_ERROR]', e)
          const msg = isRateLimit(e) ? RATE_LIMIT_MSG : '😵 AI 處理時發生錯誤，請稍後再試。'
          await replyMessage(replyToken, [{ type: 'text', text: msg }], sourceId)
        }
        continue
      }

      // 7. 其他，尚未綁定狀態下的聊天
      await replyMessage(replyToken, [{ type: 'text', text: '👋 請先輸入 ID:代碼 來連結旅程。', quickReply: getQuickReply(false) }], sourceId)
    }
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[GLOBAL_ERROR]', err)
    return new Response('Error', { status: 500 })
  }
})
