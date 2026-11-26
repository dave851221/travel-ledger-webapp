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
