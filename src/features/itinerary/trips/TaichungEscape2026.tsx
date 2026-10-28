import { defineItinerary } from '../plan';
import RailStops from '../blocks/RailStops';

/**
 * 2026 台中密室逃脫兩日遊（5/3 – 5/4）。
 *
 * 只有兩天、沒有航班與清單，所以頁面打開就是每日行程，沒有一覽與行前分頁。
 * 高鐵時刻用客製區塊（blocks/RailStops）畫成一條路線，示範格式裝不下的內容怎麼插進去。
 */

const WASABI = { name: '哇沙謎江戶時代館', href: 'https://maps.app.goo.gl/3iQiAwoHwkJobXfZ8' };

export default defineItinerary({
  title: '2026 台中密室逃脫兩日遊',
  tagline: 'TAICHUNG · ESCAPE ROOMS',
  tags: ['兩天四場密室'],
  theme: 'mystery',
  timeZone: 'Asia/Taipei',

  stays: [
    {
      id: 'champs', city: '台中', name: '台中香榭驪舍大飯店', nameEn: 'Champs Elysees Hotel',
      checkIn: '2026-05-03', checkOut: '2026-05-04',
      href: 'https://maps.app.goo.gl/HR7t5Z2jLWGax2MJ9',
      notes: ['家庭房：5 張大床', '離一中街夜市很近，晚上可以散步去逛！'],
    },
  ],

  days: [
    {
      date: '2026-05-03', city: '台北 → 台中', title: '南下台中，兩場密室', stay: 'champs',
      items: [
        {
          time: '09:21–10:25', kind: 'train', title: '搭高鐵南下台中',
          extra: <RailStops stops={[{ station: '台北', time: '09:21' }, { station: '桃園', time: '09:43' }, { station: '台中', time: '10:25' }]} />,
        },
        {
          time: '14:00–16:00', kind: 'activity', title: '密室《[惠貞女子高校](https://escape.bar/game/11284)》',
          places: [{ name: 'Loop 迴圈工作室－旗艦館', href: 'https://maps.app.goo.gl/ucAiDGpN1eQ1j3Sp9' }],
          notes: ['無訂金，尾款僅收現金 $5,200'],
        },
        {
          time: '17:00–19:00', kind: 'activity', title: '密室《[暗影潛行](https://escape.bar/game/19923)》',
          places: [{ name: 'Escer 異世客華美店', href: 'https://maps.app.goo.gl/xis6Bm8t4nXAe5rAA' }],
          notes: ['訂金 $1,000，尾款僅收現金 $7,000'],
        },
      ],
    },
    {
      date: '2026-05-04', city: '台中', title: '哇沙謎江戶時代館，連闖兩關',
      items: [
        {
          time: '10:30–12:30', kind: 'activity', title: '密室《[時光列車](https://escape.bar/game/24458)》',
          places: [WASABI],
          notes: [{ text: '全程必須脫鞋進場', tone: 'warn' }, '訂金 $1,000，尾款 $5,400'],
        },
        {
          time: '14:00–16:40', kind: 'activity', title: '密室《[冒險王](https://escape.bar/game/12483)》',
          places: [WASABI],
          notes: [
            '面對「普羅眼鏡綠色招牌左邊」的「轉角大樓梯」走下去邊日式建築',
            { text: '請提早 10 分鐘上廁所，附近 7-11 及工作室樓梯下方有廁所', tone: 'tip' },
            { text: '有眾多攀爬，不要穿裙子', tone: 'warn' },
            { text: '全程脫鞋子、脫襪子', tone: 'warn' },
            '遊戲過程中如果有危險動作或夥伴之間沒有幫忙，有可能會全濕',
            '訂金 $2,000，尾款 $6,000',
          ],
        },
      ],
    },
  ],
});
