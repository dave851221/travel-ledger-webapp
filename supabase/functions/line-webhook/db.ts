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
