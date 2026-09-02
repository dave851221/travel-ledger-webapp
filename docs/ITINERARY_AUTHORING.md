# 新增一個行程頁

每個旅程都可以有一頁手工打造的行程表（飯店、時程、交通、地圖），
顯示在 Dashboard 的「行程」分頁。

行程頁是**自由發揮的 React 元件**，沒有強制模板 ——
簡單的兩日遊可以只有幾張卡片，複雜的可以加地圖與路線動畫。
`features/itinerary/components/` 只是一組「積木」，想用幾塊就用幾塊。

---

## 三個步驟

### 1. 取得旅程 UUID

進入該旅程的 Dashboard，網址是 `/#/trip/<這一段就是 UUID>/dashboard`。
或用 SQL 查（見 [`DB_MAINTENANCE.md`](DB_MAINTENANCE.md) 的 `list_trips.sql`）。

### 2. 建立元件

複製 [`src/features/itinerary/trips/_Template.tsx`](../src/features/itinerary/trips/_Template.tsx)
改成新名字（例如 `Kyoto2027.tsx`），那是一份可以直接跑的最小骨架。

### 3. 註冊

在 `src/features/itinerary/registry.ts` 加兩行：

```ts
import Kyoto2027 from './trips/Kyoto2027';

export const ITINERARY_COMPONENTS: Record<string, React.FC> = {
  // …既有的
  '你的-trip-uuid': Kyoto2027,
};
```

`hasItinerary()` 與 `getItineraryComponent()` 不需要改。
註冊後「行程」分頁會自動出現，而且旅程有行程頁時，Dashboard 預設就會停在這一頁。

---

## 共用元件

全部從 `'../components'` 匯入。每個都能單獨使用，彼此沒有依賴。

### `ItineraryCard`

時間軸樣式的卡片：左邊一條連續的線加一個圖示圓點。連續放好幾張就自動接成時間軸。

```tsx
<ItineraryCard icon="🚄">
  <h3 className="font-black text-slate-800 dark:text-white text-sm sm:text-base">搭新幹線</h3>
  <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">09:12 出發</p>
</ItineraryCard>
```

| Prop | 說明 |
| :--- | :--- |
| `icon` | 圓點裡的 emoji |
| `accent` | 圓點顏色：`blue`(預設) / `teal` / `rose` / `indigo` / `amber` / `emerald` |

### `DaySelector`

橫向捲動的日期頁籤，天數多也不會擠壓版面。

```tsx
const DAYS = [
  { key: 'day1', subLabel: '3/14 抵達' },
  { key: 'day2', subLabel: '3/15 返程' },
];

<DaySelector days={DAYS} activeDay={activeDay} onChange={setActiveDay} accent="teal" />
```

`label` 省略時自動顯示 `Day 1`、`Day 2`…

### `getInitialDay`

今天若正好在旅程期間，就自動跳到當天那一頁。

```ts
const TRIP_DATES = { '2027-03-14': 'day1', '2027-03-15': 'day2' };
const [activeDay, setActiveDay] = useState(() => getInitialDay(TRIP_DATES, 'day1'));
```

傳給 `useState` 時要用函式形式，否則每次 render 都重算。

### `TripMap`（選用）

Leaflet 地圖，畫出每天的路線並讓一個交通工具圖示沿著路線移動。
**用不到地圖的行程頁完全不需要 import 這個元件。**

```tsx
<TripMap
  routes={{ day1: [[35.17, 136.90], [35.33, 136.87]], day2: [/* … */] }}
  activeDay={activeDay}
  center={[35.1738, 136.8994]}
  vehicleIcon={(day) => (day === 'day1' ? '🚇' : '🚗')}
/>
```

| Prop | 說明 |
| :--- | :--- |
| `routes` | `{ dayKey: [[lat, lng], …] }`，key 要和 `DaySelector` 一致 |
| `activeDay` | 目前顯示哪一天 |
| `center` / `zoom` | 初始視野，`zoom` 預設 9 |
| `color` | 路線顏色，預設 `#0d6efd` |
| `vehicleIcon` | 固定字串或 `(day) => emoji` |
| `heightClass` | 高度，預設 `h-40 sm:h-96` |

Leaflet 是從 `index.html` 以 CDN `<script>` 載入的，**不在 `package.json` 裡**，
型別定義在 `src/types/leaflet.d.ts`。元件內已處理好卸載時的 `map.remove()` ——
少了它，切換分頁再切回來會出現 `Map container is already initialized`。

---

## 慣例

- **深色模式**：每個顏色都要配一組 `dark:`，全站都支援深色模式。
- **圖示**：卡片圓點用 emoji；需要 icon 元件時用 `lucide-react`
  （`Calendar`、`Clock`、`MapPin`、`Train`、`Plane`、`BedDouble`、`Utensils`、`Ticket`、`Info`）。
- **外層容器**：`max-w-4xl mx-auto space-y-6 pb-12`，與其他行程頁一致。
- **手機優先**：字級寫成 `text-2xl sm:text-3xl`，先顧小螢幕。
- **不要抓資料**：行程頁是靜態內容，要顯示帳目請用其他分頁。
- **外文地名**：保留原文並在括號加繁體中文，例如「一蘭ラーメン(拉麵)」。
  這與 LINE Bot 的收據辨識規則一致。

## 參考範例

| 檔案 | 特色 |
| :--- | :--- |
| `trips/_Template.tsx` | 最小骨架，**沒有地圖**，複製這個開始 |
| `trips/TaichungEscape2026.tsx` | 兩日遊，沒有地圖，有自訂的交通與密室卡片 |
| `trips/Nagoya2026.tsx` | 八天，用 `TripMap` + `DaySelector` |
| `trips/Osaka2025.tsx` | 八天，粉紅色系 |
| `trips/Jiuzhaigou2026.tsx` | 八天，青綠色系 |
