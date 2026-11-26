/**
 * Supabase Storage 的路徑與 URL 工具。
 *
 * expenses.photo_urls 存的是 bucket 內的「路徑」（例如 expenses/{tripId}/abc.jpg），
 * 不是完整網址。要顯示時得自行組出 public URL。
 */
import { IMAGES_BUCKET } from '../config/mode';

/**
 * 收據照片所在的 bucket。舊版是 travel-images（也被 supabase/scripts/delete_trip.sql 依賴，勿隨意更名），
 * 開放版是私有的 app-images（src/config/mode.ts）。
 */
export const RECEIPTS_BUCKET = IMAGES_BUCKET;

/**
 * 由 photo_urls 裡的路徑組出可直接放進 <img src> 的公開網址。
 * ⚠️ 只適用舊版的公開 bucket。開放版的 bucket 是私有的，要改用簽名網址（尚未接上，見 docs/SECURITY.md 第 5 條）。
 */
export const photoUrl = (path: string): string =>
  `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${RECEIPTS_BUCKET}/${path}`;

/** 某個旅程的照片路徑前綴。 */
export const tripPhotoPrefix = (tripId: string): string => `expenses/${tripId}/`;
