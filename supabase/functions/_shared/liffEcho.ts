// ============================================================
// _shared/liffEcho.ts —— LIFF 存檔後，用「使用者自己送出的一句話」換機器人的免費回覆
//
// LIFF 沒有 replyToken，以前存完一律用推播（push）送確認訊息。推播在免費方案每月有上限，
// 推給群組時每位成員各算一則，2026-11-19 就用完了。
//
// 現在的做法：
//   1. liff-notify 算好完整確認訊息，存成一列 `liff_notice`（line_chat_history），回傳一句短的「暗號」。
//   2. LIFF 頁面用 liff.sendMessages() 以使用者的名義把暗號送進聊天室（不算推播額度）。
//   3. line-webhook 收到這句話（不論群組模式），找到對應的 `liff_notice`，用 replyToken 回完整確認。
// 送不出去（不在 LINE 裡、沒授權）時，LIFF 頁面再叫 liff-notify 用推播送，跟以前一樣。
// ============================================================

export const LIFF_NOTICE_ROLE = 'liff_notice'

/** liff_notice 列的內容 */
export interface LiffNotice {
  /** LIFF 送出的那句話，機器人用它對回這一列 */
  marker: string
  /** 完整確認訊息（buildSavedText） */
  text: string
  /** 回覆要帶的快速回覆按鈕（含 ↩️ 撤銷） */
  quickReply?: unknown
}

/** 暗號超過 10 分鐘就不認了（replyToken 本身也只能用一分鐘，這只是防舊列誤配） */
export const LIFF_NOTICE_TTL_MS = 10 * 60 * 1000

const PREFIX_INSERT = '✅ 已記帳'
const PREFIX_UPDATE = '✏️ 已修改'

/**
 * 使用者會在聊天室看到自己送出這一句，只留簡短的「✅ 已記帳」／「✏️ 已修改」，
 * 明細由機器人回覆補上（David 2026-11-20：額度恢復後也維持這個做法，不改回推播）。
 * 同一人短時間存好幾筆時，暗號都一樣，pickLiffNotice 依序配最新的那一列。
 */
export function buildLiffEchoMarker(isUpdate: boolean): string {
  return isUpdate ? PREFIX_UPDATE : PREFIX_INSERT
}

/** 只用開頭判斷，一般訊息不必為了這個多查一次資料庫 */
export function looksLikeLiffEcho(text: string): boolean {
  const t = text.trim()
  return t.startsWith(PREFIX_INSERT) || t.startsWith(PREFIX_UPDATE)
}

/** 從最近幾列 liff_notice 裡挑出暗號對得上、還沒過期的那一列 */
export function pickLiffNotice(
  rows: { id: number; content: string; created_at: string }[],
  text: string,
  now: number,
): { id: number; notice: LiffNotice } | null {
  const want = text.trim()
  for (const row of rows) {
    if (now - Date.parse(row.created_at) > LIFF_NOTICE_TTL_MS) continue
    try {
      const notice = JSON.parse(row.content) as LiffNotice
      if (notice && typeof notice.text === 'string' && String(notice.marker ?? '').trim() === want) {
        return { id: row.id, notice }
      }
    } catch { /* skip malformed */ }
  }
  return null
}

/**
 * LIFF 頁的網址。有 LIFF ID 時走 liff.line.me（路由放在 `route` 參數，前端 src/utils/liff.ts 轉回 hash），
 * 沒有時照舊直接開 GitHub Pages 的 `#/liff/...`（那樣沒有 LIFF 環境，不能代送訊息）。
 */
export function buildLiffPageUrl(route: string, query: string, liffId: string, webappUrl: string): string {
  return liffId
    ? `https://liff.line.me/${liffId}?route=${route}&${query}`
    : `${webappUrl}/#${route}?${query}`
}
