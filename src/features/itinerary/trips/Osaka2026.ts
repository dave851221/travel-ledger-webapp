import { defineItinerary } from '../plan';

/**
 * 2026 大阪環球賞楓之旅（11/14 – 11/22）
 *
 * 內容全部來自「1114-1122大阪.xlsx」：planA 的每日時段、機票住宿、各預訂狀況與事前準備
 * （2026-10-29 依最新版更新）。試算表沒寫的就不寫 —— 例如神戶夜景沒指定地點，就不給連結。
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
    { label: '去程', date: '2026-11-14', number: 'BR130', from: '桃園 T2', to: '關西 T1', depart: '13:30', arrive: '16:55' },
    { label: '回程', date: '2026-11-22', number: 'BR131', from: '關西 T1', to: '桃園 T2', depart: '12:55', arrive: '15:05' },
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

  // 「各預訂狀況」分頁裡有填內容的列；狀態「請選擇」顯示為未確認
  bookings: [
    { date: '2026-11-14', time: '17:44', category: '交通', item: 'Haruka 車票（關西機場到京都）', status: 'booked' },
    { date: '2026-11-15', category: '交通', item: '嵐山嵯峨野觀光小火車', status: 'paid' },
    { date: '2026-11-16', category: '大吃大喝', item: '壽喜燒（Moritaya - Kiyamachi）', status: 'booked' },
    { date: '2026-11-17', category: '大吃大喝', item: '大阪燒', status: 'walkin' },
    { date: '2026-11-19', category: '景點', item: '環球影城門票 快通', status: 'paid' },
    { date: '2026-11-20', category: '景點', item: '神戶動物王國', status: 'pending' },
    { date: '2026-11-20', time: '20:00', category: '大吃大喝', item: '神戶牛燒肉（Kobe Beef Yakiniku WASSIA）', status: 'booked' },
    { date: '2026-11-22', category: '交通', item: '[南海電鐵特急 Rapi:t 車票（難波到關西機場）](https://hop2.fun/ZRfyvGWu)', status: 'todo' },
  ],

  // 沿用舊行程頁的 key，大家已經勾過的項目不會消失
  checklist: {
    storageKey: 'itinerary_checklist_osaka2026',
    items: ['護照', '信用卡', '外幣', '入境資料（Visit Japan）', '保險', 'E-SIM', '充電線', '藥', '環保袋', '牙刷', '口罩', '行動電源'],
  },

  notes: [
    '還沒排進的：生魚片（可以排在任何一天的午餐）',
    '各種早餐、午餐、晚餐都還能再排；標「未定」的是還沒決定的餐廳或店家。',
  ],

  days: [
    {
      date: '2026-11-14', city: '京都', title: '出發，抵達京都', stay: 'kyoto',
      route: [KIX, KYOTO_STATION, KYOTO_HOTEL],
      items: [
        { time: '13:30–16:55', kind: 'flight', title: '去程航班 BR130' },
        { time: '17:44', kind: 'train', title: 'HARUKA 特急 → 京都', booking: { label: 'Haruka 車票', status: 'booked' } },
        { slot: '晚餐', kind: 'food', title: '京都居酒屋' },
      ],
    },
    {
      date: '2026-11-15', city: '京都', title: '清水寺・二三年坂・嵐山', stay: 'kyoto',
      route: [KYOTO_HOTEL, [34.99467, 135.78466], [34.99832, 135.77873], [34.9985, 135.7803], [34.9962, 135.7813], [35.0129, 135.6777], KYOTO_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '清水寺 → 八坂庚申堂', notes: ['預計 7 點左右抵達'],
          places: [
            { name: '清水寺', href: 'https://www.google.com/maps/place/%E6%B8%85%E6%B0%B4%E5%AF%BA/@34.9911926,135.8017076,12.87z/data=!4m15!1m8!3m7!1s0x600108d003129ba9:0x884ea8c8fdd6097b!2zTmluZW4gWmFrYSBQYXRoLCBIaWdhc2hpeWFtYSBXYXJkLCBLeW90bywg5pel5pys!3b1!8m2!3d34.9986043!4d135.7808222!16s%2Fg%2F11k6qdr_16!3m5!1s0x600108d385dcfb07:0x62af658650c434ba!8m2!3d34.9946662!4d135.784661!16zL20vMDJ5bjNn' },
            { name: '八坂庚申堂', href: 'https://www.google.com/maps/place/%E5%85%AB%E5%9D%82%E5%BA%9A%E7%94%B3%E5%A0%82/@34.9983244,135.7761501,17z/data=!3m1!4b1!4m6!3m5!1s0x600108c57c92fbe9:0x9835e9eb6c174cfa!8m2!3d34.9983244!4d135.7787304!16s%2Fm%2F03c1tx8' },
          ],
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
      route: [KYOTO_HOTEL, [35.0391, 135.7727], [35.0394, 135.7292], [35.00133, 135.76696], [35.0037, 135.7690], [35.0040, 135.7717], [35.00946, 135.77063], KYOTO_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '下鴨神社 → 金閣寺',
          places: [{ name: '下鴨神社', query: '下鴨神社' }, { name: '金閣寺', query: '金閣寺' }],
        },
        {
          slot: '午餐', kind: 'food', title: '豬一拉麵',
          places: [{ name: '豬一拉麵', href: 'https://www.google.com/maps/place/%E9%BA%B5%E5%B1%8B+%E8%B1%AC%E4%B8%80/@35.0013284,135.7643836,17z/data=!3m1!4b1!4m6!3m5!1s0x600108be0e8efcb9:0x6c1bd116c4bb5b35!8m2!3d35.0013284!4d135.7669639!16s%2Fg%2F11cjqs44mn' }],
        },
        {
          slot: '下午', kind: 'walk', title: '河原町 → 鴨川',
          places: [{ name: '河原町', query: '河原町 京都' }, { name: '鴨川', query: '鴨川 京都' }],
        },
        {
          slot: '晚餐', kind: 'food', title: '壽喜燒（Moritaya - Kiyamachi）',
          places: [{ name: 'Moritaya - Kiyamachi', href: 'https://www.google.com/maps/place/Moritaya+-+Kiyamachi/@35.0084756,135.7662953,14.95z/data=!3m1!5s0x600108939113ec1b:0x8581adf06c3dbf4d!4m15!1m8!3m7!1s0x600108eccb9daa8f:0xfc84e1f0b888131d!2sMoritaya+-+Kiyamachi!8m2!3d35.0094641!4d135.7706255!10e9!16s%2Fg%2F1tcvbs_h!3m5!1s0x600108eccb9daa8f:0xfc84e1f0b888131d!8m2!3d35.0094641!4d135.7706255!16s%2Fg%2F1tcvbs_h' }],
          booking: { label: '壽喜燒', status: 'booked' },
        },
      ],
    },
    {
      date: '2026-11-17', city: '京都 → 大阪', title: '伏見稻荷，移動到大阪', stay: 'osaka',
      route: [KYOTO_HOTEL, [34.96769, 135.77919], OSAKA_HOTEL, [34.66662, 135.50197], NIPPONBASHI, DOTONBORI, NAMBA, OSAKA_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '伏見稻荷神社',
          places: [{ name: '伏見稻荷神社', href: 'https://www.google.com/maps/place/%E4%BC%8F%E8%A6%8B%E7%A8%BB%E8%8D%B7%E5%A4%A7%E7%A4%BE/@34.9356744,135.8106282,12.62z/data=!4m6!3m5!1s0x60010f153d2e6d21:0x7b1aca1c753ae2e9!8m2!3d34.9676945!4d135.7791876!16zL20vMDVsZHJt' }],
        },
        { slot: '早上', kind: 'train', title: '退房、前往大阪', notes: ['待確認行李寄放'] },
        {
          slot: '午餐', kind: 'food', title: '牛かつもと村 難波店（炸牛排）',
          places: [{ name: '牛かつもと村 難波店', href: 'https://www.google.com/maps/place/Gyukatsu+Motomura+Namba+Branch/@34.6672171,135.4946585,15z/data=!4m6!3m5!1s0x6000e76b53bc67e9:0xc718ee6b423ad7d3!8m2!3d34.666617!4d135.5019741!16s%2Fg%2F11b90m03zh' }],
        },
        { slot: '下午', kind: 'shopping', title: '日本橋 → 道頓堀 → 難波', places: MINAMI },
        {
          slot: '晚餐', kind: 'food', title: '福太郎大阪燒',
          places: [{ name: '福太郎大阪燒', href: 'https://maps.app.goo.gl/Y3Dh1tC1rkqCa1Bm9' }],
          booking: { label: '大阪燒', status: 'walkin' },
        },
      ],
    },
    {
      date: '2026-11-18', city: '宇治 → 大阪', title: '任天堂博物館・Harukas・難波', stay: 'osaka',
      route: [OSAKA_HOTEL, [34.9033, 135.7928], [34.6459, 135.5135], NIPPONBASHI, DOTONBORI, NAMBA, OSAKA_HOTEL],
      items: [
        { slot: '早餐', kind: 'food', title: '客美多' },
        {
          slot: '早上', kind: 'activity', title: '任天堂博物館 → 中村藤吉',
          places: [{ name: '任天堂博物館', href: 'https://maps.app.goo.gl/1ZXgm46in6VeDpE39' }],
        },
        {
          slot: '下午', kind: 'sight', title: 'Harukas300 展望台 → 日本橋 → 道頓堀 → 難波',
          places: [{ name: 'Harukas300 展望台', query: 'ハルカス300 展望台' }, ...MINAMI],
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
        { slot: '晚餐', kind: 'food', title: '居酒屋', undecided: true },
      ],
    },
    {
      date: '2026-11-20', city: '神戶', title: '神戶動物王國・須磨海生館・夜景', stay: 'osaka',
      // 夜景與燒肉店沒有座標，只畫到神戶市區
      route: [OSAKA_HOTEL, [34.65464, 135.22255], [34.64414, 135.12824], [34.6946, 135.1956], OSAKA_HOTEL],
      tips: ['視天氣情況調整動物園及海生館之順序'],
      items: [
        {
          slot: '早上', kind: 'sight', title: '神戶動物王國',
          places: [{ name: '神戶動物王國', href: 'https://www.google.com/maps/place/%E7%A5%9E%E6%88%B6%E5%8B%95%E7%89%A9%E7%8E%8B%E5%9C%8B/@34.6546416,135.2199719,17z/data=!3m1!4b1!4m6!3m5!1s0x600091f82316e69b:0x8ea652d596843c4!8m2!3d34.6546416!4d135.2225468!16s%2Fm%2F080p796' }],
          booking: { label: '神戶動物王國', status: 'pending' },
        },
        {
          slot: '下午', kind: 'sight', title: '神戸須磨シーワールド（海生館）',
          places: [{ name: '神戸須磨シーワールド', href: 'https://www.google.com/maps/place/Kobe+Suma+Seaworld/@34.6464142,135.132383,15.47z/data=!4m14!1m7!3m6!1s0x600091f82316e69b:0x8ea652d596843c4!2z56We5oi25YuV54mp546L5ZyL!8m2!3d34.6546416!4d135.2225468!16s%2Fm%2F080p796!3m5!1s0x600085002a5f0c81:0xd0faa74aeef3b0c!8m2!3d34.6441384!4d135.1282411!16s%2Fg%2F11y3hwt9f6' }],
        },
        { slot: '晚上', kind: 'sight', title: '神戶夜景' },
        {
          time: '20:00', kind: 'food', title: '神戶牛燒肉 Kobe Beef Yakiniku WASSIA',
          places: [{ name: 'Kobe Beef Yakiniku WASSIA', href: 'https://maps.app.goo.gl/VPqaFaAZxttM15WFA' }],
          booking: { label: '神戶牛燒肉', status: 'booked' },
        },
      ],
    },
    {
      date: '2026-11-21', city: '大阪', title: '勝尾寺・梅田', stay: 'osaka',
      route: [OSAKA_HOTEL, [34.8654, 135.4910], [34.7025, 135.4959], OSAKA_HOTEL],
      items: [
        { slot: '早上', kind: 'sight', title: '勝尾寺', places: [{ name: '勝尾寺', query: '勝尾寺 箕面' }] },
        { slot: '午餐', kind: 'food', title: '壽司' },
        { slot: '下午', kind: 'shopping', title: '梅田逛街', places: [{ name: '梅田', query: '梅田 大阪' }] },
        { slot: '下午', kind: 'shopping', title: 'Alpen', undecided: true },
        { slot: '晚上', kind: 'shopping', title: '繼續梅田逛街' },
      ],
    },
    {
      date: '2026-11-22', city: '大阪', title: '返程',
      route: [OSAKA_HOTEL, NAMBA, KIX],
      items: [
        {
          slot: '早上', kind: 'train', title: '南海電鐵特急 Rapi:t：難波 → 關西機場',
          booking: { label: 'Rapi:t 車票', status: 'todo', href: 'https://hop2.fun/ZRfyvGWu' },
        },
        { time: '12:55–15:05', kind: 'flight', title: '回程航班 BR131' },
      ],
    },
  ],
});
