import { defineItinerary } from '../plan';

/**
 * 2026 大阪環球賞楓之旅（11/14 – 11/22）
 *
 * 內容來自「1114-1122大阪.xlsx」（planA）與「1114-1122大阪補充資訊.md」，連結與票券以補充資訊為主
 * （2026-10-29 依最新版更新，地圖一律改用 maps.app.goo.gl 短網址）。
 * 資料沒寫的就不寫 —— 例如神戶夜景沒指定地點，就不給連結。
 */

const KIX: [number, number] = [34.4320, 135.2304];
const KYOTO_STATION: [number, number] = [34.9858, 135.7588];
const KYOTO_HOTEL: [number, number] = [34.99107, 135.76565];
const OSAKA_HOTEL: [number, number] = [34.66041, 135.50443];
const NIPPONBASHI: [number, number] = [34.6627, 135.5065];
const DOTONBORI: [number, number] = [34.6687, 135.5013];
const NAMBA: [number, number] = [34.6655, 135.5010];

const MINAMI = [
  { name: '日本橋', href: 'https://maps.app.goo.gl/L7n3LfB4YdY2y4ZT7' },
  { name: '道頓堀', href: 'https://maps.app.goo.gl/rtGMwDWyejQVUF5P6' },
  { name: '難波', href: 'https://maps.app.goo.gl/KwgBkd9idkkNccM47' },
];

const TROCCO_SAGA = '[トロッコ嵯峨](https://maps.app.goo.gl/rNiHpuc9GJQaoSjQA)';
const TROCCO_KAMEOKA = '[トロッコ亀岡](https://maps.app.goo.gl/UYSx1BSnVRCHXKne9)';

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
      href: 'https://maps.app.goo.gl/6wTzhRoADPGRYqLVA',
      notes: ['最晚 11:00 退房'],
    },
    {
      id: 'osaka',
      city: '大阪',
      name: 'Comfy House Namba',
      address: 'Nipponbashinishi 1-1-8 1F',
      checkIn: '2026-11-17',
      checkOut: '2026-11-22',
      href: 'https://maps.app.goo.gl/Tg3927BbvTzgnXWr9',
      notes: ['最晚 11:00 退房'],
    },
  ],

  // 「各預訂狀況」分頁裡有填內容的列；狀態「請選擇」顯示為未確認
  bookings: [
    { date: '2026-11-14', time: '17:44', category: '交通', item: 'Haruka 車票（關西機場到京都）', status: 'booked' },
    { date: '2026-11-15', category: '交通', item: '嵐山嵯峨野觀光小火車', status: 'paid' },
    { date: '2026-11-16', time: '18:00', category: '大吃大喝', item: '壽喜燒（Moritaya - Kiyamachi）', status: 'booked' },
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
    { text: '待辦', tone: 'warn', items: ['Haruka 車票要劃位', '南海特急要劃位'] },
    '還沒排進的：生魚片（可以排在任何一天的午餐）',
    '各種早餐、午餐、晚餐都還能再排；標「未定」的是還沒決定的餐廳或店家。',
  ],

  days: [
    {
      date: '2026-11-14', city: '京都', title: '出發，抵達京都', stay: 'kyoto',
      route: [KIX, KYOTO_STATION, KYOTO_HOTEL],
      items: [
        { time: '13:30–16:55', kind: 'flight', title: '去程航班 BR130' },
        {
          time: '17:44–19:04', kind: 'train', title: 'HARUKA 特急 → 京都',
          booking: { label: 'Haruka 車票', status: 'booked' },
          notes: [
            'Haruka 44 号：關西機場 17:44 出發 → 京都 19:04 抵達',
            '[時刻表](https://japantravel.navitime.com/zh-tw/area/jp/depArrTimeList/00001353/00001756/00000047?direction=up&date=2026-11-14&hour=17)',
            '[車票連結](https://guest-ui.west-qr.com/#/)（需綁定帳號）',
          ],
        },
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
            { name: '清水寺', href: 'https://maps.app.goo.gl/xfrJi2qATBTyw9Ay7' },
            { name: '八坂庚申堂', href: 'https://maps.app.goo.gl/oHpHDhpxTSBDZ5td6' },
          ],
        },
        {
          slot: '下午', kind: 'walk', title: '二年坂 → 三年坂',
          places: [
            { name: '二年坂', href: 'https://maps.app.goo.gl/vXHcFajYVzo2P1z99' },
            { name: '三年坂', href: 'https://maps.app.goo.gl/ifnYAFvQgwySZFMv7' },
          ],
        },
        {
          time: '16:02–16:25', kind: 'train', title: '嵐山小火車：嵯峨 → 亀岡',
          booking: { label: '嵐山嵯峨野觀光小火車', status: 'paid', href: 'https://linkt.to/h3hbgyeo' },
          notes: [
            `嵯峨野 15 号，1 号車 10A、10B、10C、10D`,
            `${TROCCO_SAGA} 16:02 出發 → ${TROCCO_KAMEOKA} 16:25 抵達`,
            '[車票連結](https://linkt.to/h3hbgyeo)',
          ],
        },
        {
          time: '17:43–18:12', kind: 'train', title: '嵐山小火車：亀岡 → 嵯峨',
          booking: { label: '嵐山嵯峨野觀光小火車', status: 'paid', href: 'https://linkt.to/i4J77ch5' },
          notes: [
            `嵯峨野 82 号，1 号車 12A、12B、12C、12D`,
            `${TROCCO_KAMEOKA} 17:43 出發 → ${TROCCO_SAGA} 18:12 抵達`,
            '[車票連結](https://linkt.to/i4J77ch5)',
          ],
        },
        {
          slot: '晚上', kind: 'sight', title: '嵐山',
          places: [{ name: '嵐山', query: '嵐山 京都' }],
        },
      ],
    },
    {
      date: '2026-11-16', city: '京都', title: '下鴨神社・金閣寺・鴨川', stay: 'kyoto',
      route: [KYOTO_HOTEL, [35.0391, 135.7727], [35.0394, 135.7292], [35.00133, 135.76696], [35.0037, 135.7690], [35.0040, 135.77462], [35.0040, 135.7717], [35.00946, 135.77063], KYOTO_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '下鴨神社（賀茂御祖神社） → 金閣寺',
          places: [
            { name: '下鴨神社（賀茂御祖神社）', href: 'https://maps.app.goo.gl/rzCK1TSHp7kfS2Fw8' },
            { name: '金閣寺', href: 'https://maps.app.goo.gl/SV5ZpxeHYqGJnCHW7' },
          ],
        },
        {
          slot: '午餐', kind: 'food', title: '豬一拉麵',
          places: [{ name: '豬一拉麵', href: 'https://maps.app.goo.gl/vYGfYbx2tbbdWvyD6' }],
        },
        {
          slot: '下午', kind: 'walk', title: '河原町 → Ousu之里 衹園本店 → 鴨川',
          places: [
            { name: '河原町', query: '河原町 京都' },
            { name: 'Ousu之里 衹園本店', href: 'https://maps.app.goo.gl/F3jqQLNjzk5isDPb7' },
            { name: '鴨川', href: 'https://maps.app.goo.gl/bjWGofV3mRitE5t39' },
          ],
        },
        {
          time: '18:00', kind: 'food', title: '壽喜燒（Moritaya - Kiyamachi）',
          places: [{ name: 'Moritaya - Kiyamachi', href: 'https://maps.app.goo.gl/4cFAHBX9MJjnx4Mx9' }],
          booking: { label: '壽喜燒', status: 'booked' },
          notes: [
            '預約：Moritaya 木屋町店，11/16（一）18:00，4 人，餐桌',
            {
              text: '餐點：壽喜燒 竹（JPY 7,700）',
              items: ['前菜、肉類料理（150 克）、蔬菜、雞蛋、白飯、赤味噌湯、醃漬小菜、甜點'],
            },
            '地址：京都府京都市中京區木屋町三條上ル上大阪町531',
            '電話：+81 75-231-5118',
          ],
        },
      ],
    },
    {
      date: '2026-11-17', city: '京都 → 大阪', title: '伏見稻荷，移動到大阪', stay: 'osaka',
      route: [KYOTO_HOTEL, [34.96769, 135.77919], OSAKA_HOTEL, [34.66662, 135.50197], NIPPONBASHI, DOTONBORI, NAMBA, OSAKA_HOTEL],
      items: [
        {
          slot: '早上', kind: 'sight', title: '伏見稻荷神社',
          places: [{ name: '伏見稻荷神社', href: 'https://maps.app.goo.gl/pNZF7B9Zbp8Tyez19' }],
        },
        { slot: '早上', kind: 'hotel', title: '退房、前往大阪', notes: ['最晚 11:00 退房', '待確認行李寄放'] },
        {
          slot: '午餐', kind: 'food', title: '牛かつもと村 難波店（炸牛排）',
          places: [{ name: '牛かつもと村 難波店', href: 'https://maps.app.goo.gl/7duoLoUn5CSrUkvLA' }],
        },
        { slot: '下午', kind: 'shopping', title: '日本橋 → 道頓堀 → 難波', places: MINAMI },
        {
          slot: '晚餐', kind: 'food', title: '福太郎大阪燒',
          places: [{ name: '福太郎大阪燒', href: 'https://maps.app.goo.gl/uRegVkX2Zh9UC9EM9' }],
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
          places: [{ name: '任天堂博物館', href: 'https://maps.app.goo.gl/mtRPmZq8jynFNbTw6' }],
        },
        {
          slot: '下午', kind: 'sight', title: 'Harukas300 展望台 → 日本橋 → 道頓堀 → 難波',
          places: [{ name: 'Harukas300 展望台', href: 'https://maps.app.goo.gl/PpGe7zMmhN8f9TYj8' }, ...MINAMI],
        },
      ],
    },
    {
      date: '2026-11-19', city: '大阪', title: '環球影城一整天', stay: 'osaka',
      route: [OSAKA_HOTEL, [34.6654, 135.4323], OSAKA_HOTEL],
      items: [
        {
          slot: '全天', kind: 'activity', title: '環球影城',
          places: [{ name: '環球影城', href: 'https://maps.app.goo.gl/9vBUnX1AUb3YRxzv7' }],
          booking: { label: '門票＋快通', status: 'paid' },
          notes: [
            {
              text: '**快速通關時段**',
              items: [
                '超級任天堂世界園區保證入場券：16:50–17:50',
                '瑪利歐賽車：庫巴的挑戰書：16:50–17:20',
                '咚奇剛的瘋狂礦車™：17:20–17:50',
              ],
            },
            {
              text: '另外可使用',
              items: ['哈利波特禁忌之旅™或飛天翼龍（擇一）', '大白鯊或侏羅紀公園 - 乘船遊（擇一）'],
            },
          ],
        },
        { slot: '晚餐', kind: 'food', title: '居酒屋', undecided: true },
      ],
    },
    {
      date: '2026-11-20', city: '神戶', title: '神戶動物王國・須磨海生館・夜景', stay: 'osaka',
      // 夜景沒有指定地點，只畫到神戶市區
      route: [OSAKA_HOTEL, [34.65464, 135.22255], [34.64414, 135.12824], [34.6946, 135.1956], OSAKA_HOTEL],
      tips: ['視天氣情況調整動物園及海生館之順序'],
      items: [
        {
          slot: '早上', kind: 'sight', title: '神戶動物王國',
          places: [{ name: '神戶動物王國', href: 'https://maps.app.goo.gl/175zih4p6cow5kLS7' }],
          booking: { label: '神戶動物王國', status: 'pending' },
        },
        {
          slot: '下午', kind: 'sight', title: '神戸須磨シーワールド（海生館）',
          places: [{ name: '神戸須磨シーワールド', href: 'https://maps.app.goo.gl/aFjuNzHGV4rNgF1S9' }],
        },
        { slot: '晚上', kind: 'sight', title: '神戶夜景' },
        {
          time: '20:00', kind: 'food', title: '神戶牛燒肉 Kobe Beef Yakiniku WASSIA',
          places: [{ name: 'Kobe Beef Yakiniku WASSIA', href: 'https://maps.app.goo.gl/fYpqB6LS7YjoisJJA' }],
          booking: { label: '神戶牛燒肉', status: 'booked' },
        },
      ],
    },
    {
      date: '2026-11-21', city: '大阪', title: '勝尾寺・梅田', stay: 'osaka',
      route: [OSAKA_HOTEL, [34.8654, 135.4910], [34.7025, 135.4959], OSAKA_HOTEL],
      items: [
        { slot: '早上', kind: 'sight', title: '勝尾寺', places: [{ name: '勝尾寺', href: 'https://maps.app.goo.gl/cJY5n3fmgv9wEvfTA' }] },
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
        { slot: '早上', kind: 'hotel', title: '退房', notes: ['最晚 11:00 退房'] },
        {
          slot: '早上', kind: 'train', title: '南海電鐵特急 Rapi:t α：難波 → 關西機場',
          booking: { label: 'Rapi:t 車票', status: 'todo', href: 'https://hop2.fun/ZRfyvGWu' },
          notes: ['06:00 開始每半小時一班，搭乘約 38 分鐘到機場', '[車票連結](https://hop2.fun/ZRfyvGWu)'],
        },
        { time: '12:55–15:05', kind: 'flight', title: '回程航班 BR131' },
      ],
    },
  ],
});
