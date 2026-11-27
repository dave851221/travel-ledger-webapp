/**
 * 照片的上傳與刪除。
 * 舊版：Supabase Storage 的公開 bucket travel-images（照舊）。
 * 開放版：Cloudflare R2 的私有 bucket（David 2026-11-27：讓 Supabase 維持免費方案），
 *   網頁不直接碰 R2，一律經過 Edge Function tlb-photos（要登入、是成員；照片張數上限也在那裡擋）。
 * 看照片的簽名網址在 signedPhotos.ts。
 */
import { supabase } from '../api/supabase';
import { IMAGES_BUCKET, IS_PUBLIC } from '../config/mode';

const FN = 'tlb-photos';

/** 開放版：叫 tlb-photos 的 JSON 動作（sign／remove／remove_trip） */
export async function invokePhotos<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(FN, { body });
  if (error) throw error;
  return data as T;
}

const imageType = (file: Blob): string =>
  /^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.type) ? file.type : 'image/jpeg';

/**
 * 上傳一張照片，回傳存在 photo_urls 的路徑（expenses/{tripId}/…）。
 * kind 'chat'：網頁聊天的收據（檔名 chat_ 開頭，取消草稿時才認得出來可以刪）。
 * 超過照片張數上限時丟出含 photo_limit 的錯誤（quotaMessage 會翻成中文）。
 */
export async function uploadPhoto(tripId: string, file: Blob, kind: 'chat' | 'expense' = 'expense', name?: string): Promise<string> {
  if (!IS_PUBLIC) {
    const ext = (name?.split('.').pop() || 'jpg').toLowerCase();
    const path = `expenses/${tripId}/${kind === 'chat' ? 'chat_' : ''}${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from(IMAGES_BUCKET).upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (error) throw error;
    return path;
  }
  const { data: { session } } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${FN}?action=upload&tripId=${encodeURIComponent(tripId)}&kind=${kind}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': imageType(file),
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? ''}`,
    },
    body: file,
  });
  const out = await res.json().catch(() => ({})) as { path?: string; error?: string };
  if (!res.ok || !out.path) throw new Error(out.error === 'photo_limit' ? 'photo_limit' : `照片上傳失敗（${out.error ?? res.status}）`);
  return out.path;
}

/** 刪掉照片（找不到的略過）。開放版只刪得到自己是成員的旅程裡的照片 */
export async function removePhotos(paths: string[]): Promise<void> {
  const list = paths.filter(Boolean);
  if (list.length === 0) return;
  if (!IS_PUBLIC) {
    const { error } = await supabase.storage.from(IMAGES_BUCKET).remove(list);
    if (error) throw error;
    return;
  }
  for (let i = 0; i < list.length; i += 200) await invokePhotos({ action: 'remove', paths: list.slice(i, i + 200) });
}

/**
 * 一趟旅程的照片全部刪掉（expenses/{tripId}/）。
 * 刪旅程、刪帳號之前先刪：資料列刪掉之後就沒有權限碰那些檔案了，會變成沒人用的檔案。開放版只有 owner 能刪。
 */
export async function removeTripPhotos(tripId: string): Promise<void> {
  if (IS_PUBLIC) {
    await invokePhotos({ action: 'remove_trip', tripId }).catch(e => console.error('[PHOTO] remove trip photos failed', e));
    return;
  }
  const prefix = `expenses/${tripId}`;
  for (let round = 0; round < 50; round++) {
    const { data, error } = await supabase.storage.from(IMAGES_BUCKET).list(prefix, { limit: 100 });
    if (error || !data || data.length === 0) return;
    const { error: rmErr } = await supabase.storage.from(IMAGES_BUCKET).remove(data.map(f => `${prefix}/${f.name}`));
    if (rmErr) return;
  }
}
