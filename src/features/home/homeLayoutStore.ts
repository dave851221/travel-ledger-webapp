/**
 * 首頁自訂排序存在哪裡。
 *
 * - 舊版（沒有登入，大家看同一份旅程清單）：資料庫 `public.home_layout` 只有一列（id = 1），
 *   所有人看到同一個順序。按「完成」才寫一次（一列 upsert），平常只多讀這一列 ——
 *   Supabase 免費方案的 Disk IO 很緊，拖曳過程中不寫。
 * - 開放版（每個人看到的旅程不同）：存在登入帳號的 user_metadata（`home_layout`），
 *   換裝置登入也一樣，不必新增資料表。
 *
 * 兩版都在這台裝置留一份快取（`home_layout`，開放版有 tlb: 前綴、換人登入時清掉），首頁先照快取畫。
 * 資料庫還沒有那張表（migration 沒跑）或寫入失敗時，至少這台裝置記得。
 */
import { supabase } from '../../api/supabase';
import { globalStorageKey, IS_PUBLIC } from '../../config/mode';
import { sanitizeLayout, type HomeLayout } from './homeLayout';

const CACHE_KEY = globalStorageKey('home_layout');
const METADATA_KEY = 'home_layout';

export function readCachedLayout(): HomeLayout | null {
  try {
    return sanitizeLayout(JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'));
  } catch {
    return null;
  }
}

function writeCachedLayout(layout: HomeLayout | null): void {
  try {
    if (layout) localStorage.setItem(CACHE_KEY, JSON.stringify(layout));
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* 空間不足或隱私模式：只是少了快取 */ }
}

/**
 * 讀最新的順序。`undefined` 代表讀不到（離線、表還沒建），呼叫端維持手上的快取；
 * `null` 代表確定沒有自訂順序。
 */
export async function fetchLayout(userMetadata?: Record<string, unknown> | null): Promise<HomeLayout | null | undefined> {
  if (IS_PUBLIC) {
    // user_metadata 跟著登入狀態一起來，不必另外查
    if (!userMetadata) return undefined;
    const layout = sanitizeLayout(userMetadata[METADATA_KEY]);
    writeCachedLayout(layout);
    return layout;
  }
  if (!supabase) return undefined;
  try {
    const { data, error } = await supabase.from('home_layout').select('layout').eq('id', 1).maybeSingle();
    if (error) throw error;
    const layout = sanitizeLayout(data?.layout);
    writeCachedLayout(layout);
    return layout;
  } catch (err) {
    console.warn('home_layout unavailable:', err);
    return undefined;
  }
}

/** 存一份新的順序（null = 還原成預設排法）。回傳 false 代表只存在這台裝置 */
export async function saveLayout(layout: HomeLayout | null): Promise<boolean> {
  writeCachedLayout(layout);
  if (!supabase) return false;
  try {
    if (IS_PUBLIC) {
      const { error } = await supabase.auth.updateUser({ data: { [METADATA_KEY]: layout } });
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('home_layout')
        .upsert({ id: 1, layout, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw error;
    }
    return true;
  } catch (err) {
    console.error('Error saving home layout:', err);
    return false;
  }
}
