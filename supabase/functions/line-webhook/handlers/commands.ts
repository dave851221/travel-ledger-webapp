// ============================================================
// handlers/commands.ts —— 文字（含語音轉錄）的路由與所有指令
//
// 兩支公開函式：
//   routeTextMessage() 決定「這句話該不該處理」，並算出比對用的 cleanText
//   handleCommands()   依序試過所有明確指令，回傳 true 代表已經處理完
//
// ⚠️ 順序就是規格，不要重排：
//    使用說明 → ID 綁定 → 放棄綁定 → 斷開 → 群組模式 → 記帳偏好 → 密碼驗證
//    → （以下需已綁定）取消草稿 → 編輯清單 → 刪除清單 → 撤銷上一筆 → 快捷查詢
//    密碼驗證那一關可以「不處理」而往下掉（群組裡沒 @ 的閒聊），
//    快捷查詢之後也是 —— 兩者都會落到 AI 核心去。
// ============================================================

import { formatAmount, calculateMemberBalances, calculateSettlements, sumByCurrency } from "../../_shared/finance.ts"
import {
  CANCEL_DRAFT_KEYWORDS,
  detectRecordIntent,
  stripSelfMentions,
} from "../guards.ts"
import {
  DELETE_LIST_KEYWORDS,
  EDIT_LIST_KEYWORDS,
  HELP_KEYWORDS,
  QUICK_CMD_KEYWORDS,
  UNDO_KEYWORDS,
  WEBAPP_URL,
} from "../config.ts"
import { type EventContext, tripToday } from "../context.ts"
import { supabase } from "../db.ts"
import { cancelDraft, supersedeAllDrafts } from "../drafts.ts"
import { replyMessage } from "../line-api.ts"
import {
  BOT_SELF_INTRODUCTION,
  buildBindSuccessText,
  formatTotals,
  getQuickReply,
  preferenceQuickReply,
  replyEditPicker,
} from "../messages.ts"
import { getTodayString, getTripTimezone, requiresAccessCode } from "../util.ts"
import type { ExpenseRow } from "../../_shared/types.ts"
import type { Mentionee, OutgoingMessage, SavedExpenseEntry, TextRoute } from "../types.ts"

/** 快捷查詢與清單只 select 這幾個欄位 */
type ListRow = Pick<ExpenseRow, "id" | "description" | "amount" | "currency" | "date">
type SummaryRow = Pick<ExpenseRow, "description" | "amount" | "currency" | "category">
type DatedSummaryRow = SummaryRow & Pick<ExpenseRow, "date">

/**
 * 決定這則文字訊息要不要處理，並算出後面所有比對要用的 cleanText。
 *
 * 回傳 null 代表「群組裡沒有對機器人講話」，整則事件到此為止。
 */
export function routeTextMessage(
  ctx: EventContext,
  rawText: string,
  mentionees: Mentionee[] | undefined,
): TextRoute | null {
  const { isBinding, isBound, isGroup, mentionRequired } = ctx

  const userText = rawText.trim()
  console.log(`[USER_TEXT] "${userText}"`)

  const isMentioned = mentionees?.some((m: Mentionee) => m.isSelf === true)
  const isIdCommand = userText.toUpperCase().startsWith('ID:') || userText.toUpperCase().startsWith('ID：')
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
    return null
  }

  const cleanText = withoutSelfMention.replace(/^耀西\s*/, '').trim()
  return { rawText, cleanText, isMentioned: !!isMentioned, startsWithYoshi }
}

/**
 * 依序試過所有明確指令。
 *
 * 回傳 true＝已經回覆完畢，呼叫端跳到下一則事件；
 * 回傳 false＝沒有任何指令認領這句話，交給 AI 核心（未綁定則回「請先輸入 ID:代碼」）。
 */
export async function handleCommands(ctx: EventContext, route: TextRoute): Promise<boolean> {
  const { boundQR, isBinding, isBound, isGroup, mentionRequired, replyToken, sourceId, speakerLabel, userState } = ctx
  const { cleanText, isMentioned, startsWithYoshi } = route

// 0a. 明確想看使用說明 → 完整介紹
if (HELP_KEYWORDS.includes(cleanText)) {
  await replyMessage(replyToken, [{ type: 'text', text: BOT_SELF_INTRODUCTION, quickReply: isBound ? boundQR : getQuickReply(false) }], sourceId)
  return true
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
  return true
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
  return true
}

// 1b. 放棄綁定（M1）——「輸入 ID 後反悔」以前完全沒有出口
if (cleanText === '取消綁定' || cleanText === '放棄綁定') {
  if (!isBinding) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: 'ℹ️ 目前沒有在等待密碼。想解除已綁定的旅程請輸入「斷開」。',
      quickReply: isBound ? boundQR : getQuickReply(false),
    }], sourceId)
    return true
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
  return true
}

// 2. 斷開
if (isBound && (cleanText === '斷開' || cleanText === '切換旅程')) {
  await supabase.from('line_user_states')
    .update({ current_trip_id: null, pending_trip_id: null, pending_at: null })
    .eq('line_user_id', sourceId)
  // 沒有旅程可以存進去了，留著的卡片按下去只會出錯（M13）
  await supersedeAllDrafts(sourceId)
  await replyMessage(replyToken, [{ type: 'text', text: '❌ 已解除連接。如需重新連接，請輸入 ID:您的代碼', quickReply: getQuickReply(false) }], sourceId); return true
}

// 3. 切換群組回應模式
if (isBound && (cleanText === '模式:全回應模式' || cleanText === '模式:提及模式')) {
  const newMentionRequired = cleanText === '模式:提及模式'
  await supabase.from('line_user_states').update({ mention_required: newMentionRequired }).eq('line_user_id', sourceId)
  const msg = newMentionRequired
    ? '🎯 已切換為提及模式。\n群組中需 @提及 或以「耀西」開頭才會回應。'
    : '📣 已切換為全回應模式。\n群組中所有訊息都會被耀西處理！'
  await replyMessage(replyToken, [{ type: 'text', text: msg, quickReply: getQuickReply(true, isGroup, newMentionRequired) }], sourceId)
  return true
}

// 4. 查看旅程的 AI 記帳偏好
//    偏好存在 trips.ai_preference，整趟旅程共用一份，網頁的設定頁看到的是同一份。
if (isBound && (cleanText === '設定?' || cleanText === '設定？')) {
  const { data: prefTrip } = await supabase.from('trips')
    .select('ai_preference').eq('id', userState.current_trip_id).maybeSingle()
  if (!prefTrip) {
    await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
    return true
  }
  const config = prefTrip.ai_preference
  const msg = config
    ? `⚙️ 這趟旅程目前的 AI 記帳偏好：\n\n${config}\n\n（整趟旅程共用一份，網頁的旅程設定頁也看得到）\n\n要修改請按下方「⚙️ 記帳偏好」，或輸入「設定: 新的內容」。`
    : '⚙️ 這趟旅程還沒設定 AI 記帳偏好。\n\n按下方「⚙️ 記帳偏好」開啟編輯畫面，或輸入「設定: 預設由我付款，大家均分」。'
  await replyMessage(replyToken, [{
    type: 'text', text: msg, quickReply: preferenceQuickReply(userState.current_trip_id!, isGroup, mentionRequired),
  }], sourceId)
  return true
}

// 4. 設定旅程的 AI 記帳偏好（文字捷徑；完整編輯走 LIFF 表單）
if (isBound && (cleanText.startsWith('設定:') || cleanText.startsWith('設定：'))) {
  const config = cleanText.substring(3).trim()
  if (!config) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: '⚙️ 設定內容不能為空，請輸入偏好內容，例如：\n「設定: 預設由我付款，大家均分」\n\n要清空請輸入「設定:清除」。',
      quickReply: preferenceQuickReply(userState.current_trip_id!, isGroup, mentionRequired),
    }], sourceId)
    return true
  }
  // 「清除」是唯一的保留字：否則會把「清除」兩個字原封不動存成偏好內容
  const isClear = config === '清除' || config === '清空'
  const { error: prefError } = await supabase.from('trips')
    .update({ ai_preference: isClear ? null : config })
    .eq('id', userState.current_trip_id)
  if (prefError) {
    await replyMessage(replyToken, [{ type: 'text', text: '❌ 偏好儲存失敗，請稍後再試或改用網頁設定頁。' }], sourceId)
    return true
  }
  const msg = isClear
    ? '⚙️ 已清空這趟旅程的 AI 記帳偏好。'
    : '⚙️ 已更新這趟旅程的 AI 記帳偏好，之後記帳時會參考它。\n（整趟旅程共用一份，網頁的旅程設定頁也看得到）'
  await replyMessage(replyToken, [{
    type: 'text', text: msg, quickReply: preferenceQuickReply(userState.current_trip_id!, isGroup, mentionRequired),
  }], sourceId)
  return true
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
      text: buildBindSuccessText(trip!.name, trip!.members, userState.pending_trip_id!),
      // 同上：要用剛綁定的旅程算快速回覆，boundQR 裡沒有偏好按鈕
      quickReply: getQuickReply(true, isGroup, mentionRequired, userState.pending_trip_id)
    }], sourceId)
    return true
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
    return true
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
    return true
  }
  console.log(`[BIND] Group chatter during trip switch; falling through to the current trip.`)
}

  // 以下的指令都需要已綁定旅程。沒綁定就交還給呼叫端去回「請先輸入 ID:代碼」。
  if (!isBound) return false
  const tripId = userState.current_trip_id as string

  const loadDrafts = ctx.loadDrafts

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
    return true
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
    return true
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
      return true
    }

    // 每一列：左邊是描述與金額，右邊固定一顆小按鈕。
    // 按鈕文字刻意固定為「🗑 刪除」—— 把描述放進按鈕會讓按鈕寬度爆掉。
    const rows: OutgoingMessage[] = []
    recent.forEach((e: ListRow, idx: number) => {
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
    return true
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

    const savedEntries: SavedExpenseEntry[] = []
    for (const row of savedHistory ?? []) {
      try {
        const parsed = JSON.parse(row.content)
        if (parsed?.expense_id) savedEntries.push(parsed)
      } catch { /* skip malformed */ }
    }

    if (savedEntries.length === 0) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到可以撤銷的最近記錄。' }], sourceId)
      return true
    }

    // 一次查回這幾筆的狀態，挑第一筆「還沒被刪掉」的來撤
    const { data: targets } = await supabase.from('expenses')
      .select('id, description, deleted_at')
      .in('id', savedEntries.map(e => e.expense_id))
      .eq('trip_id', tripId)
    const targetById = new Map((targets ?? []).map((t: Pick<ExpenseRow, 'id' | 'description' | 'deleted_at'>) => [t.id, t]))
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
      return true
    }

    const description = targetById.get(undoable.expense_id)?.description || undoable.description || '該筆支出'
    const { error } = await supabase.from('expenses')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', undoable.expense_id)
      .eq('trip_id', tripId)
      .is('deleted_at', null)
    if (error) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 撤銷失敗，請至網頁手動刪除。' }], sourceId)
      return true
    }
    // 群組內任何人都能撤銷任何人的紀錄（刻意保留），但要講清楚撤掉的是誰記的那筆
    const originalBy = undoable.by && undoable.by !== speakerLabel ? `（原由 ${undoable.by} 記錄）` : ''
    await replyMessage(replyToken, [{ type: 'text', text: `↩️ 已撤銷：${description}${originalBy}`, quickReply: boundQR }], sourceId)
    return true
  }

  // ── 快捷指令（直接查 DB，不走 AI）──
  if (cleanText === '今日支出' || cleanText === '今天支出') {
    const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates, default_currency, precision_config').eq('id', tripId).single()
    if (!trip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
      return true
    }
    const precisionConfig = (trip.precision_config ?? {}) as Record<string, number>
    const today = tripToday(trip)
    const { data: todayExp } = await supabase.from('expenses')
      .select('description, amount, currency, category')
      .eq('trip_id', tripId).eq('date', today)
      .is('deleted_at', null).not('is_settlement', 'is', true)
      .order('created_at', { ascending: true })
    if (!todayExp || todayExp.length === 0) {
      await replyMessage(replyToken, [{ type: 'text', text: `📅 今日（${today.substring(5)}）尚無支出記錄。`, quickReply: boundQR }], sourceId)
    } else {
      const lines = todayExp.map((e: SummaryRow) => `• ${e.description}  ${formatAmount(e.amount, e.currency, precisionConfig)} ${e.currency}  [${e.category}]`)
      const totalStr = formatTotals(todayExp, precisionConfig)
      await replyMessage(replyToken, [{ type: 'text', text: `📅 今日支出（${today.substring(5)}）\n\n${lines.join('\n')}\n\n共 ${todayExp.length} 筆 · 合計 ${totalStr}`, quickReply: boundQR }], sourceId)
    }
    return true
  }

  if (cleanText === '本週支出' || cleanText === '近期支出') {
    const { data: trip } = await supabase.from('trips').select('name, base_currency, rates, default_currency, precision_config').eq('id', tripId).single()
    if (!trip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
      return true
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
      const byDate: Record<string, DatedSummaryRow[]> = {}
      weekExp.forEach((e: DatedSummaryRow) => { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e) })
      const lines: string[] = []
      Object.entries(byDate).forEach(([date, exps]) => {
        lines.push(`📌 ${date.substring(5)}`)
        exps.forEach((e) => lines.push(`  • ${e.description}  ${formatAmount(e.amount, e.currency, precisionConfig)} ${e.currency}`))
      })
      await replyMessage(replyToken, [{ type: 'text', text: `📊 近 7 天支出\n\n${lines.join('\n')}\n\n共 ${weekExp.length} 筆 · 合計 ${formatTotals(weekExp, precisionConfig)}`, quickReply: boundQR }], sourceId)
    }
    return true
  }

  if (cleanText === '本月支出') {
    const { data: trip } = await supabase.from('trips').select('name, base_currency, rates, default_currency, precision_config').eq('id', tripId).single()
    if (!trip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
      return true
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
      const byDate: Record<string, DatedSummaryRow[]> = {}
      monthExp.forEach((e: DatedSummaryRow) => { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e) })
      const lines: string[] = []
      Object.entries(byDate).forEach(([date, exps]) => {
        lines.push(`📌 ${date.substring(5)}`)
        exps.forEach((e) => lines.push(`  • ${e.description}  ${formatAmount(e.amount, e.currency, precisionConfig)} ${e.currency}`))
      })
      const totalStr = formatTotals(monthExp, precisionConfig)
      let text = `📊 本月支出（${monthStart.substring(0, 7)}）\n\n${lines.join('\n')}\n\n共 ${monthExp.length} 筆 · 合計 ${totalStr}`
      if (text.length > 4900) text = text.substring(0, 4900) + '\n...(過多省略)'
      await replyMessage(replyToken, [{ type: 'text', text, quickReply: boundQR }], sourceId)
    }
    return true
  }

  if (cleanText === '結算') {
    const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates, precision_config').eq('id', tripId).single()
    if (!trip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
      return true
    }
    const { data: allExp } = await supabase.from('expenses')
      .select('amount, currency, payer_data, split_data')
      .eq('trip_id', tripId).is('deleted_at', null)
    const baseCurrency = trip.base_currency
    // 餘額與匯率換算走 _shared/finance.ts 的共用實作（M14）——
    // 網頁的 useTripStats 呼叫的是同一支的前端版本，兩份由契約測試比對。
    // 以前兩邊各寫各的 rate 判斷（這裡是 `currency === base ? 1 : rates[...]`，
    // 前端是 `rates[...] || 1`），rates[base] 不等於 1 時會算出不同的結算結果。
    // 所有紀錄（含結清）都要計入餘額，所以上面的查詢刻意沒有濾掉 is_settlement。
    const { grandTotal, missingRateCurrencies } = calculateMemberBalances(
      allExp ?? [], trip.members, trip.rates, baseCurrency,
    )
    const settlements = calculateSettlements(grandTotal)
    // 有幣別被當成 1:1 換算時要講出來，否則結算金額默默失真
    const rateWarning = missingRateCurrencies.length > 0
      ? `\n\n⚠️ ${missingRateCurrencies.join('、')} 沒有設定匯率，已當成 1:1 折算，結果會失真。`
        + `\n請到網頁的「設定 → 匯率精度」補上。`
      : ''
    if (settlements.length === 0) {
      await replyMessage(replyToken, [{ type: 'text', text: `✅ 目前一切已結清，無需轉帳！${rateWarning}`, quickReply: boundQR }], sourceId)
    } else {
      // Math.round 會把 12.50 USD 顯示成 13 —— 一律依旅程的 precision_config 格式化（H5）
      const settlePrecision = (trip.precision_config ?? {}) as Record<string, number>
      const lines = settlements.map(s => `${s.from} → ${s.to}  ${formatAmount(s.amount, baseCurrency, settlePrecision)} ${baseCurrency}`)
      await replyMessage(replyToken, [{ type: 'text', text: `💰 結算試算建議（折合 ${baseCurrency}）\n\n${lines.join('\n')}${rateWarning}\n\n🌐 詳細：${WEBAPP_URL}/#/trip/${tripId}/dashboard`, quickReply: boundQR }], sourceId)
    }
    return true
  }

  if (cleanText === '旅程總覽') {
    const { data: trip } = await supabase.from('trips').select('name, members, base_currency, rates, is_archived, precision_config').eq('id', tripId).single()
    if (!trip) {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ 找不到這個旅程，可能已被刪除。請重新輸入「ID:代碼」綁定。' }], sourceId)
      return true
    }
    const precisionConfig = (trip.precision_config ?? {}) as Record<string, number>
    const today = tripToday(trip)
    const { data: allExp } = await supabase.from('expenses')
      .select('amount, currency').eq('trip_id', tripId)
      .is('deleted_at', null).not('is_settlement', 'is', true)
    const totals = sumByCurrency(allExp ?? [])
    const totalStr = Object.keys(totals).length > 0
      ? Object.entries(totals).map(([c, a]) => `  ${formatAmount(a.toNumber(), c, precisionConfig)} ${c}`).join('\n')
      : '  （尚無支出）'
    const status = trip.is_archived ? '已封存 🔒' : '進行中 ✈️'
    await replyMessage(replyToken, [{ type: 'text', text: `🗺️ ${trip.name}（${status}）\n\n👥 成員：${trip.members.join('、')}\n📅 今日：${today}\n💵 主幣別：${trip.base_currency}\n\n📊 支出總計：\n${totalStr}\n\n🌐 ${WEBAPP_URL}/#/trip/${tripId}/dashboard`, quickReply: boundQR }], sourceId)
    return true
  }

  // 沒有指令認領這句話 —— 交給 AI 核心
  return false
}
