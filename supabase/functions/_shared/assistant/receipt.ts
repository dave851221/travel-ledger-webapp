// ============================================================
// _shared/assistant/receipt.ts —— 收據照片的 OCR（LINE、網頁共用）
//
// 照片怎麼來（LINE CDN、網頁上傳到 Storage）與怎麼回覆（Flex 卡片、網頁卡片）是管道的事；
// 「怎麼問模型、怎麼驗證它回的東西」只有這一份：
//   prompt → ai.generate（JSON mode + OCR_RESPONSE_SCHEMA）→ 三種照片 → prepareExpense → 品項明細。
//
// 照片分三種（OCR_RESPONSE_SCHEMA 的 type）：
//   expense     收據、付款畫面 → 照常辨識金額
//   item_photo  不是收據但拍的是可以記帳的東西 → 金額填 0（needsAmount），使用者自己補
//   not_receipt 認不出來 → 照片留著，出一張描述與金額都空白的卡（unidentified）。
//               AI 回了壞掉的格式、或根本沒回應（額度、忙碌、逾時）時也一樣。
// ============================================================

import { reconcileReceiptItems, type ReceiptItem, sanitizeReceiptItems } from "../itemSplit.ts"
import { prepareExpense } from "../tools/expenses.ts"
import type { ExpenseInput, PreparedExpense } from "../tools/types.ts"
import type { TripRow } from "../types.ts"
import { extractJSON } from "../validate.ts"
import type { AiProvider } from "../ai/types.ts"
import { OCR_RESPONSE_SCHEMA } from "./ai.ts"
import { aiUnavailableMessage, FALLBACK_NOTICES } from "./notices.ts"
import type { OcrResponse } from "./types.ts"

export interface OcrPromptInput {
  trip: TripRow
  /** 傳照片的人（LINE 名稱、網頁選的「我是誰」） */
  memberName: string
  today: string
  /** 這趟旅程的網頁網址（給模型當背景，不會出現在回覆裡） */
  tripUrl: string
}

/** 收據 OCR 的 prompt。LINE 與網頁一字不差 */
export function buildOcrPrompt({ trip, memberName, today, tripUrl }: OcrPromptInput): string {
  return `
### 你的身份
你是一位專業又貼心的旅遊記帳小幫手「耀西」，是瑪利歐系列的一位知名角色。
在遊戲中的叫聲通常是高亢、可愛的「Yoshi! Yoshi!」或「嗯——嗯！」，與使用者聊天時，偶爾可以適當穿插這樣的叫聲。

### 你的任務
這是一張消費收據或發票的照片。請扮演專業的記帳小幫手並進行解析。

### 背景資訊
- 旅程：${trip.name} (網址: ${tripUrl})
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
     0. **照片上看得到是誰付的錢**，而且對得上成員清單裡的某一位 → 就是那位成員，優先於下面所有規則。
        例如訂位／訂單確認信的「親愛的吳艷櫻先生/小姐」、訂購人、持卡人、付款帳號名稱、轉帳的付款方、簽名欄。
        照片上常是全名，成員清單常只寫名字或暱稱（「吳艷櫻」→「艷櫻」），請對應到清單上的正式名稱。
        ⚠️ 傳照片的人只是轉傳，不代表是他付的 —— 照片上的證據比「使用者名稱」可靠。
        收款方、店家、服務人員的名字不算；看到的名字對不上任何成員就跳過這一條。
     1. 旅程預設付款人（若有設定）
     2. 記帳偏好內所提及的預設付款人
     3. 都沒有 → 就是傳照片的人（上面的「使用者名稱」），系統會自動對應到成員。
        🚫 **不要**因為沒線索就填成員清單的第一位。
   - payer_source 照實回報付款人是哪裡來的：符合 0 填 "photo"、符合 1 或 2 填 "preference"、
     符合 3 填 "sender"（這時 payer_data 填什麼都會被系統換成傳照片的人）。
   - 金額分攤邏輯的優先權(split_details):
     1. 旅程預設分攤成員（若有設定）
     2. 記帳偏好所提及的分攤方式
     3. 全員均分
6. 回傳格式由系統的 response schema 約束，type 請填 "expense"。
   payer_data 與 split_details 都是陣列，每個元素是 { "member": "成員名稱", "amount": 金額 }。
7. 照片分三種，type 請照實回報：
   a. **收據或付款證明** → type: "expense"，照上面的規則辨識金額。
   b. **不是收據，但拍的是可以記帳的東西**：食物、飲料、甜點、商品、紀念品、門票、
      餐廳或店家的門面、菜單、價目表 → type: "item_photo"。
      - description 寫出「這是什麼」：菜名、商品名或店名，看得出外文就照規則 3 保留原文加中文說明，
        例如「一蘭ラーメン (拉麵)」、「抹茶霜淇淋」、「東京鐵塔紀念磁鐵」。看不出具體名稱就寫類別，例如「拉麵」。
      - category 依照片內容挑最接近的分類；date 填今日。
      - 🚫 **不要猜金額**，就算照片上看得到價格也一樣 —— 金額會留空，使用者自己填實際付的錢。
        amount 與 payer_data、split_details 裡每個人的 amount 一律填 0（系統會當成「還沒填」），
        成員一樣照規則 5 決定。
   c. **看不出是可以記帳的東西**（人物照、風景照、與消費無關的截圖）→ type: "not_receipt"，
      無需任何說明或讚美，系統會保留照片、讓使用者自己填內容。拿不準是 b 還是 c 時，照片主體是可以買的東西就選 b。
   ⚠️ **付款成功畫面與交易通知一律視為收據**，照常回 type: "expense"：
   行動支付（LINE Pay、街口、PayPay、Suica、悠遊卡）的付款完成畫面、
   信用卡的消費通知簡訊或 App 推播、轉帳成功畫面、電子發票畫面、訂單確認頁。
   這些沒有紙本收據的品項描述，就用商店名稱或服務名稱當描述。
7b. **品項明細（items）**：type 是 expense 而且收據上有逐項列出買了什麼時，把每一行都放進 items：
   name 照抄品名（外文保留原文），後面括號補簡短中文（**看得懂是什麼就好，通常 2～6 個字，要講清楚時可以再長一點**），例如「上せせり串【塩】(雞頸肉串)」「えんがわ(比目魚鰭邊肉)」「ジンジャーエール(薑汁汽水)」；
   不要寫口味、做法、數量這些補充說明 —— 品項一多，字寫長了辨識會慢好幾秒。amount 是那一行最後印的金額。
   同一行有數量（×2）就填乘完的金額，數量另外填 qty（2 以上才填，讓大家可以按份數分）；品項下面緊接的折扣（値引、割引、-50）直接從那一項扣掉，不要另列。
   ⚠️ 收據上**連續出現一模一樣的兩行**（同一道菜分兩次點）要列兩次，不能合併、不能跳過。
   amount 一律照那一行**印的金額**，不要為了湊總額改任何一項。
   ⚠️ **消費稅、服務費（サービス料）、席料不是品項**，也**不要加進任何一項**（例如把稅加到燒賣上）——
   程式會依每個人點的金額比例自動攤稅與服務費。外税的收據，items 加起來應該等於稅前的小計，不是合計。
   items_subtotal 填收據印的品項小計（外税＝稅前小計；內含稅或沒印小計就填合計）。
   列完把 items 加起來對一下 items_subtotal：對不上就回頭逐行再看一次，通常是漏了一行。
   0 元的行（加冰、免費附餐）不用列。
   🚫 小計、消費稅、合計、找零、點數、付款方式都不是品項。看不出明細（付款畫面、只有總額）就不要填 items。
8. **重要限制**：若封存狀態為「已封存」，一律回傳 type: "not_receipt"，系統會另行告知使用者旅程已封存。
`
}

export interface ReceiptRecognition {
  /** 驗證、補完預設值之後的內容（prepareExpense 的結果） */
  expense: PreparedExpense
  /** 這趟旅程沒有這個幣別的匯率（M10）。有值時不能直接存，照片要留著讓使用者選幣別 */
  reject?: string
  /** 品項照片：金額留空（以 0 占位），只能「填金額」不能直接存 */
  needsAmount: boolean
  /** 認不出是什麼（或 AI 沒回應）：描述與金額都是空的 */
  unidentified: boolean
  /** 付款人只是預設值（傳照片的人），不是照片或偏好看出來的 */
  payerDefaulted: boolean
  /** 🧾 逐項分要用的品項明細（只有真的收據才有） */
  items: ReceiptItem[]
  itemsSubtotal?: number
  /** 對不上成員的名字（已改用預設分攤） */
  unresolvedMembers: string[]
  /** 要告訴使用者的話：備援通知、AI 沒回應、成員對不上、幣別／日期被修正（reject 時只有前兩者） */
  notes: string[]
  /** 改由備援辨識時的那句話（也已經在 notes 裡） */
  fallbackNotice: string | null
}

/**
 * 辨識一張收據照片。照片已經存好了（呼叫端負責），這裡只讀它的 base64。
 *
 * AI 本身的失敗（額度、忙碌、逾時、格式壞掉）**不丟例外**：照片照樣留著、出一張空白卡，
 * notes 會說明為什麼是空的（使用者要求：上傳的照片不要丟）。
 */
export async function recognizeReceipt(
  ai: AiProvider,
  input: OcrPromptInput & { imageBase64: string; mimeType?: string },
): Promise<ReceiptRecognition> {
  const { trip, memberName, today } = input
  let busyNote: string | null = null
  // 主要的 AI 失敗、改由備援辨識時要說一聲（FALLBACK_NOTICES）
  let fallbackNotice: string | null = null
  let res: OcrResponse
  try {
    const aiResponse = await ai.generate({
      task: 'vision',
      messages: [{ role: 'user', parts: [
        { text: buildOcrPrompt(input) },
        { media: { mimeType: input.mimeType ?? 'image/jpeg', data: input.imageBase64 } },
      ]}],
      json: true,
      schema: OCR_RESPONSE_SCHEMA,
      temperature: 0.2,
      onFallback: (reason) => { fallbackNotice = FALLBACK_NOTICES[reason] },
    })
    try {
      res = JSON.parse(extractJSON(aiResponse))
    } catch {
      console.error('[OCR] Non-JSON response:', aiResponse.substring(0, 200))
      res = { type: 'not_receipt' }
    }
  } catch (e) {
    console.warn('[OCR] AI did not answer, keeping the photo as a blank card:', e)
    busyNote = aiUnavailableMessage(e) ?? '😵 AI 這次沒有回應。'
    res = { type: 'not_receipt' }
  }
  const unidentified = res.type !== 'expense' && res.type !== 'item_photo'
  if (unidentified) {
    console.log(`[PHOTO] Could not identify (${res.type}), keeping it as a blank card`)
    res = { type: 'item_photo', data: { description: '' } }
  }
  // 品項照片的金額留空：不管模型填了什麼都當成「還沒填」（以 0 占位），
  // 卡片上不給「確認存入」（commitExpense 也會擋 0 元，雙重保險）
  const needsAmount = res.type === 'item_photo'
  if (needsAmount) {
    res.data = { ...(res.data ?? {}), amount: 0 } as typeof res.data
    console.log(`[PHOTO] Item photo (no amount yet): ${String(res.data?.description ?? '')}`)
  }
  // 驗證與分帳走共用工具層，與文字路徑、「確認存入」同一份實作。
  // OCR 沒有使用者文字可以驗證 stated，sourceText 傳 null 代表直接採信（T3）。
  // 付款人沒有照片或偏好當根據時，一律交給 applyParticipantDefaults 補成傳照片的人
  // （模型常挑成員第一位 —— 群組裡誰傳的收據都變成同一個人付的，2026-11-20）。
  const payerDefaulted = res.payer_source !== 'photo' && res.payer_source !== 'preference'
  if (payerDefaulted && res.data) {
    res.data = { ...res.data, payer_data: [] } as typeof res.data
  }
  const prepared = prepareExpense(
    (res.data ?? {}) as unknown as ExpenseInput,
    trip,
    { today, actorName: memberName, sourceText: null },
  )
  const expense = prepared.expense
  const itemsSubtotal = Number(res.items_subtotal) > 0 ? Number(res.items_subtotal) : undefined
  const items = needsAmount ? [] : reconcileReceiptItems(sanitizeReceiptItems(res.items), Number(expense.amount) || 0, itemsSubtotal)

  // 成員名稱對不上的從 map 裡拿掉並補上旅程預設 —— 照片留著、卡片照出，使用者自己改（M10）
  const unresolved = prepared.unresolvedMembers
  if (unresolved.length > 0) console.warn(`[OCR] Unresolvable members: ${unresolved.join(', ')}`)
  const memberWarning = unresolved.length > 0
    ? `⚠️ 收據的分帳裡有對不上的名字：${unresolved.join('、')}\n`
      + `（目前成員：${trip.members.join('、')}）\n`
      + '已改用旅程的預設分攤，不對的話請按卡片上的「✏️ 編輯」。'
    : null

  const notes = [
    ...(fallbackNotice ? [fallbackNotice] : []),
    ...(busyNote ? [`${busyNote}\n照片先幫你留著了，可以按卡片上的「✏️ 填寫內容」自己填。`] : []),
    ...(prepared.reject ? [] : [memberWarning, ...prepared.warnings].filter(Boolean) as string[]),
  ]
  return {
    expense,
    reject: prepared.reject ?? undefined,
    needsAmount,
    unidentified,
    payerDefaulted,
    items,
    itemsSubtotal: items.length > 0 ? itemsSubtotal : undefined,
    unresolvedMembers: unresolved,
    notes,
    fallbackNotice,
  }
}
