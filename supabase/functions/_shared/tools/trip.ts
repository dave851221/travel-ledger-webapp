// ============================================================
// tools/trip.ts —— 這趟旅程長什麼樣子
//
// 旅程本身已經在 ToolContext 裡（呼叫端查權限時就查過了），
// 所以這支不查資料庫，只負責挑出「AI 或 MCP 客戶端該知道的欄位」
// 並換成穩定的對外名稱。
//
// ⚠️ 刻意不輸出 `access_code` —— 通行碼永遠不離開伺服器。
// ============================================================

import type { ToolContext, TripInfo } from "./types.ts"

export function getTrip(ctx: ToolContext): TripInfo {
  const trip = ctx.trip
  return {
    id: trip.id,
    name: trip.name,
    members: trip.members ?? [],
    categories: trip.categories ?? [],
    baseCurrency: trip.base_currency,
    // 記帳預設幣別與結算主幣是兩回事：前者是「這筆花的是什麼錢」，
    // 後者只用於統計時的折算（T3 的根源就是模型分不清這兩個）
    defaultCurrency: trip.default_currency || trip.base_currency,
    defaultCategory: trip.default_category ?? null,
    defaultPayer: trip.default_payer ?? [],
    defaultSplitMembers: trip.default_split_members ?? [],
    rates: trip.rates ?? {},
    precision: trip.precision_config ?? {},
    timezone: trip.timezone ?? null,
    today: ctx.today,
    isArchived: !!trip.is_archived,
    aiPreference: trip.ai_preference ?? null,
  }
}
