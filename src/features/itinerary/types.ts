import type React from 'react';
import type { ThemeKey } from './themes';

/**
 * 行程資料格式。行程頁 = 一份 ItineraryPlan + 共用的 ItineraryView。
 * 寫法與範例見 docs/ITINERARY_AUTHORING.md。
 */

/**
 * 可以內嵌連結與粗體的文字：
 * `前往[白川鄉合掌村](https://maps.app.goo.gl/…)，**16:00 後店家陸續打烊**`
 */
export type RichText = string;

/** 一條備註。字串就是一般備註；物件可以指定語氣、附上子項目。 */
export type Note =
  | RichText
  | {
      text: RichText;
      /** warn：紅色提醒（必看）；tip：主題色重點；muted：補充說明 */
      tone?: 'warn' | 'tip' | 'muted';
      items?: Note[];
    };

/** 地圖上的一個地點。有 href 就直接用；沒有的話用 query（或 name）搜尋 Google 地圖。 */
export interface Place {
  name: string;
  href?: string;
  query?: string;
  lat?: number;
  lng?: number;
}

export type ItemKind =
  | 'flight' | 'train' | 'car' | 'bus' | 'walk'
  | 'sight' | 'food' | 'hotel' | 'shopping' | 'activity' | 'info';

/** paid 已付清、booked 已預約、walkin 現場排隊（不收預約）、todo 待預訂（還要去訂）、pending 未確認 */
export type BookingStatus = 'paid' | 'booked' | 'walkin' | 'todo' | 'pending';

export interface ItineraryItem {
  /** "09:00" 或 "09:00–11:00"（用 en dash）；沒有確切時間就改填 slot */
  time?: string;
  /** "早上"、"午餐" 這類時段，time 沒填時顯示 */
  slot?: string;
  kind: ItemKind;
  title: RichText;
  /** 依序造訪的地點，「在 Google 地圖開啟今天路線」會用到 */
  places?: Place[];
  notes?: Note[];
  booking?: { label?: string; status: BookingStatus; href?: string };
  /** 標題旁的小標籤，例如「爸爸想吃這個」 */
  tag?: string;
  /** 還沒決定（例如餐廳） */
  undecided?: boolean;
  /** 客製區塊，畫在備註下面 */
  extra?: React.ReactNode;
}

export interface DayPlan {
  /** YYYY-MM-DD */
  date: string;
  title: string;
  city?: string;
  items: ItineraryItem[];
  /** 當晚住宿，對應 plan.stays 的 id */
  stay?: string;
  /** 這一天最上面的提醒 */
  tips?: Note[];
  /** 客製區塊，畫在提醒下面、時間軸上面 */
  extra?: React.ReactNode;
  /** 每日路線地圖用的大略座標 [lat, lng] */
  route?: [number, number][];
}

export interface Flight {
  label: string;
  /** YYYY-MM-DD */
  date: string;
  /** 出發／抵達時間，資料只有其中一邊時另一邊留空 */
  depart?: string;
  arrive?: string;
  from?: string;
  to?: string;
  number?: string;
  notes?: Note[];
}

export interface Stay {
  id: string;
  name: string;
  city?: string;
  nameEn?: string;
  address?: string;
  /** YYYY-MM-DD */
  checkIn: string;
  /** YYYY-MM-DD */
  checkOut: string;
  href?: string;
  notes?: Note[];
}

export interface Booking {
  /** YYYY-MM-DD */
  date: string;
  time?: string;
  category?: string;
  item: RichText;
  status: BookingStatus;
}

export interface ItineraryPlan {
  title: string;
  /** 封面上的一行小字，例如 "KYOTO · OSAKA · KOBE" */
  tagline?: string;
  /** 封面上的小標籤，例如「京都 3 晚」 */
  tags?: string[];
  theme: ThemeKey;
  /** 目的地時區，用來判斷「今天」與「下一站」；不填就用手機的時區 */
  timeZone?: string;
  flights?: Flight[];
  stays?: Stay[];
  bookings?: Booking[];
  /** 行前準備清單。勾選狀態存在各自手機的瀏覽器裡 */
  checklist?: { storageKey: string; items: string[] };
  /** 行前分頁最下面的其他備註，例如還沒排進行程的想法 */
  notes?: Note[];
  /** 一覽分頁最上面的客製區塊 */
  overviewExtra?: React.ReactNode;
  days: DayPlan[];
}
