// ============================================================
// tlb-line-webhook —— 開放版（旅行小本本）的 LINE 機器人「旅行喵喵」
//
// 舊版的耀西是 line-webhook，資料在 public；這支只服務旅行喵喵，資料會在 app schema。
// 目前是第一版：驗簽、回一句「準備中」，讓 LINE 後台的 Webhook 可以先設定、驗證。
// 完整的記帳功能（綁定旅程、文字／收據記帳）接著做，會沿用 _shared/assistant/ 的同一顆腦。
//
// 部署：supabase functions deploy tlb-line-webhook --no-verify-jwt
// secrets：TLB_BOT_CHANNEL_SECRET、TLB_BOT_ACCESS_TOKEN
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts"

const CHANNEL_SECRET = Deno.env.get('TLB_BOT_CHANNEL_SECRET') || ''
const ACCESS_TOKEN = Deno.env.get('TLB_BOT_ACCESS_TOKEN') || ''

/** LINE 的簽章：HMAC-SHA256(channel secret, 原始 body) 的 base64 */
async function validSignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature || !CHANNEL_SECRET) return false
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const expected = btoa(String.fromCharCode(...mac))
  // 長度不同直接不符；相同時逐字比較，不提早結束
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

async function reply(replyToken: string, text: string): Promise<void> {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
  if (!res.ok) console.error('[TLB_BOT] reply failed', res.status)
}

const COMING_SOON = '喵～我是旅行喵喵 🐱\n記帳功能還在準備中，很快就能在這裡拍收據、打字記帳了！\n\n現在可以先到網頁版建立旅程：\nhttps://dave851221.github.io/travel-ledger-webapp/next/'

serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok')
  const body = await req.text()
  if (!(await validSignature(body, req.headers.get('x-line-signature')))) {
    return new Response('invalid signature', { status: 401 })
  }

  let events: Array<{ type?: string; replyToken?: string }> = []
  try {
    events = JSON.parse(body)?.events ?? []
  } catch {
    return new Response('bad request', { status: 400 })
  }

  // LINE 後台的「Verify」送的是空的 events，回 200 就算通過
  await Promise.all(events.map(async (ev) => {
    if (!ev.replyToken) return
    if (ev.type === 'message' || ev.type === 'follow' || ev.type === 'join') {
      await reply(ev.replyToken, COMING_SOON)
    }
  }))
  console.log(`[TLB_BOT] ${events.length} event(s)`)
  return new Response('ok')
})
