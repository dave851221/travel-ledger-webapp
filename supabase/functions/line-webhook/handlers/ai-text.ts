// ============================================================
// handlers/ai-text.ts —— AI 核心
//
// 走到這裡代表沒有任何明確指令認領這句話。查旅程、近期支出、對話歷史與
// 全趟彙總，組成 context 交給 Gemini，再依它回的 type 分成三條路：
//   expense       出一張待確認的記帳卡片（必要時讓被修正的舊卡片失效）
//   analyze_photo 重新閱讀某一筆的收據照片並回答
//   chat          一般聊天／查詢
//
// ⚠️ 金額類的回答一律引用【全趟彙總】—— 那是伺服器用 Decimal 算好的。
//    AI 只看得到最近 10 筆，讓它自己加總一定是錯的（M6）。
// ============================================================

import { formatAmount } from "../../_shared/finance.ts"
import { prepareExpense } from "../../_shared/tools/expenses.ts"
import {
  claimsCompletedAction,
  extractJSON,
  matchExpensesByQuestion,
  mentionsEditingExisting,
  pickExpenseByRef,
  summarizeHistoryEntry,
  summarizeTripExpenses,
} from "../guards.ts"
import { CHAT_HISTORY_TURNS, isRateLimit, RATE_LIMIT_MSG, WEBAPP_URL } from "../config.ts"
import { type EventContext, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import { photoPublicUrl, storePendingExpense, supersedeDraft } from "../drafts.ts"
import {
  analyzeReceiptPhoto,
  askGemini,
  fetchPhotoPart,
  GEMINI_FALLBACK_MODELS,
  GEMINI_OCR_MODELS,
  memberAliasHint,
  TEXT_RESPONSE_SCHEMA,
  YOSHI_SYSTEM_INSTRUCTION,
} from "../gemini.ts"
import { pushMessage, replyMessage } from "../line-api.ts"
import { buildDraftLiffUrl, buildExpenseCard, replyEditPicker } from "../messages.ts"
import { runInBackground } from "../util.ts"
import type { ExpenseInput } from "../../_shared/tools/types.ts"
import type { ExpenseRow } from "../../_shared/types.ts"

/** 近期支出與全庫搜尋只 select 這幾個欄位 */
type RecentExpense = Pick<
  ExpenseRow,
  "id" | "description" | "amount" | "currency" | "category" | "date" | "photo_urls"
>
import type {
  ChatHistoryRow,
  GeminiContent,
  PhotoSelectResponse,
  TextResponse,
  TextRoute,
} from "../types.ts"

/** 交給 Gemini。呼叫端已經確認 ctx.isBound，而且沒有任何指令認領這句話。 */
export async function handleAiText(ctx: EventContext, route: TextRoute): Promise<void> {
  const { boundQR, memberName, replyToken, sourceId, speakerLabel, speakerUserId, userState } = ctx
  const { cleanText } = route
  const tripId = userState.current_trip_id as string
  const loadDrafts = ctx.loadDrafts

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
      // description 是給「金額最大的幾筆」用的（K13）
      .select('amount, currency, description, category, date, is_settlement, payer_data, split_data')
      .eq('trip_id', tripId)
      .is('deleted_at', null),
  ])
  // 旅程可能已被後台刪除（見 docs/DB_MAINTENANCE.md）。
  // 以前這裡直接讀 trip.name，整個 event 丟出例外 → 500 → LINE 會重送同一則訊息（M5）。
  if (!trip) {
    await replyMessage(replyToken, [{
      type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。',
    }], sourceId)
    return
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

  const today = tripToday(trip)

  // 有編號、沒有網址。編號是 analyze_photo 唯一要 AI 回的東西 ——
  // 網址長又相似，小模型抄不準，還白白吃掉一堆 token（T4）。
  const contextPrecision = (trip.precision_config ?? {}) as Record<string, number>
  // 全趟的精確彙總。AI 只看得到最近 10 筆，自由查詢（K8–K13）過去一律答錯（M6）。
  // rates 與主幣別是用來排序「金額最大的幾筆」的：跨幣別不折算就比不出大小
  const tripSummary = summarizeTripExpenses(
    allForSummary ?? [], trip.members ?? [], contextPrecision,
    { rates: trip.rates, baseCurrency: trip.base_currency },
  )
  const expensesSummary = (expenses ?? []).map((e: RecentExpense, idx: number) => {
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
  const rawConversation: GeminiContent[] = [
    { role: 'user', parts: [{ text: tripContext }] },
    { role: 'model', parts: [{ text: '{"type":"chat","content":"了解，我已掌握這趟旅程的設定。"}' }] },
    // 查詢是新到舊，這裡反轉回舊到新才符合對話順序
    ...orderedHistory.map((h: ChatHistoryRow): GeminiContent => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: summarizeHistoryEntry(h.role, h.content, h.speaker_name) }],
    })),
    { role: 'user', parts: [{ text: cleanText }] },
  ]

  // Gemini 的 contents 預期 user / model 交替。歷史裡可能出現連續兩則 model
  // （例如拍照產生的草稿沒有對應的使用者文字），先合併起來避免格式異常。
  const conversation = rawConversation.reduce((acc: GeminiContent[], turn: GeminiContent) => {
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
    const res = JSON.parse(extractJSON(aiResponse)) as TextResponse
    if (res.type === 'expense') {
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
        return
      }

      // 驗證與分帳整段走共用工具層（_shared/tools/expenses.ts），與 OCR 路徑、
      // 「確認存入」用的是同一份實作。sourceText 給使用者的原話 ——
      // 幣別宣稱 stated 時要拿它驗一次，文字裡真的有幣別字眼才採信（T3）。
      const prepared = prepareExpense(
        (res.data ?? {}) as unknown as ExpenseInput,
        trip,
        { today, actorName: memberName, sourceText: cleanText },
      )
      const expense = prepared.expense

      // 先試著把暱稱對應回正式名稱，真的對不上才退回請使用者重講。
      // （OCR 路徑只警告 —— 那邊照片已經上傳，重拍的代價比重打一句話大得多。）
      const unknownMembers = prepared.unresolvedMembers
      if (unknownMembers.length > 0) {
        console.warn(`[TEXT] Unknown members detected: ${unknownMembers.join(', ')}`)
        await replyMessage(replyToken, [{
          type: 'text',
          text: `😅 我從您的描述中辨識到不存在的成員：${unknownMembers.join('、')}\n\n目前旅程成員只有：${trip.members.join('、')}\n\n可能是名字打錯或漏字了，請改用正確的成員名稱再說一次。`,
          quickReply: boundQR
        }], sourceId)
        return
      }

      // 這趟旅程沒有這個幣別的匯率 —— 存下去統計會以 1:1 換算而失真。
      // （文字路徑沒有照片要留，直接請使用者換一個幣別就好。）
      if (prepared.reject) {
        await replyMessage(replyToken, [{
          type: 'text', text: prepared.reject, quickReply: boundQR,
        }], sourceId)
        return
      }
      const textWarnings = prepared.warnings

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
        : ((res.data as { photo_ids?: string[] } | undefined)?.photo_ids ?? [])

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
      const label = (e: RecentExpense) =>
        `${e.description} ${formatAmount(e.amount, e.currency, contextPrecision)} ${e.currency}`

      /** 把選定的那一筆的**所有**收據照片一起送去分析並回覆 */
      const analyzeChosen = async (chosen: RecentExpense) => {
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
      const recentPick = refPick && (refPick.photo_urls?.length ?? 0) > 0 ? refPick : null

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

          const withPhotos = (allExpenses ?? []).filter((e: RecentExpense) => e.photo_urls?.length > 0)

          if (withPhotos.length === 0) {
            await pushMessage(sourceId, [{ type: 'text', text: '😅 此旅程中找不到任何帶有收據照片的支出紀錄。', quickReply: boundQR }])
            return
          }

          // 先在程式端縮小範圍：店名多半原封不動出現在問句裡。
          // 命中唯一一筆就不必再叫一次模型（省一次呼叫，也少一次挑錯的機會）。
          // 連原句一起比對：AI 轉述的 question 可能把店名丟掉（「詳細是買了什麼」）
          const narrowed = matchExpensesByQuestion(`${cleanText} ${question}`, withPhotos)
          let chosen: RecentExpense | null = narrowed.length === 1 ? narrowed[0] : null

          if (!chosen) {
            const pool = narrowed.length > 1 ? narrowed : withPhotos
            const expenseList = pool.map((e: RecentExpense, idx: number) =>
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
            const selectRes = JSON.parse(extractJSON(selectText)) as PhotoSelectResponse
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
}
