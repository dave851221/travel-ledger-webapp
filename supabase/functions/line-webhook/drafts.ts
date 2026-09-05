// ============================================================
// drafts.ts —— 「還等在聊天室裡」的記帳草稿
//
// 草稿的完整內容存在 line_chat_history 的 pending 列（postback 只帶 nonce，
// 因為 postback data 有 300 bytes 上限），失效與防重複點擊則共用
// line_processed_actions 這張表 —— 詳見各函式的註解。
//
// import config.ts（bucket 名稱）與 db.ts。
// ============================================================

import { RECEIPTS_BUCKET } from "./config.ts"
import { supabase } from "./db.ts"
import type { DraftExpense, PendingDraft } from "./types.ts"

/** 一張還等在聊天室裡、使用者既沒確認也沒取消的記帳草稿 */
export interface OutstandingDraft {
  nonce: string
  exp: DraftExpense
  photoIds: string[]
  tripId: string
}

/** 一次看多少張 pending 卡。修改／刪除的確認卡也佔位子，所以比原本的 5 張寬鬆。 */
const OUTSTANDING_SCAN_LIMIT = 10

/**
 * 取出這個聊天目前「還沒被處理」的**記帳**草稿（最新的在前）。
 *
 * 「還沒被處理」＝ nonce 不在 line_processed_actions 裡，
 * 也就是使用者既沒按確認存入、也沒按取消，那張卡片還等在聊天室裡。
 *
 * 以前只找「有收據照片」的那一張，因為唯一的用途是逐項重新分帳。
 * 現在還要用來判斷「剛剛那筆改 500」「取消」指的是哪一張卡片，
 * 所以一律回傳，帶不帶照片由呼叫端自己篩。
 *
 * ⚠️ **只回 `kind` 為空或 `expense` 的列**。修改／刪除的確認卡也存在同一張表，
 *    但它們不是草稿：被當成草稿的話，使用者打「取消」會取消到一張修改卡，
 *    AI 也會拿它的 nonce 去填 `corrects_draft`，接著整張卡就無聲失效了。
 */
export async function getOutstandingDrafts(sourceId: string): Promise<OutstandingDraft[]> {
  const { data: rows } = await supabase.from('line_chat_history')
    .select('content')
    .eq('line_user_id', sourceId)
    .eq('role', 'pending')
    .order('created_at', { ascending: false })
    .limit(OUTSTANDING_SCAN_LIMIT)
  if (!rows || rows.length === 0) return []

  const candidates: OutstandingDraft[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.content)
      const photoIds = Array.isArray(parsed.p) ? parsed.p : []
      const kind = parsed.kind ?? 'expense'
      if (parsed.n && kind === 'expense') {
        candidates.push({ nonce: parsed.n, exp: parsed.exp, photoIds, tripId: parsed.tid })
      }
    } catch { /* skip malformed */ }
  }
  if (candidates.length === 0) return []

  const { data: used } = await supabase.from('line_processed_actions')
    .select('nonce')
    .in('nonce', candidates.map(c => c.nonce))
  const usedSet = new Set((used ?? []).map((u: { nonce: string }) => u.nonce))

  return candidates.filter(c => !usedSet.has(c.nonce))
}

/** 由 photo id 或路徑組出 Storage 的公開網址 */
export function photoPublicUrl(photoId: string, tripId: string): string {
  const path = String(photoId).includes('/') ? String(photoId) : `expenses/${tripId}/${photoId}.jpg`
  const { data } = supabase.storage.from(RECEIPTS_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

/**
 * 讓指定的幾張草稿卡片失效。
 *
 * 做法是把 nonce 直接塞進 line_processed_actions ——
 * 那正是防重複點擊用的鎖，所以舊按鈕會走到既有的「此操作已處理過」分支，
 * 不必另外設計一套失效機制。`action_type` 記成 `superseded`，
 * 好讓 postback 分支能分辨「被取代」與「你剛剛已經按過了」。
 */
export async function markDraftsSuperseded(sourceId: string, nonces: string[]): Promise<void> {
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
export async function releaseNonce(nonce: string | null | undefined): Promise<void> {
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
export async function supersedeDraft(sourceId: string, nonce: string): Promise<void> {
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
export async function supersedeAllDrafts(sourceId: string): Promise<void> {
  const drafts = await getOutstandingDrafts(sourceId)
  await markDraftsSuperseded(sourceId, drafts.map(d => d.nonce))
}

/**
 * 取消一張草稿：讓卡片失效，並把已上傳的收據照片清掉。
 *
 * 卡片上的「❌ 取消」按鈕與文字指令「取消」都走這裡，兩邊行為才會一致。
 */
export async function cancelDraft(
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

// 將待確認支出暫存於 chat_history，讓 postback 只傳 nonce（避免 300 bytes 上限）
export async function storePendingExpense(sourceId: string, nonce: string, data: Omit<PendingDraft, 'n'>) {
  await supabase.from('line_chat_history').insert({
    line_user_id: sourceId,
    role: 'pending',
    content: JSON.stringify({ n: nonce, ...data })
  })
}

/**
 * 依 nonce 取回一張 pending 卡的完整內容。
 *
 * ⚠️ 與 `getOutstandingDrafts()` 不同，這裡**不**過濾 `kind` ——
 *    `act: 'upd'` 與 `act: 'del'` 要靠它讀回修改／刪除卡的 `eid` 與 `exp`。
 */
export async function getPendingExpense(sourceId: string, nonce: string): Promise<PendingDraft | null> {
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
