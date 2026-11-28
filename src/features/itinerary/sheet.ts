/**
 * 開放版：用 Google 試算表排的行程（David 2026-11-27）。
 * 讀取與解析在 Edge Function tlb-itinerary（_shared/sheetItinerary.ts），這裡只負責呼叫、快取在這台裝置、轉成行程頁的格式。
 * 模板與使用說明見 docs/ITINERARY_SHEET.md。
 */
import { supabase } from '../../api/supabase';
import { tripStorageKey } from '../../config/mode';
import type { ItineraryPlan } from './types';

/**
 * 模板的「建立副本」連結（https://docs.google.com/spreadsheets/d/<id>/copy）。
 * 用 David 的「旅行小本本範例」（2026-11-28，京都三天的範例＋下拉選單＋使用說明分頁）；空字串時不顯示「複製模板」。
 * 範例要維持「知道連結的任何人：檢視者」，/copy 才複製得了、別人也改不到原檔。
 */
export const SHEET_TEMPLATE_COPY_URL = 'https://docs.google.com/spreadsheets/d/12LfnaUsjqkc65FIyOfdoRD-3gRRFMwoHHrGE4LtgLew/copy';

export const sheetEditUrl = (sheetId: string) => `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

/** 範例下載成 Excel（不用 Google 帳號也能先看看） */
export const SHEET_TEMPLATE_XLSX_URL = SHEET_TEMPLATE_COPY_URL.replace(/\/copy$/, '/export?format=xlsx');

export type SheetError = 'not_shared' | 'no_itinerary' | 'fetch_failed' | 'no_sheet' | 'invalid_link' | 'network';

export const SHEET_ERROR_TEXT: Record<SheetError, string> = {
  invalid_link: '這看起來不是 Google 試算表的連結，請從試算表上方的網址列整段複製過來。',
  not_shared: '這份試算表還沒開放檢視：請按右上角「共用」，把「一般存取權」改成「知道連結的任何人」。',
  no_itinerary: '讀不到行程：請確認有「行程」這個分頁，而且至少有一列填了日期和行程。',
  fetch_failed: '暫時連不上 Google 試算表，請稍後再試。',
  no_sheet: '這趟還沒有連結試算表。',
  network: '目前連不上網路，請稍後再試。',
};

/** 後端回的行程資料（_shared/tools/types.ts 的 ItineraryDoc） */
type SheetDoc = Omit<ItineraryPlan, 'theme' | 'checklist'> & { checklist?: { items: string[] } };

export const sheetDocToPlan = (doc: SheetDoc, tripId: string): ItineraryPlan => ({
  ...doc,
  theme: 'default',
  checklist: doc.checklist?.items.length ? { storageKey: `sheet_checklist_${tripId}`, items: doc.checklist.items } : undefined,
});

const cacheKey = (tripId: string) => tripStorageKey('sheet_itinerary', tripId);

export interface CachedSheet { sheetId: string; plan: ItineraryPlan; at: number }

export function readCachedSheet(tripId: string, sheetId: string): CachedSheet | null {
  try {
    const raw = localStorage.getItem(cacheKey(tripId));
    const hit = raw ? JSON.parse(raw) as CachedSheet : null;
    return hit && hit.sheetId === sheetId ? hit : null;
  } catch {
    return null;
  }
}

/**
 * 讀試算表。sheet 給了就先試讀那一份（貼連結時檢查用），不給就讀這趟存的。
 * 成功時（讀存好的那份）順便快取在這台裝置，離線也看得到上次的內容。
 */
export async function fetchSheetPlan(
  tripId: string, sheet?: string, share?: { token: string; password: string | null },
): Promise<{ ok: true; plan: ItineraryPlan; sheetId: string } | { ok: false; error: SheetError }> {
  // share：分享頁（沒登入）用分享連結讀這趟存的那份
  const body = share ? { tripId, token: share.token, password: share.password } : sheet ? { tripId, sheet } : { tripId };
  const { data, error } = await supabase.functions.invoke('tlb-itinerary', { body });
  if (error) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return { ok: false, error: offline ? 'network' : 'fetch_failed' };
  }
  const out = data as { doc?: SheetDoc; sheetId?: string; error?: SheetError };
  if (!out.doc || !out.sheetId) return { ok: false, error: out.error ?? 'fetch_failed' };
  const plan = sheetDocToPlan(out.doc, tripId);
  if (!sheet) {
    try { localStorage.setItem(cacheKey(tripId), JSON.stringify({ sheetId: out.sheetId, plan, at: Date.now() } satisfies CachedSheet)); } catch { /* 空間滿了就不快取 */ }
  }
  return { ok: true, plan, sheetId: out.sheetId };
}

/** 試算表網址 → id（規則同 _shared/sheetItinerary.ts 的 sheetIdFromUrl） */
export function sheetIdFromUrl(input: string): string | null {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{30,}$/.test(s) ? s : null;
}
