// ============================================================
// db.ts —— service-role 的 Supabase client 單例
//
// service role 會繞過 RLS，這支函式本來就得代所有使用者讀寫。
// 單獨一個模組是為了讓其他模組共用同一個連線，而不是各自 createClient；
// createClient 從 _shared/deps.ts 拿，測試時才換得成 npm 版（見 vitest.config.ts）。
// ============================================================

import { createClient } from "../_shared/deps.ts"
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.ts"

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * 佔用一個 webhook 事件。回傳 false 代表這個事件已經處理過（LINE 重送的第二份），呼叫端要略過。
 *
 * LINE 在 webhook 沒及時回 200 時會用同一個 webhookEventId 重送；AI 與 OCR 常常超過它的等待時間，
 * 不擋的話同一句話會被回兩次、記帳卡出兩張。
 * 只有 PK 衝突（23505）才算重複 —— 資料表不存在或連線出錯時照常處理，寧可偶爾重複也不要漏掉訊息。
 */
export async function claimWebhookEvent(eventId: string | undefined): Promise<boolean> {
  if (!eventId) return true
  const { error } = await supabase.from('line_webhook_events').insert({ event_id: eventId })
  if (!error) return true
  if (error.code === '23505') return false
  console.warn('[EVENT_DEDUP] Could not record event id, processing anyway:', error.message)
  return true
}
