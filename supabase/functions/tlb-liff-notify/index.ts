// ============================================================
// tlb-liff-notify —— 開放版 LIFF 存檔後，讓旅行喵喵在聊天室回確認
//
// 跟舊版 liff-notify 同一份程式；開放版用旅行喵喵的金鑰、寫 app schema，
// 而且要登入、是那筆支出那趟的成員、聊天室綁的也是那趟才會送（liff-notify/index.ts 的 authorize）。
// 部署：supabase functions deploy tlb-liff-notify（預設驗 JWT）
// ============================================================

import "./mode.ts"
import "../liff-notify/index.ts"
