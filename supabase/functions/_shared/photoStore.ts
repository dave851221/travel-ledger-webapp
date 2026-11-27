// ============================================================
// _shared/photoStore.ts —— 照片放在哪裡（Supabase Storage 或 Cloudflare R2）
//
// 舊版（旅遊小本本）：Supabase Storage 的公開 bucket travel-images，照舊。
// 開放版（旅行小本本）：Cloudflare R2 的私有 bucket（David 2026-11-27：讓 Supabase 維持免費方案），
//   每張照片在 app.trip_photos 記一列（算張數上限用），上傳／刪除時一起維護。
// 呼叫端（LINE 機器人、網頁聊天、tlb-photos）只認得 PhotoStore，不必知道是哪一種。
// ============================================================

import { AwsClient, type SupabaseClient } from "./deps.ts"

export interface PhotoStore {
  /** 上傳（path 例如 expenses/{tripId}/x.jpg）；createdBy＝誰傳的（開放版記在 trip_photos） */
  upload(path: string, body: ArrayBuffer | Uint8Array | Blob, contentType: string, createdBy?: string | null): Promise<void>
  /** 讀回檔案內容（給 AI 讀收據） */
  download(path: string): Promise<ArrayBuffer>
  /** 刪除（找不到的檔案略過） */
  remove(paths: string[]): Promise<void>
  /** 看得到照片的網址：舊版公開網址，開放版簽名網址（ttlSeconds 秒內有效） */
  viewUrl(path: string, ttlSeconds: number): Promise<string>
  /** 刪掉一整趟旅程的照片（expenses/{tripId}/ 底下全部） */
  removeTrip(tripId: string): Promise<void>
}

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

const tripIdOf = (path: string): string | null => {
  const m = /^expenses\/([0-9a-f-]{36})\/[^/]+$/.exec(path)
  return m ? m[1] : null
}

/** 開放版：Cloudflare R2。db 是指向 app schema 的 service role client（維護 trip_photos） */
export function createR2Store(cfg: R2Config, db: SupabaseClient): PhotoStore {
  const client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto' })
  const base = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`
  const url = (path: string) => `${base}/${path.split('/').map(encodeURIComponent).join('/')}`

  return {
    async upload(path, body, contentType, createdBy) {
      const tripId = tripIdOf(path)
      if (!tripId) throw new Error('invalid_photo_path')
      const res = await client.fetch(url(path), { method: 'PUT', body: body as BodyInit, headers: { 'Content-Type': contentType } })
      if (!res.ok) throw new Error(`r2_put_${res.status}`)
      const bytes = body instanceof Blob ? body.size : body.byteLength
      const { error } = await db.from('trip_photos').upsert({ path, trip_id: tripId, created_by: createdBy ?? null, bytes }, { onConflict: 'path' })
      if (error) console.error('[PHOTO] trip_photos insert failed', error.message)
    },
    async download(path) {
      const res = await client.fetch(url(path))
      if (!res.ok) throw new Error(`r2_get_${res.status}`)
      return await res.arrayBuffer()
    },
    async remove(paths) {
      const valid = paths.filter(p => tripIdOf(p))
      await Promise.all(valid.map(async p => {
        const res = await client.fetch(url(p), { method: 'DELETE' })
        if (!res.ok && res.status !== 404) console.error('[PHOTO] r2 delete failed', res.status)
      }))
      if (valid.length > 0) await db.from('trip_photos').delete().in('path', valid)
    },
    async viewUrl(path, ttlSeconds) {
      const signed = await client.sign(new Request(`${url(path)}?X-Amz-Expires=${ttlSeconds}`), { aws: { signQuery: true } })
      return signed.url
    },
    async removeTrip(tripId) {
      // 照表上的清單刪，再列一次 R2 的資料夾補刪表上沒有的（例如上傳到一半的）
      const { data } = await db.from('trip_photos').select('path').eq('trip_id', tripId)
      const paths = new Set(((data ?? []) as { path: string }[]).map(r => r.path))
      const prefix = `expenses/${tripId}/`
      for (let round = 0; round < 20; round++) {
        const res = await client.fetch(`${base}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`)
        if (!res.ok) break
        const xml = await res.text()
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) paths.add(m[1].replace(/&amp;/g, '&'))
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break
        // 還有下一頁：先刪掉這一頁，下一輪重新列
        await this.remove([...paths])
        paths.clear()
      }
      await this.remove([...paths])
      await db.from('trip_photos').delete().eq('trip_id', tripId)
    },
  }
}

/** 舊版：Supabase Storage（公開 bucket 給公開網址；私有 bucket 給簽名網址） */
export function createSupabaseStore(db: SupabaseClient, bucket: string, isPublicBucket: boolean): PhotoStore {
  return {
    async upload(path, body, contentType) {
      const { error } = await db.storage.from(bucket).upload(path, body, { contentType, upsert: true })
      if (error) throw error
    },
    async download(path) {
      const { data, error } = await db.storage.from(bucket).download(path)
      if (error || !data) throw error ?? new Error('photo_not_found')
      return await data.arrayBuffer()
    },
    async remove(paths) {
      if (paths.length > 0) await db.storage.from(bucket).remove(paths)
    },
    async viewUrl(path, ttlSeconds) {
      if (isPublicBucket) return db.storage.from(bucket).getPublicUrl(path).data.publicUrl
      const { data } = await db.storage.from(bucket).createSignedUrl(path, ttlSeconds)
      return data?.signedUrl ?? ''
    },
    async removeTrip(tripId) {
      const prefix = `expenses/${tripId}`
      for (let round = 0; round < 50; round++) {
        const { data, error } = await db.storage.from(bucket).list(prefix, { limit: 100 })
        if (error || !data || data.length === 0) return
        const { error: rmErr } = await db.storage.from(bucket).remove(data.map(f => `${prefix}/${f.name}`))
        if (rmErr) return
      }
    },
  }
}

/** 從環境變數讀 R2 設定；缺任何一個就回 null（呼叫端退回 Supabase Storage） */
export function r2ConfigFromEnv(get: (k: string) => string | undefined): R2Config | null {
  const accountId = get('R2_ACCOUNT_ID')
  const accessKeyId = get('R2_ACCESS_KEY_ID')
  const secretAccessKey = get('R2_SECRET_ACCESS_KEY')
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  return { accountId, accessKeyId, secretAccessKey, bucket: get('R2_BUCKET') || 'tlb-photos' }
}
