# 新增一個行程頁

這份文件是寫給「幫忙做行程頁的 AI」看的規格書，人也可以照著做。
典型的工作流程：使用者丟一份 Excel、旅行社行程表或一段文字，AI 照這份規格產生一個資料檔並註冊。

行程頁顯示在 Dashboard 的「行程」分頁。**版面是共用的**（`src/features/itinerary/ItineraryView.tsx`），
每趟旅程只要提供一份 **行程資料**（`ItineraryPlan`）並挑一個 **風格**。
不要再為每趟旅程手寫一整頁 React 元件 —— 那是舊做法，五個舊行程頁都已經轉成資料檔了。

---

## 三個步驟

### 1. 取得旅程 UUID

進入該旅程的 Dashboard，網址是 `/#/trip/<這一段就是 UUID>/dashboard`。
或用 SQL 查（見 [`DB_MAINTENANCE.md`](DB_MAINTENANCE.md) 的 `list_trips.sql`）。

### 2. 建立資料檔

在 `src/features/itinerary/trips/` 新增一個檔案，例如 `Kyoto2027.ts`
（用到客製區塊、需要寫 JSX 時改成 `.tsx`）：

```ts
import { defineItinerary } from '../plan';

export default defineItinerary({
  title: '2027 京都賞櫻',
  tagline: 'KYOTO · NARA',
  tags: ['5 天 4 夜', '京都 4 晚'],
  theme: 'sakura',
  timeZone: 'Asia/Tokyo',
  stays: [
    { id: 'kyoto', city: '京都', name: '某某飯店', checkIn: '2027-03-14', checkOut: '2027-03-18', href: 'https://maps.app.goo.gl/…' },
  ],
  days: [
    {
      date: '2027-03-14', city: '京都', title: '抵達京都', stay: 'kyoto',
      items: [
        { time: '13:10', kind: 'flight', title: '抵達關西機場' },
        { slot: '晚上', kind: 'food', title: '錦市場', places: [{ name: '錦市場', query: '錦市場 京都' }] },
      ],
    },
  ],
});
```

### 3. 註冊

在 `src/features/itinerary/registry.ts` 加兩行：

```ts
import Kyoto2027 from './trips/Kyoto2027';

export const ITINERARIES: Record<string, ItineraryEntry> = {
  // …既有的
  '你的-trip-uuid': Kyoto2027,
};
```

註冊後「行程」分頁會自動出現，而且旅程有行程頁時，Dashboard 預設就停在這一頁。
接著跑 `npm test` —— `plan.test.ts` 會逐一檢查所有註冊的行程（見最後一節）。

---

## 頁面會依資料自動決定顯示什麼

| 資料 | 結果 |
| :--- | :--- |
| 沒有註冊 | 底部導覽沒有「行程」，只分帳 |
| 只有 `days`，而且少於 3 天 | 打開就是每日時間軸，沒有分頁切換 |
| `days` 有 3 天以上 | 多一個「一覽」：每天一行，旅途中標出「今天」 |
| 有 `flights`、`bookings`、`checklist`、`notes`，或 3 天以上且有 `stays` | 多一個「行前」 |
| 任何一天有 `route` 座標 | 一覽頁出現一張預設收起來的「每日路線地圖」 |

電腦版（1024px 以上）一覽固定在左邊、詳細行程在右邊，分頁只剩「行程／行前」。

**寫什麼就顯示什麼，沒寫的就不出現。** 資料來源沒提到的東西不要自己補（例如沒寫是哪一間餐廳，就不要給連結）。

---

## 欄位說明

型別定義在 [`src/features/itinerary/types.ts`](../src/features/itinerary/types.ts)，那裡的註解就是最準的說明。重點如下。

### ItineraryPlan（整趟旅程）

| 欄位 | 必填 | 說明 |
| :--- | :---: | :--- |
| `title` | ✓ | 封面標題 |
| `theme` | ✓ | 風格，見下一節 |
| `days` | ✓ | 每天一筆，**日期由早到晚、不可重複** |
| `tagline` | | 封面上的一行小字，例如 `KYOTO · OSAKA · KOBE` |
| `tags` | | 封面小標籤，例如 `['9 天 8 夜', '京都 3 晚']` |
| `timeZone` | | 目的地 IANA 時區。判斷「今天」與「下一站」用；不填用手機時區 |
| `flights` | | `{ label, date, depart?, arrive?, from?, to?, number?, notes? }` |
| `stays` | | `{ id, name, checkIn, checkOut, city?, nameEn?, address?, href?, notes? }`，日期是入住與退房日 |
| `bookings` | | `{ date, time?, category?, item, status }` |
| `checklist` | | `{ storageKey, items }`。勾選狀態存在各自手機的瀏覽器裡；`storageKey` 要全站唯一，**改了大家的勾選就會消失** |
| `notes` | | 行前分頁最下面的其他備註 |
| `overviewExtra` | | 一覽最上面的客製區塊 |

### DayPlan（一天）

| 欄位 | 必填 | 說明 |
| :--- | :---: | :--- |
| `date` | ✓ | `YYYY-MM-DD` |
| `title` | ✓ | 這天的主題，例如「清水寺・二三年坂・嵐山」 |
| `items` | ✓ | 時間軸，依序排列 |
| `city` | | 例如「京都 → 大阪」 |
| `stay` | | 當晚住宿，填 `stays` 裡的 `id`。最下面會出現「今晚住宿」卡片，連同那間住宿的 `notes` |
| `tips` | | 這天最上面的提醒 |
| `extra` | | 客製區塊，畫在提醒下面 |
| `route` | | 每日路線地圖用的大略座標 `[[lat, lng], …]` |

### ItineraryItem（時間軸上的一項）

| 欄位 | 說明 |
| :--- | :--- |
| `time` | `"09:00"` 或 `"09:00–11:00"`（**en dash「–」**，不是 `~` 或 `-`）。同一天有時間的項目要由早到晚 |
| `slot` | 沒有確切時間時填，例如「早上」「午餐」「全天」。`time` 和 `slot` 至少要有一個 |
| `kind` | 決定圖示：`flight` `train` `car` `bus` `walk` `sight` `food` `hotel` `shopping` `activity` `info` |
| `title` | 標題，可以內嵌連結（見下） |
| `places` | 依序造訪的地點 `{ name, href?, query?, lat?, lng? }`。「在 Google 地圖開啟這天路線」就是把這些串起來 |
| `notes` | 備註清單，可以巢狀、可以標語氣 |
| `booking` | `{ label?, status, href? }`，status 是 `paid`（已付清）／`booked`（已預約）／`walkin`（現場排隊）／`todo`（待預訂）／`pending`（未確認） |
| `tag` | 標題旁的紅色小標籤，例如「爸爸想吃味藏天國」 |
| `undecided` | 還沒決定（例如餐廳），標題旁顯示「未定」 |
| `extra` | 客製區塊，畫在備註下面 |

**地點的寫法**：`href` 是現成的地圖連結（例如 `maps.app.goo.gl` 短網址）；沒有的話填 `query` 讓頁面去搜尋 Google 地圖。
地點的 `name` 若出現在 `title` 裡，標題裡那幾個字會自動變成連結，不會在下面重複列一次。

**住宿不要放進時間軸**：入住時間、Mapcode、停車費這些寫在 `stays[].notes`，每天的「今晚住宿」卡片會帶出來。
退房可以寫成一個 `kind: 'hotel'` 的項目。

### 文字裡的連結、粗體與語氣

字串可以內嵌：

- 連結：`[白川鄉合掌村](https://maps.app.goo.gl/…)`（只接受 `https://` 或 `http://`）
- 粗體：`**16:00 後店家陸續打烊**`

`notes` 的每一項可以是字串，或是物件：

```ts
notes: [
  '有交通管制，停車非常不方便',
  { text: '最晚 16:30 一定要離開犬山', tone: 'warn' },   // 紅色：必看的提醒
  { text: '特急：21:47–22:19（推薦）', tone: 'tip' },      // 主題色：重點
  { text: '實際開放區域依景區規定', tone: 'muted' },       // 淡色：補充說明
  { text: '可以在江南車站停車', items: ['江南駅 Mapcode：4 885 720*20'] },  // 巢狀
]
```

---

## 風格

`theme` 決定封面漸層、主色、封面圖示與標題字體，淺色與深色模式各一組顏色。

| key | 感覺 | 標題字體 | 用在 |
| :--- | :--- | :--- | :--- |
| `default` | 海軍藍 | 黑體 | 不知道選什麼時 |
| `maple` | 楓紅 | 明朝體 | 大阪 2026 |
| `sakura` | 櫻花粉 | 明朝體 | 名古屋 2026 |
| `plum` | 梅紫 | 明朝體 | 京阪 2025 |
| `lake` | 湖水綠 | 手寫 | 九寨溝 2026 |
| `alpine` | 山林綠 | 手寫 | |
| `mystery` | 靛紫 | 黑體 | 台中密室 2026 |

要新增風格：在 `src/index.css` 加一組 `.it-theme-<key>`（淺色與 `prefers-color-scheme: dark` 各一份，
四個變數 `--t-accent` `--t-soft` `--t-on` `--t-cover`），再到 `src/features/itinerary/themes.ts` 加同名的一筆。
明朝體與手寫字體只在用到的行程頁才會向 Google Fonts 下載。

---

## 客製區塊

格式裝不下的內容（鐵路時刻、密室關卡卡片、自駕路線圖），寫成一個小元件放在
`src/features/itinerary/blocks/`，再塞進 item 或 day 的 `extra`：

```tsx
import RailStops from '../blocks/RailStops';

{ time: '09:21–10:25', kind: 'train', title: '搭高鐵南下台中',
  extra: <RailStops stops={[{ station: '台北', time: '09:21' }, { station: '台中', time: '10:25' }]} /> }
```

- 元件一定要放在 `blocks/` 的獨立檔案：資料檔裡直接定義元件會讓 ESLint 的 react-refresh 規則報錯。
- 顏色用 `var(--t-accent)`、`var(--t-soft)` 跟著行程風格走，其餘用全站的 `bg-surface`、`text-ink`、`border-line`，
  深色模式就不用另外處理。
- 不要抓資料：行程頁是靜態內容，要顯示帳目請用其他分頁。

真的連客製區塊都裝不下時，registry 也接受 `{ component: MyPage }` 整頁自己寫，但這應該很少見。

---

## 自動檢查

`src/features/itinerary/plan.test.ts` 會對每一份註冊的行程檢查：

- `theme` 是已知的風格
- 日期格式正確、由早到晚、不重複
- 每個項目有 `time` 或 `slot`；`time` 的格式正確，同一天由早到晚
- `stay` 指到存在的住宿，住宿至少一晚
- 文字裡的 `[label](url)` 都有正確解析（網址打錯會被抓到），地點連結是 `https://`
- `route` 座標在合理範圍
- 每份清單的 `storageKey` 不重複

CI 會跑這支測試，資料寫錯就無法合併。

## 慣例

- **外文地名**：保留原文並在括號加繁體中文，例如「一蘭ラーメン（拉麵）」。這與 LINE Bot 的收據辨識規則一致。
- **金額**：照原始資料寫，日幣用 `¥`，人民幣寫「人民幣 50 元」，不要自己換算。
- **不要用 emoji 當圖示**：圖示由 `kind` 決定。

## 參考範例

| 檔案 | 特色 |
| :--- | :--- |
| `trips/Osaka2026.ts` | 九天，最完整：航班、兩間住宿、預訂狀況、行前清單、每日路線地圖 |
| `trips/Nagoya2026.ts` | 八天自駕，大量巢狀備註、Mapcode、紅字提醒 |
| `trips/Osaka2025.ts` | 八天，訂單連結放在 `booking.href` 與備註裡 |
| `trips/Jiuzhaigou2026.ts` | 旅行社團體行程，用小函式產生重複的餐食項目 |
| `trips/TaichungEscape2026.tsx` | 兩天，只有每日；用 `blocks/RailStops` 示範客製區塊 |
