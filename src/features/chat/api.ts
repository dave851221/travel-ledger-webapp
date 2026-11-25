/**
 * 呼叫 Edge Function `web-chat`。一個請求等一個完整的答案（不先回再背景處理）。
 */
import imageCompression from 'browser-image-compression';
import { supabase } from '../../api/supabase';
import { RECEIPTS_BUCKET } from '../../utils/storage';
import { ASSISTANT_NAME } from '../../config/assistant';
import type { ActionReply, ChatReply, DraftExpense, HistoryTurn, ReplyTarget, WebDraft } from './types';

type Base = { tripId: string; memberName: string | null };

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('web-chat', { body });
  if (error) {
    // 離線或函式掛了：給一句看得懂的話，不要把 FunctionsFetchError 原文丟給使用者
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new Error(offline ? '目前離線，連上網路後再試一次。' : `${ASSISTANT_NAME}暫時連不上，請稍後再試。`);
  }
  return data as T;
}

export const sendMessage = (b: Base & { text: string; history: HistoryTurn[]; drafts: WebDraft[]; replyTo?: ReplyTarget | null }) =>
  invoke<ChatReply>({ action: 'message', ...b });

export const sendPhoto = (b: Base & { photoPath: string }) =>
  invoke<ChatReply>({ action: 'photo', ...b });

export const saveDraft = (b: Base & { draft: WebDraft }) =>
  invoke<ActionReply>({ action: 'save', ...b });

export const applyUpdate = (b: Base & { expenseId: string; exp: DraftExpense }) =>
  invoke<ActionReply>({ action: 'update', ...b });

export const deleteExpense = (b: Base & { expenseId: string; undo?: boolean }) =>
  invoke<ActionReply>({ action: b.undo ? 'undo' : 'delete', tripId: b.tripId, memberName: b.memberName, expenseId: b.expenseId });

export const discardPhotos = (b: Base & { photoIds: string[] }) =>
  invoke<ActionReply>({ action: 'discard', ...b });

/**
 * 壓縮後上傳到 Storage，回傳路徑。規格與 ExpenseModal 相同（0.5 MB、長邊 1280），
 * 辨識收據用這個大小就讀得清楚，也不會把 Storage 塞滿。
 */
export async function uploadChatPhoto(tripId: string, file: File): Promise<string> {
  const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1280, useWebWorker: true, fileType: 'image/jpeg' };
  let compressed: Blob;
  try {
    compressed = await imageCompression(file, options);
  } catch {
    // HEIC／HEIF（iPhone、三星高效率照片）Chrome 讀不了：先轉 JPEG 再壓（轉檔程式只有這時才下載）
    const { readLocalPhoto } = await import('../recap/images');
    const jpeg = await readLocalPhoto(file);
    compressed = await imageCompression(new File([jpeg], 'photo.jpg', { type: 'image/jpeg' }), options);
  }
  const path = `expenses/${tripId}/chat_${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(RECEIPTS_BUCKET).upload(path, compressed, { contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}
