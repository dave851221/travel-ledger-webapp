import { useCallback } from 'react';
import { supabase } from '../api/supabase';
import { RECEIPTS_BUCKET } from '../utils/storage';

type ShowToast = (message: string, type?: 'success' | 'error') => void;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 垃圾桶的四個動作：軟刪除、還原、永久刪除、清空。
 *
 * 永久刪除與清空都必須「先清 Storage 再刪資料庫」——
 * 一旦紀錄消失就再也查不出該刪哪些照片，那些檔案會變成 bucket 裡的孤兒。
 * 同樣的順序也適用於整個旅程的刪除，見 supabase/scripts/delete_trip.sql。
 */
export const useTrash = (tripId: string | undefined, showToast: ShowToast) => {
  /** 軟刪除：壓上 deleted_at，24 小時內可還原 */
  const softDelete = useCallback(async (expenseId: string) => {
    if (!supabase) return false;
    try {
      const { error } = await supabase
        .from('expenses')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', expenseId);
      if (error) throw error;
      showToast('紀錄已移至垃圾桶');
      return true;
    } catch (err) {
      showToast('刪除失敗: ' + errorMessage(err), 'error');
      return false;
    }
  }, [showToast]);

  const restore = useCallback(async (expenseId: string) => {
    if (!supabase) return false;
    try {
      const { error } = await supabase
        .from('expenses')
        .update({ deleted_at: null })
        .eq('id', expenseId);
      if (error) throw error;
      showToast('紀錄已還原');
      return true;
    } catch (err) {
      showToast('還原失敗: ' + errorMessage(err), 'error');
      return false;
    }
  }, [showToast]);

  const permanentlyDelete = useCallback(async (expenseId: string) => {
    if (!supabase) return false;
    try {
      // 1. 先取回照片路徑 —— 刪掉紀錄後就查不到了
      const { data: exp, error: fetchError } = await supabase
        .from('expenses')
        .select('photo_urls')
        .eq('id', expenseId)
        .single();
      if (fetchError) throw fetchError;

      // 2. 清 Storage
      if (exp?.photo_urls && exp.photo_urls.length > 0) {
        const { error: storageError } = await supabase.storage
          .from(RECEIPTS_BUCKET)
          .remove(exp.photo_urls);
        if (storageError) console.error('照片刪除失敗:', storageError);
      }

      // 3. 再刪紀錄
      const { error } = await supabase.from('expenses').delete().eq('id', expenseId);
      if (error) throw error;

      showToast('紀錄已永久刪除');
      return true;
    } catch (err) {
      showToast('刪除失敗: ' + errorMessage(err), 'error');
      return false;
    }
  }, [showToast]);

  const emptyTrash = useCallback(async () => {
    if (!supabase || !tripId) return false;
    try {
      // 1. 先收集垃圾桶內所有照片路徑
      const { data: exps, error: fetchError } = await supabase
        .from('expenses')
        .select('photo_urls')
        .eq('trip_id', tripId)
        .not('deleted_at', 'is', null);
      if (fetchError) throw fetchError;

      const allPhotoUrls = (exps || [])
        .flatMap((exp: { photo_urls: string[] | null }) => exp.photo_urls || [])
        .filter((url: string) => !!url);

      // 2. 整批清 Storage
      if (allPhotoUrls.length > 0) {
        const { error: storageError } = await supabase.storage
          .from(RECEIPTS_BUCKET)
          .remove(allPhotoUrls);
        if (storageError) console.error('整批照片刪除失敗:', storageError);
      }

      // 3. 再刪紀錄
      const { error } = await supabase
        .from('expenses')
        .delete()
        .eq('trip_id', tripId)
        .not('deleted_at', 'is', null);
      if (error) throw error;

      showToast('垃圾桶已完全清空');
      return true;
    } catch (err) {
      showToast('清空失敗: ' + errorMessage(err), 'error');
      return false;
    }
  }, [tripId, showToast]);

  return { softDelete, restore, permanentlyDelete, emptyTrash };
};
