# 新增一個行程頁

每個旅程都可以有一頁手工打造的行程表（飯店、時程、交通、地圖），
顯示在 Dashboard 的「行程」分頁。

行程頁是**自由發揮的 React 元件**，沒有強制模板 ——
簡單的兩日遊可以只有幾張卡片，複雜的可以加地圖與即時定位。
共用元件只是讓不必重寫的部分可以直接拿來用。

---

## 三個步驟

### 1. 取得旅程 UUID

從網址列拿：進入該旅程的 Dashboard，網址是
`/#/trip/<這一段就是 UUID>/dashboard`。

或用 SQL 查（見 [`DB_MAINTENANCE.md`](DB_MAINTENANCE.md) 的 `list_trips.sql`）。

### 2. 建立元件

在 `src/features/itinerary/trips/` 新增一個檔案，例如 `Kyoto2027.tsx`。
元件不接受任何 props、不抓資料，就是純粹的 JSX：

```tsx
import React, { useState } from 'react';
import { Calendar } from 'lucide-react';

const TRIP_DATES: Record<string, 'day1' | 'day2'> = {
  '2027-03-14': 'day1',
  '2027-03-15': 'day2',
};

// 如果今天正好在旅程期間，就自動跳到對應的那一天
const getInitialDay = (): 'day1' | 'day2' => {
  const t = new Date();
  const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return TRIP_DATES[key] ?? 'day1';
};

const Kyoto2027: React.FC = () => {
  const [activeDay, setActiveDay] = useState<'day1' | 'day2'>(getInitialDay);

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12 animate-in fade-in duration-500">
      <div className="text-center space-y-2 py-4">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white">
          2027 京都賞櫻
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm">副標題</p>
      </div>

      {/* 日期切換 */}
      {/* 各天的內容 */}
    </div>
  );
};

export default Kyoto2027;
```

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
註冊後「行程」分頁會自動出現，而且如果旅程有行程頁，Dashboard 預設就會停在這一頁。

---

## 慣例

- **深色模式**：每個顏色都要配一組 `dark:`。專案全站都支援深色模式。
- **圖示**：一律用 `lucide-react`。常用的有
  `Calendar`、`Clock`、`MapPin`、`Train`、`Plane`、`BedDouble`、`Utensils`、`Ticket`、`Info`。
- **外層容器**：沿用 `max-w-4xl mx-auto space-y-6 pb-12`，與其他行程頁一致。
- **日期切換列**：用 `sticky top-4 z-20` 讓它捲動時固定在上方。
- **手機優先**：字級用 `text-2xl sm:text-3xl` 這種寫法，先顧小螢幕。
- **不要抓資料**：行程頁是靜態內容。要顯示帳目請用其他分頁。

## 參考範例

| 檔案 | 特色 |
| :--- | :--- |
| `trips/TaichungEscape2026.tsx` | 最單純的兩日遊，**沒有地圖**，適合當起點 |
| `trips/Osaka2025.tsx` | 含 Leaflet 地圖 |
| `trips/Nagoya2026.tsx` | 最完整，含地圖、路線與即時定位 |
| `trips/Jiuzhaigou2026.tsx` | 含地圖與飯店資訊 |

## 地圖（選用）

用不到地圖的行程頁完全不需要碰這一段。

Leaflet 是**外部載入**的，不在 `package.json` 裡，型別定義在 `src/types/leaflet.d.ts`。
用法參考 `Nagoya2026.tsx` 的地圖區塊 —— 注意 `useEffect` 的清理函式必須銷毀 map instance，
否則切換分頁再切回來會出現「Map container is already initialized」。
