// ============================================================
// tlb-line-webhook —— 開放版（旅行小本本）的 LINE 機器人「旅行喵喵」
//
// 跟舊版的耀西（line-webhook）是同一份程式，開放版的差別集中在：
//   · 設定（line-webhook/config.ts 的 IS_PUBLIC）：LINE 金鑰 TLB_BOT_*、資料在 app schema、
//     私有照片 bucket、網址 /next/、沒有 LIFF
//   · 人設（_shared/assistant/persona.ts）：旅行喵喵，群組裡用「喵喵」叫它
//   · 綁定（line-webhook/handlers/bind-public.ts）：輸入「綁定」選自己是成員的旅程，不用代碼與密碼
//   · 額度（line-webhook/quota.ts）：叫 AI 前先扣這趟的次數，照片也有張數上限
//
// 部署：supabase functions deploy tlb-line-webhook --no-verify-jwt
// secrets：TLB_BOT_CHANNEL_SECRET、TLB_BOT_ACCESS_TOKEN（其餘 AI 金鑰與舊版共用）
// ============================================================

import "./mode.ts"
import "../line-webhook/index.ts"
