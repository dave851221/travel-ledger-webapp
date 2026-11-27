// ============================================================
// tlb-web-chat —— 開放版（旅行小本本）網頁上跟旅行喵喵聊天記帳
//
// 跟舊版 web-chat 同一份程式；開放版：要登入、是這趟的成員（web-chat/auth.ts），
// 資料在 app schema、私有照片 bucket，每次叫 AI 先扣這趟的次數（web-chat/handlers.ts 的 chargeAi）。
// 部署：supabase functions deploy tlb-web-chat --no-verify-jwt（身分由 auth.ts 自己驗）
// ============================================================

import "./mode.ts"
import "../web-chat/index.ts"
