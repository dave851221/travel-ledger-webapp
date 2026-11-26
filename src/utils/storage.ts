/**
 * Supabase Storage 的路徑與 URL 工具。
 *
 * expenses.photo_urls 存的是 bucket 內的「路徑」（例如 expenses/{tripId}/abc.jpg），
 * 不是完整網址。要顯示時得自行組出 public URL。
 */
import { IMAGES_BUCKET, IS_PUBLIC } from '../config/mode';
import { resolveSignedPhotoUrl, signedPhotoUrl } from './signedPhotos';

/**
 * 收據照片所在的 bucket。舊版是 travel-images（也被 supabase/scripts/delete_trip.sql 依賴，勿隨意更名），
 * 開放版是私有的 app-images（src/config/mode.ts）。
 */
export const RECEIPTS_BUCKET = IMAGES_BUCKET;

/**
 * 由 photo_urls 裡的路徑組出可直接放進 <img src> 的網址。
 * 舊版：公開 bucket，直接組網址。
 * 開放版：私有 bucket，回簽名網址；還沒簽好先回透明圖，簽好後用 usePhotoUrlVersion() 的元件會重畫
 * （見 utils/signedPhotos.ts、docs/SECURITY.md 第 5 條）。
 */
export const photoUrl = (path: string): string =>
  IS_PUBLIC
    ? signedPhotoUrl(path)
    : `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${RECEIPTS_BUCKET}/${path}`;

/** 一定要拿到真的網址時用（例如抓原圖做影片）：開放版會等簽好 */
export const resolvePhotoUrl = async (path: string): Promise<string | null> =>
  IS_PUBLIC ? resolveSignedPhotoUrl(path) : photoUrl(path);

/** 某個旅程的照片路徑前綴。 */
export const tripPhotoPrefix = (tripId: string): string => `expenses/${tripId}/`;
