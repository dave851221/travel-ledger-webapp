// ============================================================
// handlers/bind-public.ts —— 開放版（旅行喵喵）的綁定旅程
//
// 舊版用「ID:6 碼代碼」＋通行碼；開放版沒有通行碼，改成：
//   1. 輸入「綁定」→ 查這個 LINE 帳號（必須已經在網站用 LINE 登入過）是哪幾趟的成員，列成按鈕
//   2. 按下按鈕（postback tlb_bind）→ 資料庫 bind_line_chat 再確認一次是成員，才綁定
// 按鈕只帶旅程 id，任何人都能偽造 postback，所以第 2 步一定要以「按的人」重新檢查，不能信按鈕。
// ============================================================

import { type BindableTrip, buildBindPickerFlex } from "../bind-card.ts"
import { WEBAPP_URL } from "../config.ts"
import type { EventContext } from "../context.ts"
import { supabase } from "../db.ts"
import { supersedeAllDrafts } from "../drafts.ts"
import { replyMessage } from "../line-api.ts"
import { buildBindSuccessText, getQuickReply } from "../messages.ts"

/** 這些字開始綁定（整句相符） */
export const PUBLIC_BIND_KEYWORDS = ['綁定', '綁定旅程', '連結旅程', '切換旅程', '選擇旅程']

const BIND_POSTBACK_PREFIX = 'tlb_bind='
/** 卡片最多列幾趟（再多手機要滑很久；Flex 單則上限 30 KB 也還很遠） */
const MAX_TRIP_ROWS = 12

export const isPublicBindPostback = (data: string | undefined): boolean => !!data?.startsWith(BIND_POSTBACK_PREFIX)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function signInFirstText(): string {
  return `要先讓我認得你喵 🐱\n\n1. 用這個 LINE 帳號登入網頁版：\n${WEBAPP_URL}/\n2. 建立旅程，或用朋友給的邀請連結加入\n3. 回來這裡再輸入一次「綁定」`
}

/** 「綁定」：列出這個人可以綁的旅程 */
export async function replyBindPicker(ctx: EventContext): Promise<void> {
  const { replyToken, sourceId, speakerUserId, isBound, boundQR } = ctx
  if (!speakerUserId) {
    // 群組裡沒加機器人好友的人，LINE 不給 userId，認不出是誰
    await replyMessage(replyToken, [{ type: 'text', text: '我認不出你是誰喵，請先加我為好友，再輸入一次「綁定」。' }], sourceId)
    return
  }
  const { data, error } = await supabase.rpc('line_bindable_trips', { p_line_user_id: speakerUserId })
  if (error || !data) {
    console.error('[BIND] line_bindable_trips failed', error?.code ?? '')
    await replyMessage(replyToken, [{ type: 'text', text: '剛剛出了點狀況，請再輸入一次「綁定」。' }], sourceId)
    return
  }
  const trips = (data.trips ?? []) as BindableTrip[]
  if (!data.linked) {
    await replyMessage(replyToken, [{ type: 'text', text: signInFirstText(), quickReply: isBound ? boundQR : getQuickReply(false) }], sourceId)
    return
  }
  if (trips.length === 0) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: `你還沒有可以記帳的旅程喵。\n到網頁版建立一趟，或用朋友給的邀請連結加入：\n${WEBAPP_URL}/\n\n好了之後再輸入「綁定」。`,
    }], sourceId)
    return
  }
  // 一張 Flex 卡片：每趟一列（日期、名稱、人數），整列可點。以前的 quick reply 小按鈕跟聊天背景混在一起看不出來
  const shown = trips.slice(0, MAX_TRIP_ROWS)
  await replyMessage(replyToken, [buildBindPickerFlex(shown, {
    isGroup: ctx.isGroup,
    currentTripId: ctx.userState?.current_trip_id ?? null,
    total: trips.length,
    webUrl: WEBAPP_URL,
    postbackPrefix: BIND_POSTBACK_PREFIX,
  })], sourceId)
}

/** 按了旅程按鈕：以按的人重新確認是成員，才綁定 */
export async function handlePublicBindPostback(ctx: EventContext, data: string): Promise<void> {
  const { replyToken, sourceId, speakerUserId, isGroup, groupMode } = ctx
  const tripId = data.slice(BIND_POSTBACK_PREFIX.length)
  if (!speakerUserId || !UUID_RE.test(tripId)) {
    await replyMessage(replyToken, [{ type: 'text', text: '這個按鈕失效了，請重新輸入「綁定」。' }], sourceId)
    return
  }
  const { data: result, error } = await supabase.rpc('bind_line_chat', {
    p_source_id: sourceId, p_line_user_id: speakerUserId, p_trip_id: tripId,
  })
  if (error || !result?.ok) {
    const reason = result?.reason
    const text = reason === 'not_member'
      ? '只有這趟旅程的成員可以綁定喵。請先用邀請連結加入，再輸入「綁定」。'
      : reason === 'archived'
        ? '這趟旅程已經封存了，不能再記帳。'
        : '綁定沒有成功，請重新輸入「綁定」。'
    if (error) console.error('[BIND] bind_line_chat failed', error.code ?? '')
    await replyMessage(replyToken, [{ type: 'text', text }], sourceId)
    return
  }
  // 換了旅程，舊草稿指向上一趟，全部失效
  await supersedeAllDrafts(sourceId)
  await replyMessage(replyToken, [{
    type: 'text',
    text: buildBindSuccessText(result.name, result.members ?? [], tripId),
    quickReply: getQuickReply(true, isGroup, groupMode, tripId),
  }], sourceId)
}
