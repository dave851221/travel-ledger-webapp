import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  try {
    const { line_user_id, expense_id, description, amount, currency } = await req.json()

    if (!line_user_id || !description) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // 記錄到 chat_history，讓「撤銷上一筆」文字指令可以運作
    await supabase.from('line_chat_history').insert({
      line_user_id,
      role: 'saved',
      content: JSON.stringify({ expense_id, description })
    })

    // 建立快速回覆（含撤銷按鈕）
    const quickReplyItems: any[] = []
    if (expense_id) {
      quickReplyItems.push({
        type: "action",
        action: { type: "postback", label: "↩️ 撤銷", data: JSON.stringify({ act: "undo", eid: expense_id, d: description }) }
      })
    }
    quickReplyItems.push(
      { type: "action", action: { type: "message", label: "📅 今日支出", text: "今日支出" } },
      { type: "action", action: { type: "message", label: "📊 本月支出", text: "本月支出" } },
      { type: "action", action: { type: "message", label: "💰 結算", text: "結算" } }
    )

    // LINE push 推播確認訊息
    const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({
        to: line_user_id,
        messages: [{
          type: 'text',
          text: `✅ 已透過 LIFF 存入：${description}\n💰 ${amount} ${currency}`,
          quickReply: { items: quickReplyItems }
        }]
      })
    })

    if (!pushRes.ok) {
      const errText = await pushRes.text()
      console.error('[LIFF_NOTIFY] LINE push error:', errText)
      return new Response(JSON.stringify({ error: 'LINE push failed', detail: errText }), {
        status: 502, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    console.error('[LIFF_NOTIFY_ERROR]', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})
