// ============================================================
// context.ts —— 一則 webhook 事件的共用狀態
//
// 原本這段是 serve() 迴圈開頭的六十幾行區域變數，handler 拆出去之後
// 每一支都要重新查一次同樣的東西。集中成一個 EventContext，
// 「一則事件只查一次」的性質才守得住 —— 尤其是 loadDrafts。
// ============================================================

import { supabase } from "./db.ts"
import { getChatMemberName } from "./line-api.ts"
import { getQuickReply } from "./messages.ts"
import { getOutstandingDrafts, type OutstandingDraft } from "./drafts.ts"
import { getTodayString, getTripTimezone, isPendingExpired, runInBackground } from "./util.ts"
import type { QuickReply, SourceType, UserStateRow, WebhookEvent } from "./types.ts"

/** 一則事件從頭到尾共用的狀態。所有 handler 的第一個參數都是它。 */
export interface EventContext {
  /** groupId ?? roomId ?? userId —— 綁定與偏好都掛在這個 id 上 */
  sourceId: string
  sourceType: SourceType
  isGroup: boolean
  replyToken: string
  /** 實際發言的人。群組事件也有，除非對方沒加機器人好友。 */
  speakerUserId: string | null
  /**
   * 傳訊者的顯示名稱，抓不到時是「未知」。
   * ⚠️ 一對一也要有：AI 靠它把「我付的」對應到成員（H9）。
   */
  memberName: string
  /** 群組才標記「由 X 記錄」，一對一是 null —— 一對一標了只是贅述 */
  speakerLabel: string | null
  userState: UserStateRow
  isBound: boolean
  isBinding: boolean
  mentionRequired: boolean
  /** 綁定狀態下的快速回覆，整則事件共用 */
  boundQR: QuickReply
  /**
   * 這個聊天目前還沒被確認／取消的草稿，記憶化。
   * 文字路徑有兩個地方要用：路由判斷（「取消」指的是哪一張），
   * 以及餵給 AI 的 context（AI 要用 nonce 指名它在修哪一張）。
   */
  loadDrafts: () => Promise<OutstandingDraft[]>
}

/**
 * 這趟旅程的「今天」。
 *
 * 每個要判斷日期的地方都是 `getTodayString(getTripTimezone(trip))` 這兩層，
 * 少寫一層就會退回 Asia/Taipei，日本旅程的深夜記帳會記到前一天（F4）。
 */
export function tripToday(trip: { timezone?: string | null; base_currency?: string; rates?: Record<string, number> | null }): string {
  return getTodayString(getTripTimezone(trip))
}

/**
 * 建立這則事件的 EventContext。
 *
 * ⚠️ 順序不能動：讀狀態 → 清掉過期的 pending 綁定 → 才算 isBound／isBinding。
 *    先算的話，等密碼等超過 10 分鐘的人會一直卡在「密碼錯誤」（M1）。
 */
export async function buildEventContext(event: WebhookEvent): Promise<EventContext> {
  // 只有 message / postback / join 會走到需要回覆的分支，那三種一定帶 replyToken；
  // 其餘事件拿到空字串也不會被用到。
  const replyToken = (event as { replyToken?: string }).replyToken ?? ''
  const sourceId = event.source.groupId || event.source.roomId || event.source.userId || ''
  const sourceType = event.source.type
  const isGroup = sourceType !== 'user'
  console.log(`[EVENT] ${JSON.stringify(event, null, 2)}`);

  // 群組／聊天室共用同一份綁定與偏好（刻意的設計，讓大家都能記同一本帳），
  // 但每次互動仍要看得出是誰做的。
  const speakerUserId: string | null = event.source.userId ?? null
  let memberName = "未知";
  // postback 也要查：存檔確認訊息是在 postback 分支送出的，
  // 少了這個就會顯示「由 未知 記錄」。
  // 語音也要查（M15）：轉錄出來的文字會走完整的記帳流程，
  // 「我付的晚餐 300」一樣要對得到人。
  const needsMemberName =
    (event.type === 'message'
      && (event.message?.type === 'text' || event.message?.type === 'image' || event.message?.type === 'audio'))
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

  // 一次查、整個 event 共用。
  let draftsCache: OutstandingDraft[] | null = null
  const loadDrafts = async (): Promise<OutstandingDraft[]> => {
    if (!draftsCache) draftsCache = await getOutstandingDrafts(sourceId)
    return draftsCache
  }

  return {
    sourceId,
    sourceType,
    isGroup,
    replyToken,
    speakerUserId,
    memberName,
    speakerLabel,
    userState: userState as UserStateRow,
    isBound,
    isBinding,
    mentionRequired,
    boundQR,
    loadDrafts,
  }
}
