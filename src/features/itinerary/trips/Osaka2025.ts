import { defineItinerary } from '../plan';

/** 2025 京阪天橋立八日遊（3/8 – 3/15）。 */

export default defineItinerary({
  title: '2025 京阪天橋立八日遊',
  tagline: 'KYOTO · AMANOHASHIDATE · OSAKA',
  tags: ['8 天 7 夜', '京都 3 晚', '大阪 4 晚', '和服體驗', '環球影城'],
  theme: 'plum',
  timeZone: 'Asia/Tokyo',

  flights: [
    { label: '去程', date: '2025-03-08', number: '樂桃航空', to: '關西 KIX', arrive: '13:10', notes: ['無附餐'] },
  ],

  stays: [
    {
      id: 'kyoto', city: '京都', name: '京都八條都酒店', checkIn: '2025-03-08', checkOut: '2025-03-11',
      href: 'https://maps.app.goo.gl/GEE1szfN4ezpLVHLA',
      notes: [
        '[Trip 訂單](https://tw.trip.com/hotels/ctorderdetail?orderid=1616320064250765&tripsignature=AAEAAQAHb3JkZXJpZIDygk9uaSP5AS4lwdE5hE7GZtq_dxLfyuDNpA_9BHRY-tripsign&curr=TWD&locale=zh-TW)',
        '雙人房 $3,548（含早餐）',
      ],
    },
    {
      id: 'osaka', city: '大阪', name: '大阪難波道頓堀佛沙飯店', checkIn: '2025-03-11', checkOut: '2025-03-15',
      href: 'https://maps.app.goo.gl/kBLrawFN8bx9Skpu6',
      notes: [
        '[Agoda 訂單](https://www.agoda.com/zh-tw/account/editbooking.html?bookingId=0xHOHYcFxgfy%20z0zP5staw%3D%3D&af_sub3=09122f93-b443-49c3-ad46-0e276fb3e0c8&af_sub1=EXP-ID-AM-7193-B&c=CONFIRMATION_EMAIL_ONELINK&pid=redirect&deep_link_value=agoda%3A%2F%2Fhome%2F&af_sub4=Hotel&af_force_deeplink=true)',
        '雙人房 $3,538（不含早餐）',
      ],
    },
  ],

  days: [
    {
      date: '2025-03-08', city: '京都', title: '抵達京都', stay: 'kyoto',
      route: [[34.4320, 135.2304], [34.9858, 135.7588]],
      items: [
        {
          time: '07:00', kind: 'car', title: '桃園機場送機',
          notes: ['[預約單](https://24tms.vlimo.com.tw/OrderData/ug_Order_Info_0.aspx?ID=D7AEE3BA651C38C487395302E983466DD45E54AB75817D8A6DE09E3413441FDA463BC6B3193738464F0B3C3CB4206C7CD5AA40E6429D9860)', '樂桃航空（無附餐）'],
        },
        { time: '13:10', kind: 'flight', title: '抵達關西機場（KIX）' },
        { time: '14:14–15:34', kind: 'train', title: '搭 Haruka 前往京都車站', notes: ['約 30 分鐘一班', { text: '提醒：買好西瓜卡搭 JR', tone: 'tip' }] },
        { slot: '晚上', kind: 'shopping', title: '京都車站逛街', places: [{ name: '京都車站', query: '京都駅' }] },
      ],
    },
    {
      date: '2025-03-09', city: '京都', title: '京都嵐山半日遊', stay: 'kyoto',
      route: [[34.9858, 135.7588], [35.0130, 135.6717], [34.9858, 135.7588]],
      items: [
        { time: '09:11', kind: 'train', title: 'JR 京都站發車，前往嵐山', notes: ['09:50 在[嵐山火車站](https://maps.app.goo.gl/ZvmMGwQFdHuw2ypb6)內集合'] },
        {
          time: '10:02', kind: 'activity', title: '嵐山小火車、京馬車與保津川遊船',
          booking: { label: 'KKday 訂單', href: 'https://www.kkday.com/zh-tw/order/show/25KK202942671', status: 'paid' },
          notes: ['10:02–10:25 嵯峨站 → 亀岡站', '10:35 搭乘京馬車', '11:00 搭乘保津川遊船', '12:30–13:30 渡月橋解散'],
        },
        { slot: '午餐', kind: 'food', title: '鰻魚飯、豆腐' },
        {
          slot: '下午', kind: 'sight', title: '渡月橋、嵐山竹林與附近逛街',
          places: [{ name: '渡月橋', query: '渡月橋' }, { name: '嵐山竹林', query: '竹林の小径 嵐山' }],
        },
        { slot: '晚上', kind: 'train', title: '搭 JR 回京都車站休息' },
      ],
    },
    {
      date: '2025-03-10', city: '京都', title: '京都東邊和服體驗', stay: 'kyoto',
      route: [[34.9858, 135.7588], [34.9949, 135.7850], [35.0050, 135.7650], [34.9858, 135.7588]],
      items: [
        { time: '09:00', kind: 'bus', title: '前往夢京都', notes: ['或 08:40 搭 206 公車'] },
        { time: '09:30', kind: 'activity', title: '夢京都租和服', places: [{ name: '夢京都', href: 'https://maps.app.goo.gl/JwRC19tT6tZiPzPx9' }], notes: ['17:30 前歸還'] },
        { slot: '上午', kind: 'sight', title: '清水寺參拜', places: [{ name: '清水寺', query: '清水寺' }] },
        { time: '14:00', kind: 'food', title: '歸還和服、吃午餐' },
        { slot: '下午', kind: 'shopping', title: '錦市場逛街', places: [{ name: '錦市場', query: '錦市場' }], notes: ['可搭巴士、走路或叫 Uber'] },
        { slot: '晚上', kind: 'hotel', title: '回飯店收行李', notes: [{ text: '晚上要收行李！', tone: 'warn' }] },
      ],
    },
    {
      date: '2025-03-11', city: '京都 → 天橋立 → 大阪', title: '天橋立一日遊，移往大阪', stay: 'osaka',
      route: [[34.9858, 135.7588], [35.5684, 135.1919], [35.6750, 135.2850], [34.6687, 135.5013]],
      items: [
        {
          time: '09:00', kind: 'bus', title: '京都車站上遊覽車', notes: ['飯店 11:00 前需退房'],
          booking: { label: 'KKday 天橋立一日遊訂單', href: 'https://www.kkday.com/zh-tw/order/show/25KK204322515', status: 'paid' },
        },
        { time: '11:00', kind: 'sight', title: '天橋立飛龍展望台', places: [{ name: '天橋立', query: '天橋立ビューランド' }], notes: ['午餐自理'] },
        { time: '14:00', kind: 'activity', title: '搭伊根灣觀光遊覽船（25 分鐘）', places: [{ name: '伊根灣', query: '伊根湾めぐり遊覧船' }] },
        { time: '18:30', kind: 'food', title: '大阪蟹道樂東店解散', places: [{ name: '蟹道樂東店', query: 'かに道楽 東店' }] },
      ],
    },
    {
      date: '2025-03-12', city: '大阪', title: '環球影城', stay: 'osaka',
      route: [[34.6687, 135.5013], [34.6654, 135.4323], [34.6687, 135.5013]],
      items: [
        { time: '06:00', kind: 'car', title: '叫車前往環球影城' },
        {
          time: '08:30', kind: 'activity', title: '入場環球影城',
          places: [{ name: '環球影城', query: 'Universal Studios Japan' }],
          booking: { label: 'KKday 訂單', href: 'https://www.kkday.com/zh-tw/order/show/25KK224332307', status: 'paid' },
          notes: ['門票電子檔：[Google Drive](https://drive.google.com/drive/folders/1_KIW0SAr_1XS1ER8PqCJ9hrjUu-ObPUY?usp=drive_link)'],
        },
        { slot: '晚上', kind: 'food', title: '鳥貴族（燒肉）' },
      ],
    },
    {
      date: '2025-03-13', city: '大阪', title: '大阪市區一日遊（周遊卡）', stay: 'osaka',
      route: [[34.6687, 135.5013], [34.6653, 135.5058], [34.6525, 135.5063], [34.6458, 135.5139], [34.6687, 135.5013]],
      items: [
        { slot: '出門前', kind: 'info', title: '啟用兩日大阪周遊卡', notes: ['[Surutto QRtto](https://linkt.to/XsXqF24W)'] },
        { time: '08:00–10:00', kind: 'food', title: '黑門市場', places: [{ name: '黑門市場', query: '黒門市場' }] },
        { time: '10:00–13:00', kind: 'sight', title: '通天閣逛街', places: [{ name: '通天閣', query: '通天閣' }] },
        { time: '12:45', kind: 'info', title: '華航選位置（用 APP）' },
        { time: '13:00–14:00', kind: 'shopping', title: '阿倍野商圈', places: [{ name: '阿倍野', query: 'あべのハルカス' }] },
        {
          slot: '晚上', kind: 'sight', title: '道頓堀、心齋橋',
          places: [{ name: '道頓堀', query: '道頓堀' }, { name: '心齋橋', query: '心斎橋筋商店街' }],
          notes: ['道頓堀水上觀光船 11:00–21:00'],
        },
      ],
    },
    {
      date: '2025-03-14', city: '大阪', title: '大阪市區自由行', stay: 'osaka',
      route: [[34.6687, 135.5013], [34.6873, 135.5262], [34.7024, 135.4959], [34.6687, 135.5013]],
      items: [
        { time: '09:00–11:00', kind: 'sight', title: '天滿宮（或天守閣）', places: [{ name: '天滿宮', query: '大阪天満宮' }, { name: '天守閣', query: '大阪城天守閣' }] },
        { time: '11:00–14:00', kind: 'shopping', title: '梅田商圈百貨', places: [{ name: '梅田', query: '梅田 大阪' }] },
        { slot: '下午', kind: 'walk', title: '天神橋筋商店街', places: [{ name: '天神橋筋商店街', query: '天神橋筋商店街' }] },
      ],
    },
    {
      date: '2025-03-15', city: '大阪', title: '準備回程',
      route: [[34.6687, 135.5013], [34.6641, 135.5013], [34.4320, 135.2304]],
      items: [
        { time: '09:00', kind: 'hotel', title: '退房' },
        { time: '09:28–10:08', kind: 'train', title: '南海特急 Rapit：難波站 → 關西機場', notes: ['[Surutto QRtto](https://linkt.to/kJ3yCdq1)'] },
        {
          time: '15:00', kind: 'car', title: '桃園機場接機',
          notes: ['[預約單](https://24tms.vlimo.com.tw/OrderData/ug_Order_Info_0.aspx?ID=85D45F568A0B724623927156AA2A8DC614D746122E670E68358B0C8BD817CE304994D5815FC8BF457FA506E062CAC4509BCA929A0936A8B3)'],
        },
        { slot: '晚上', kind: 'info', title: '回到溫暖的家' },
      ],
    },
  ],
});
