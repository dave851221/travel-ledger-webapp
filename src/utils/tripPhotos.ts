import { supabase } from '../api/supabase';
import { RECEIPTS_BUCKET } from './storage';

/**
 * 一趟旅程的照片全部從 Storage 刪掉（expenses/{tripId}/）。
 * 刪旅程、刪帳號之前先刪：資料列刪掉之後就沒有權限碰那些檔案了，會變成沒人用的檔案。
 */
export async function removeTripPhotos(tripId: string): Promise<void> {
  const prefix = `expenses/${tripId}`;
  for (let round = 0; round < 50; round++) {
    const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).list(prefix, { limit: 100 });
    if (error || !data || data.length === 0) return;
    const { error: rmErr } = await supabase.storage.from(RECEIPTS_BUCKET).remove(data.map(f => `${prefix}/${f.name}`));
    if (rmErr) return;
  }
}
