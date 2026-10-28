import { defineItinerary } from '../plan';

/**
 * 2026 大阪環球賞楓之旅（11/14 – 11/22）
 *
 * 內容全部來自「1114-1122大阪.xlsx」：planA 分頁的每日時段、機票住宿分頁、
 * 各預訂狀況分頁與事前準備分頁。試算表沒寫的就不寫 —— 例如神戶的海生館與動物園
 * 沒指明是哪一間，所以不給地圖連結。
 */

const KIX: [number, number] = [34.4320, 135.2304];
const KYOTO_STATION: [number, number] = [34.9858, 135.7588];
const KYOTO_HOTEL: [number, number] = [34.99107, 135.76565];
const OSAKA_HOTEL: [number, number] = [34.66041, 135.50443];
const NIPPONBASHI: [number, number] = [34.6627, 135.5065];
const DOTONBORI: [number, number] = [34.6687, 135.5013];
const NAMBA: [number, number] = [34.6655, 135.5010];

const MINAMI = [
  { name: '日本橋', query: '日本橋 大阪' },
  { name: '道頓堀', query: '道頓堀' },
  { name: '難波', query: '難波 大阪' },
];

export default defineItinerary({
  title: '2026 大阪環球賞楓之旅',
  tagline: 'KYOTO · OSAKA · KOBE',
  tags: ['9 天 8 夜', '京都 3 晚', '大阪 5 晚', '環球影城', '神戶一日'],
  theme: 'maple',
  timeZone: 'Asia/Tokyo',

  flights: [
    { label: '去程', date: '2026-11-14', depart: '13:30', arrive: '16:55' },
    { label: '回程', date: '2026-11-22', depart: '12:55', arrive: '15:05' },
  ],

  stays: [
    {
      id: 'kyoto',
      city: '京都',
      name: '京都高瀬川別邸 北館',
      checkIn: '2026-11-14',
      checkOut: '2026-11-17',
      href: 'https://www.google.com/maps/place/%E4%BA%AC%E9%83%BD%E9%AB%98%E7%80%AC%E5%B7%9D%E5%88%A5%E9%82%B8+%E5%8C%97%E9%A4%A8/@34.9910667,135.7630781,17z/data=!3m1!4b1!4m9!3m8!1s0x600108b0c5dcf689:0x1ba3dbee6dfe02d3!5m2!4m1!1i2!8m2!3d34.9910667!4d135.765653!16s%2Fg%2F11c53cqkss',
    },
    {
      id: 'osaka',
      city: '大阪',
      name: 'Comfy House Namba',
      address: 'Nipponbashinishi 1-1-8 1F',
      checkIn: '2026-11-17',
      checkOut: '2026-11-22',
      href: 'https://www.google.com/maps/place/Comfy+House+Namba/@34.6600933,135.504524,19.62z/data=!4m9!3m8!1s0x6000e7007b71e063:0x805f97968e519713!5m2!4m1!1i2!8m2!3d34.6604085!4d135.5044279!16s%2Fg%2F11lw06bt9w',
    },
  ],

  // 「各預訂狀況」分頁裡有填內容的列（狀態仍是「請選擇」的顯示為未確認）
  bookings: [
    { date: '2026-11-15', category: '交通', item: '嵐山嵯峨野觀光小火車', status: 'paid' },
    { date: '2026-11-16', category: '大吃大喝', item: '壽喜燒（Moritaya - Kiyamachi）', status: 'booked' },
    { date: '2026-11-17', category: '大吃大喝', item: '大阪燒', status: 'pending' },
    { date: '2026-11-18', time: '20:00', category: '大吃大喝', item: '炭火燒肉大歡', status: 'booked' },
    { date: '2026-11-19', category: '景點', item: '環球影城門票 快通', status: 'paid' },
  ],

  // 沿用舊行程頁的 key，大家已經勾過的項目不會消失
  checklist: {
    storageKey: 'itinerary_checklist_osaka2026',
    items: ['護照', '信用卡', '外幣', '入境資料（Visit Japan）', '保險', 'E-SIM', '充電線', '藥', '環保袋', '牙刷', '口罩', '行動電源'],
  },

  notes: [
    '還沒排進的：生魚片（可以排在任何一天的午餐）',
    '各種早餐、午餐、晚餐都還能再排；標「未定」的是還沒決定的餐廳。',
  ],

  days: [
    {
      date: '2026-11-14', city: '京都', title: '出發，抵達京都', stay: 'kyoto',
      route: [KIX, KYOTO_STATION, KYOTO_HOTEL],
      items: [
        { time: '13:30–16:55', kind: 'flight', title: '去程航班' },
        { slot: '晚上', kind: 'train', title: 'HARUKA 46 特急 → 京都' },
        { slot: '晚餐', kind: 'food', title: '京都居酒屋' },
      ],
    },
    {
      date: '2026-11-15', city: '京都', title: '清水寺・二三年坂・嵐山', stay: 'kyoto',
      route: [KYOTO_HOTEL, [34.99467, 135.78466], [34.9985, 135.7803], [34.9962, 135.7813], [35.0129, 135.6777], KYOTO_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '清水寺', notes: ['預計 7 點左右抵達'],
          places: [{ name: '清水寺', href: 'https://www.google.com/maps/place/%E6%B8%85%E6%B0%B4%E5%AF%BA/@34.9946662,135.784661,15z' }],
        },
        {
          slot: '下午', kind: 'walk', title: '二年坂 → 三年坂',
          places: [{ name: '二年坂', query: '二年坂 京都' }, { name: '三年坂', query: '三年坂 京都' }],
        },
        {
          slot: '晚上', kind: 'sight', title: '嵐山',
          places: [{ name: '嵐山', query: '嵐山 京都' }],
          booking: { label: '嵐山嵯峨野觀光小火車', status: 'paid' },
        },
      ],
    },
    {
      date: '2026-11-16', city: '京都', title: '下鴨神社・金閣寺・鴨川', stay: 'kyoto',
      route: [KYOTO_HOTEL, [35.0391, 135.7727], [35.0394, 135.7292], [35.0037, 135.7690], [35.0040, 135.7717], [35.00946, 135.77063], KYOTO_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '下鴨神社 → 金閣寺',
          places: [{ name: '下鴨神社', query: '下鴨神社' }, { name: '金閣寺', query: '金閣寺' }],
        },
        { slot: '午餐', kind: 'food', title: '豬一拉麵', places: [{ name: '豬一拉麵', query: '麺匠 猪一 京都' }] },
        {
          slot: '下午', kind: 'walk', title: '河原町 → 鴨川',
          places: [{ name: '河原町', query: '河原町 京都' }, { name: '鴨川', query: '鴨川 京都' }],
        },
        {
          slot: '晚餐', kind: 'food', title: '壽喜燒（Moritaya - Kiyamachi）',
          places: [{ name: 'Moritaya - Kiyamachi', href: 'https://www.google.com/maps/place/Moritaya+-+Kiyamachi/@35.0094641,135.7706255,17z' }],
          booking: { label: '壽喜燒', status: 'booked' },
        },
      ],
    },
    {
      date: '2026-11-17', city: '京都 → 大阪', title: '伏見稻荷，移動到大阪', stay: 'osaka',
      route: [KYOTO_HOTEL, [34.96769, 135.77919], OSAKA_HOTEL, NIPPONBASHI, DOTONBORI, NAMBA, OSAKA_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '伏見稻荷神社',
          places: [{ name: '伏見稻荷神社', href: 'https://www.google.com/maps/place/%E4%BC%8F%E8%A6%8B%E7%A8%BB%E8%8D%B7%E5%A4%A7%E7%A4%BE/@34.9676945,135.7791876,15z' }],
        },
        { slot: '早上', kind: 'train', title: '退房、前往大阪', notes: ['待確認行李寄放'] },
        { slot: '午餐', kind: 'food', title: '炸牛排' },
        { slot: '下午', kind: 'shopping', title: '日本橋 → 道頓堀 → 難波', places: MINAMI },
        {
          slot: '晚餐', kind: 'food', title: '福太郎大阪燒',
          places: [{ name: '福太郎大阪燒', href: 'https://maps.app.goo.gl/Y3Dh1tC1rkqCa1Bm9' }],
          booking: { label: '大阪燒', status: 'pending' },
        },
      ],
    },
    {
      date: '2026-11-18', city: '大阪', title: '任天堂博物館・難波', stay: 'osaka',
      route: [OSAKA_HOTEL, [34.9033, 135.7928], NIPPONBASHI, DOTONBORI, NAMBA, OSAKA_HOTEL],
      items: [
        { slot: '早餐', kind: 'food', title: '客美多' },
        {
          slot: '早上', kind: 'activity', title: '任天堂博物館 → 中村藤吉',
          places: [{ name: '任天堂博物館', query: 'Nintendo Museum 宇治' }],
        },
        { slot: '下午', kind: 'shopping', title: '日本橋 → 道頓堀 → 難波', places: MINAMI },
        {
          time: '20:00', kind: 'food', title: '炭火燒肉大歡',
          places: [{ name: '炭火燒肉大歡', href: 'https://share.google/V59qkQBAZi1gGPyfs' }],
          booking: { label: '炭火燒肉大歡', status: 'booked' },
        },
      ],
    },
    {
      date: '2026-11-19', city: '大阪', title: '環球影城一整天', stay: 'osaka',
      route: [OSAKA_HOTEL, [34.6654, 135.4323], OSAKA_HOTEL],
      items: [
        {
          slot: '全天', kind: 'activity', title: '環球影城',
          places: [{ name: '環球影城', query: 'Universal Studios Japan' }],
          booking: { label: '門票＋快通', status: 'paid' },
        },
        { slot: '晚餐', kind: 'food', title: '串炸或居酒屋', undecided: true },
      ],
    },
    {
      date: '2026-11-20', city: '神戶', title: '神戶一日遊', stay: 'osaka',
      // 只畫到神戶市區：試算表沒寫是哪一間海生館與動物園
      route: [OSAKA_HOTEL, [34.6946, 135.1956], OSAKA_HOTEL],
      tips: ['視天氣情況調整動物園及海生館之順序'],
      items: [
        { slot: '早上', kind: 'sight', title: '神戶海生館' },
        { slot: '下午', kind: 'sight', title: '神戶動物園' },
        { slot: '晚上', kind: 'sight', title: '神戶夜景' },
        { slot: '晚餐', kind: 'food', title: '神戶牛排', undecided: true },
      ],
    },
    {
      date: '2026-11-21', city: '大阪', title: '勝尾寺・梅田', stay: 'osaka',
      route: [OSAKA_HOTEL, [34.8654, 135.4910], [34.7025, 135.4959], OSAKA_HOTEL],
      items: [
        { slot: '早上', kind: 'sight', title: '勝尾寺', places: [{ name: '勝尾寺', query: '勝尾寺 箕面' }] },
        { slot: '午餐', kind: 'food', title: '壽司' },
        { slot: '下午～晚上', kind: 'shopping', title: '梅田逛街', places: [{ name: '梅田', query: '梅田 大阪' }] },
      ],
    },
    {
      date: '2026-11-22', city: '大阪', title: '返程',
      route: [OSAKA_HOTEL, KIX],
      items: [
        { time: '12:55–15:05', kind: 'flight', title: '回程航班' },
      ],
    },
  ],
});
