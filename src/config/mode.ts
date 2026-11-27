/**
 * 這份程式碼同時建出兩個版本：
 *
 * - `legacy`（預設）：舊版「旅遊小本本」，親友用，資料在 public schema，沒有登入。
 * - `public`：開放版「旅行小本本」，資料在 app schema，要用 LINE／Google 登入，權限由 RLS 決定。
 *
 * 由建置時的 `VITE_APP_MODE` 決定（`.env` 沒寫就是 legacy），所以舊版的建置結果不會因為開放版的開發而改變。
 * 兩版的差異一律從這裡讀，不要在元件裡自己判斷 env。規則見 docs/SECURITY.md。
 */
export type AppMode = 'legacy' | 'public';

export const APP_MODE: AppMode = import.meta.env.VITE_APP_MODE === 'public' ? 'public' : 'legacy';

export const IS_PUBLIC = APP_MODE === 'public';

/** 資料庫 schema：supabase-js 的 `from()` / `rpc()` 都會打到這裡 */
export const DB_SCHEMA = IS_PUBLIC ? 'app' : 'public';

/** 收據與商品照片的 bucket。開放版是私有的，顯示時要用簽名網址 */
export const IMAGES_BUCKET = IS_PUBLIC ? 'app-images' : 'travel-images';

/** 產品名稱（分頁標題、分享預覽） */
export const PRODUCT_NAME = IS_PUBLIC ? '旅行小本本' : '旅遊小本本';

/**
 * 開發與封測期間，開放版放在同一個 GitHub Pages 網站的 `/next/` 底下，跟舊版是同一個網址（origin），
 * 共用同一份 localStorage。**不帶旅程 id 的全域鍵**（離線佇列、首頁快取…）要加前綴，
 * 否則開放版排隊的帳可能被舊版拿去上傳到 public。帶旅程 id 的鍵不會撞（兩版的旅程 id 不同）。
 */
export const globalStorageKey = (name: string): string => (IS_PUBLIC ? `tlb:${name}` : name);

/**
 * 帶旅程 id 的鍵（`me_{id}`、`trip_cache_{id}`、`chat_{id}`、`recap_{id}`）。舊版維持原本的名字；
 * 開放版一樣加 `tlb:` 前綴 —— 換帳號登入時要把上一個人留在這台裝置的資料全部清掉
 * （clearUserStorage），只清 `tlb:` 開頭的就不會動到同一個瀏覽器裡舊版的快取。
 */
export const tripStorageKey = (name: string, tripId: string): string =>
  IS_PUBLIC ? `tlb:${name}_${tripId}` : `${name}_${tripId}`;

/** 「我是誰」記在這台裝置的鍵 */
export const meKey = (tripId: string): string => tripStorageKey('me', tripId);

/** 登入流程本身用的鍵（登入回來要去哪頁、LINE 的 state）不能在換人時清掉，否則剛登入就忘了要回哪 */
const KEEP_ON_USER_CHANGE = new Set(['cache_owner', 'auth_return_to', 'line_oauth'].map(globalStorageKey));

/**
 * 開放版：清掉這台裝置上屬於「上一個登入的人」的資料（旅程清單快取、帳目快取、我是誰、聊天紀錄…）。
 * 共用裝置上換人登入、或登出時呼叫，見 features/auth/session.ts 的 cache guard。
 */
export function clearUserStorage(): void {
  if (!IS_PUBLIC) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tlb:') && !KEEP_ON_USER_CHANGE.has(k)) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
  } catch {
    // 讀不到 localStorage（隱私模式）就沒有東西要清
  }
}

/**
 * 開放版（旅行小本本）的網址。舊版首頁的「搬家」提示連過去（David 2026-11-27：舊版不再建立新旅程）。
 * 之後搬到 Cloudflare Pages／自己的網域時改這裡。
 */
export const PUBLIC_SITE_URL = 'https://dave851221.github.io/travel-ledger-webapp/next/';
