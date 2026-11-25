// ============================================================
// web-chat —— 網頁上跟耀西聊天記帳（文字、收據照片）
//
// 一個 POST、一個 action，同步回答（不「先回再背景處理」）：
//   message  文字 → AI → 回覆文字與卡片（blocks）
//   photo    收據照片（網頁已上傳到 Storage）→ OCR → 記帳卡
//   save / update / delete / undo   使用者按了卡片上的按鈕才寫
//   discard  取消草稿：刪掉那張照片
//
// AI 的判斷與驗證跟 LINE 共用 `_shared/assistant/`，見 handlers.ts 開頭。
// 對話紀錄與草稿存在使用者的瀏覽器，這支函式不寫任何聊天狀態到資料庫（Disk IO）。
//
// 部署：supabase functions deploy web-chat --no-verify-jwt
//   （網頁用的是 publishable key，不是 JWT；誰能用哪一趟旅程由 auth.ts 決定）
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient, type SupabaseClient } from "../_shared/deps.ts"
import { APP_DB_SCHEMA, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "./config.ts"
import { authorizeTrip } from "./auth.ts"
import { handleDelete, handleDiscard, handleMessage, handlePhoto, handleSave, handleUpdate } from "./handlers.ts"
import type { ChatRequest } from "./payload.ts"

// schema 由環境變數決定（開放版用另一個 schema）。型別上一律當成預設 client，工具層只認得這個型別
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { db: { schema: APP_DB_SCHEMA } }) as unknown as SupabaseClient

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const auth = await authorizeTrip(db, req, body?.tripId)
  if (!auth.ok) return json({ error: auth.error }, auth.status)
  // 開放版由登入決定是誰，不再相信前端送的名字（見 auth.ts）
  if (auth.memberName) body.memberName = auth.memberName
  const scope = { db, trip: auth.trip }

  const started = Date.now()
  try {
    switch (body.action) {
      case 'message': return json(await handleMessage(scope, body))
      case 'photo': return json(await handlePhoto(scope, body))
      case 'save': return json(await handleSave(scope, body))
      case 'update': return json(await handleUpdate(scope, body))
      case 'delete': return json(await handleDelete(scope, body, 'delete'))
      case 'undo': return json(await handleDelete(scope, body, 'undo'))
      case 'discard': return json(await handleDiscard(scope, body))
      default: return json({ error: 'unknown_action' }, 400)
    }
  } catch (e) {
    console.error(`[WEB_CHAT] ${body.action} failed`, e)
    return json({ error: 'internal_error' }, 500)
  } finally {
    console.log(`[WEB_CHAT] ${body.action} trip=${auth.trip.id} ${Date.now() - started}ms`)
  }
})
