// 照片放哪裡：舊版 Supabase Storage（travel-images），開放版 Cloudflare R2（見 _shared/photoStore.ts）。
// 開放版沒設 R2 金鑰（例如本機）時退回 Supabase 的 app-images。
import { createR2Store, createSupabaseStore, r2ConfigFromEnv, type PhotoStore } from "../_shared/photoStore.ts"
import { IS_PUBLIC, RECEIPTS_BUCKET } from "./config.ts"
import { supabase } from "./db.ts"

const r2 = IS_PUBLIC ? r2ConfigFromEnv(k => Deno.env.get(k)) : null

export const photos: PhotoStore = r2 ? createR2Store(r2, supabase) : createSupabaseStore(supabase, RECEIPTS_BUCKET, !IS_PUBLIC)
