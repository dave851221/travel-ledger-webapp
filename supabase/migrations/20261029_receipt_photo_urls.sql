-- ============================================================
-- 相簿：分出「收據照片」與「商品照片」
--
-- receipt_photo_urls 是 photo_urls 的子集合。機器人從照片讀出金額後存入的（在 LIFF 稍微改過也算）
-- 是收據；網頁自己上傳的、📷 照片記帳（金額由使用者填）的都是商品照片。編輯支出時可以逐張切換。
--
-- 既有資料的回填：LINE 傳來的照片檔名是訊息 id（一長串數字），在 📷 照片記帳出現以前
-- 一律走收據辨識，所以這些算收據；網頁上傳的檔名是 uuid 或 Math.random() 的 0.xxx，算商品照片。
-- ============================================================
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS receipt_photo_urls TEXT[] DEFAULT '{}';

UPDATE public.expenses e
SET receipt_photo_urls = ARRAY(
    SELECT u FROM unnest(e.photo_urls) AS u
    WHERE u ~ '/[0-9]{12,}\.[a-z]+$'
)
WHERE cardinality(e.photo_urls) > 0
  AND cardinality(COALESCE(e.receipt_photo_urls, '{}')) = 0;

-- list_trip_trash 回傳 SETOF public.expenses，欄位變了要讓 PostgREST 重新讀 schema
NOTIFY pgrst, 'reload schema';
