// ============================================================
// messages.ts —— 送出去的東西長什麼樣子
//
// 快速回覆按鈕、Flex 卡片、LIFF 網址、自我介紹全文與各種文案。
// replyEditPicker 需要查近期支出才排得出清單，所以這裡也用得到 db.ts。
//
// import config.ts、db.ts、line-api.ts 與 _shared/finance.ts。
// ============================================================

import { WEBAPP_URL } from "./config.ts"
import { supabase } from "./db.ts"
import { replyMessage } from "./line-api.ts"
import { formatAmount, sumByCurrency } from "../_shared/finance.ts"
import type { ExpenseRow } from "../_shared/types.ts"
import type { ExpenseCardData, OutgoingMessage, QuickReply } from "./types.ts"

/** replyEditPicker 那份清單每一列讀得到的欄位 */
type PickerRow = Pick<ExpenseRow, "id" | "description" | "amount" | "currency" | "date">

/** 編輯「旅程 AI 記帳偏好」的 LIFF 頁網址（Feature F） */
export function preferenceLiffUrl(tripId: string): string {
  return `${WEBAPP_URL}/#/liff/preference?tripId=${tripId}`
}

/**
 * 「設定?」「設定:」的回覆用：把「記帳偏好」按鈕排到第一顆。
 * 一般的 boundQR 也有這顆，但排在最後 —— 使用者正在講偏好，那顆該最顯眼。
 */
export function preferenceQuickReply(tripId: string, showGroupToggle: boolean, mentionRequired: boolean) {
  // 不傳 tripId 給 getQuickReply，避免同一顆按鈕出現兩次
  const base = getQuickReply(true, showGroupToggle, mentionRequired)
  return { items: [preferenceQuickReplyItem(tripId), ...base.items] }
}

export function preferenceQuickReplyItem(tripId: string) {
  return {
    type: "action",
    action: { type: "uri", label: "⚙️ 記帳偏好", uri: preferenceLiffUrl(tripId) },
  }
}

export function getQuickReply(
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
  const items: QuickReply['items'] = [
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
export function buildEditLiffUrl(expense: { id: string }, tripId: string, sourceId: string): string {
  return `${WEBAPP_URL}/#/liff/edit?tripId=${tripId}&id=${expense.id}&u=${encodeURIComponent(sourceId)}`
}

/**
 * 產生「編輯尚未確認的草稿」的 LIFF 網址。
 * 同樣只帶 nonce —— 完整內容已經存在 line_chat_history 的 pending 列，
 * LiffEdit 自己去撈（順便就能發現這張卡片已經被確認或取消過了）。
 */
export function buildDraftLiffUrl(tripId: string, nonce: string, sourceId: string): string {
  return `${WEBAPP_URL}/#/liff/edit?tripId=${tripId}&n=${nonce}&u=${encodeURIComponent(sourceId)}`
}

/**
 * 列出近期支出讓使用者點選編輯（每列一顆 LIFF「✏️ 編輯」）。
 *
 * 兩個呼叫端：明確打「編輯支出」，以及 P8 的防線 —— 模型把「剛剛那個改250」
 * 當成新支出時（T1），用 `notice` 補一句話說明為什麼看到的是清單而不是卡片。
 * 用自然語言講的修改現在會走到 AI 的「✏️ 修改預覽」卡，不再落到這裡。
 *
 * 清單本身依日期與建立時間倒序，剛存的那一筆一定在第一列，
 * 所以不需要另外做「直接開最新一筆」。
 */
export async function replyEditPicker(opts: {
  tripId: string
  sourceId: string
  replyToken: string
  boundQR: QuickReply
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

  const rows: OutgoingMessage[] = []
  recent.forEach((e: PickerRow, idx: number) => {
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
export function buildExpenseCard(opts: {
  expense: ExpenseCardData
  title: string
  altText: string
  heroUrl?: string | null
  nonce: string
  webUrl: string
  liffUrl: string
}): OutgoingMessage {
  const { expense, title, altText, heroUrl, nonce, webUrl, liffUrl } = opts
  const amountRows = (data: Record<string, unknown> | undefined) =>
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

/**
 * 一次修改動了哪些欄位，翻成使用者看得懂的字。
 *
 * key 用資料庫的欄位名（`prepareExpenseUpdate` 的 `changes` 就是那組），
 * 認不得的欄位原樣顯示 —— 寧可露出英文欄位名，也不要默默漏掉一項異動。
 */
export const FIELD_LABELS: Record<string, string> = {
  description: '描述',
  amount: '金額',
  currency: '幣別',
  date: '日期',
  category: '分類',
  payer_data: '付款人',
  split_data: '分攤',
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

/** 把 changes 裡的 before／after 印成一行。金額 map 印成「小明 300、阿華 200」。 */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）'
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '（空）'
    return entries.map(([name, amount]) => `${name} ${amount}`).join('、')
  }
  return String(value)
}

/**
 * 「✏️ 修改預覽」卡片（AI 提議修改既有支出時送出）。
 *
 * ⚠️ 這張卡與記帳草稿卡是**不同的東西**：它指向一筆已經存檔的支出，
 *    按下確認走的是 `act: 'upd'`（UPDATE），不是 `act: 'save'`（INSERT）。
 *    pending 列因此帶 `kind: 'update'` 與 `eid`，也不會被當成草稿（見 drafts.ts）。
 *
 * 「🌐 網頁編輯」開的是**修改前**的原內容 —— LIFF 頁每次都直接查資料庫（T2），
 * 沒有辦法預先填入這裡提議的值。卡上有一行小字說明，免得使用者以為壞掉了。
 */
export function buildUpdatePreviewCard(opts: {
  /** amount 傳「已經照旅程精度格式化好」的字串，卡片不再自己算 */
  existing: { id: string; description: string; date: string; amount: string; currency: string }
  changes: { field: string; before: unknown; after: unknown }[]
  nonce: string
  editUrl: string
}): OutgoingMessage {
  const { existing, changes, nonce, editUrl } = opts
  const changeRows = changes.map((c) => ({
    type: 'box', layout: 'vertical', margin: 'md',
    contents: [
      { type: 'text', text: fieldLabel(c.field), size: 'xs', color: '#aaaaaa' },
      {
        type: 'text',
        text: `${formatFieldValue(c.before)} → ${formatFieldValue(c.after)}`,
        size: 'sm', wrap: true,
      },
    ],
  }))

  return {
    type: 'flex', altText: `確認修改: ${existing.description}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '✏️ 修改預覽', weight: 'bold', color: '#E08A00', size: 'sm' },
          { type: 'text', text: String(existing.description), weight: 'bold', size: 'xl', margin: 'md', wrap: true },
          {
            type: 'text',
            text: `📅 ${existing.date} · 原本 ${existing.amount} ${existing.currency}`,
            size: 'xs', color: '#aaaaaa', margin: 'xs', wrap: true,
          },
          { type: 'separator', margin: 'md' },
          ...changeRows,
          { type: 'separator', margin: 'lg' },
          {
            type: 'text',
            text: '按「確認修改」才會真的改到帳本；「網頁編輯」開的是修改前的原內容。',
            size: 'xxs', color: '#aaaaaa', margin: 'md', wrap: true,
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#E08A00', action: { type: 'postback', label: '✅ 確認修改', data: JSON.stringify({ act: 'upd', n: nonce }) } },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              { type: 'button', style: 'primary', color: '#5AC8FA', action: { type: 'uri', label: '🌐 網頁編輯', uri: editUrl } },
              { type: 'button', style: 'secondary', action: { type: 'postback', label: '❌ 取消', data: JSON.stringify({ act: 'cancel', n: nonce }) } },
            ],
          },
        ],
      },
    },
  }
}

/**
 * 「🗑 確認刪除？」卡片（AI 提議刪除既有支出時送出）。
 *
 * 按鈕帶 `eid` 與 `n`：`eid` 是要刪的那一筆，`n` 是防連點的鎖。
 * 「刪除支出」清單上的舊按鈕只有 `eid`，那條路徑照舊（見 handlers/postback.ts）。
 */
export function buildDeleteConfirmCard(opts: {
  /** amount 傳「已經照旅程精度格式化好」的字串 */
  existing: { id: string; description: string; date: string; amount: string; currency: string; category: string }
  nonce: string
}): OutgoingMessage {
  const { existing, nonce } = opts
  return {
    type: 'flex', altText: `確認刪除: ${existing.description}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '🗑 確認刪除？', weight: 'bold', color: '#D9534F', size: 'sm' },
          { type: 'text', text: String(existing.description), weight: 'bold', size: 'xl', margin: 'md', wrap: true },
          { type: 'text', text: `📅 ${existing.date} · 🏷️ ${existing.category}`, size: 'xs', color: '#aaaaaa', margin: 'xs' },
          { type: 'separator', margin: 'md' },
          {
            type: 'box', layout: 'horizontal', margin: 'md', contents: [
              { type: 'text', text: '總金額', color: '#aaaaaa', size: 'sm' },
              { type: 'text', text: `${existing.amount} ${existing.currency}`, align: 'end', size: 'sm', weight: 'bold' },
            ],
          },
          {
            type: 'text',
            text: '刪除後 24 小時內可到網頁的垃圾桶還原。',
            size: 'xxs', color: '#aaaaaa', margin: 'lg', wrap: true,
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#D9534F', action: { type: 'postback', label: '🗑 確認刪除', data: JSON.stringify({ act: 'del', eid: existing.id, n: nonce }) } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '❌ 取消', data: JSON.stringify({ act: 'cancel', n: nonce }) } },
        ],
      },
    },
  }
}

/**
 * 舊卡片被按下時要說清楚「為什麼按不動」。
 *
 * 以前一律回「此操作已處理過囉」，使用者看到的是一張自己從沒按過的卡片
 * 卻說已經處理過 —— 那其實是被更新的記帳建議取代了（H1、H12）。
 */
export function describeProcessedAction(actionType: string | null | undefined): string {
  switch (actionType) {
    case 'save':
      return '⚠️ 此筆支出已於先前成功存入！'
    case 'cancel':
      return '⚠️ 這張卡片先前已經取消了。'
    case 'update':
      return '⚠️ 這筆修改先前已套用。'
    case 'delete':
      return '⚠️ 這筆支出先前已經刪除了。'
    case 'superseded':
      return '⚠️ 這張卡片已被較新的記帳建議取代，請改按新的那一張卡片。'
    default:
      return '⚠️ 此操作已處理過囉！'
  }
}

export const BOT_SELF_INTRODUCTION = `您好！我是您的旅遊記帳小幫手「耀西」
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

/**
 * 快捷查詢的「各幣別合計」字串。
 *
 * 一律走 Decimal（sumByCurrency）再依 precision_config 格式化 ——
 * 原本用原生 `+=` 累加，USD 旅程的合計會出現 0.30000000000000004（H5）。
 */
export function formatTotals(
  rows: { amount: number; currency: string }[],
  precisionConfig: Record<string, number>,
): string {
  return Object.entries(sumByCurrency(rows))
    .map(([currency, total]) => `${formatAmount(total.toNumber(), currency, precisionConfig)} ${currency}`)
    .join('・')
}

export function buildBindSuccessText(tripName: string, members: string[], tripId: string): string {
  return `✅ 綁定成功：\n${tripName}\n\n目前成員：\n${(members || []).join('、')}\n\n旅程網頁：\n${WEBAPP_URL}/#/trip/${tripId}/dashboard\n\n現在您可以直接「打字或上傳收據」請我記帳；想調整分帳習慣，按下方「⚙️ 記帳偏好」或輸入「設定: 預設付款人是我，大家平分」囉！`
}
