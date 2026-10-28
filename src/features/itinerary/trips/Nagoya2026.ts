import { defineItinerary } from '../plan';
import type { ItineraryItem } from '../types';

/** 2026 名古屋賞櫻八日遊（4/4 – 4/11）。4/5–4/8 自駕，其餘搭鐵路。 */

const TOYOTA_NISHIKI = { name: 'トヨタレンタカー 名古屋錦店', href: 'https://maps.app.goo.gl/nz6e2Wtm3tsQWKLe9' };
const CENTRAIR = { name: '名古屋中部國際機場', href: 'https://maps.app.goo.gl/635wW51zWggo5w6V7' };
const KINTETSU_TICKETS = '[電子票券查詢](https://www.ticket.kintetsu.co.jp/vs/en/T/TZZ/TZZ10.do?op=tDisplayVisitorMenu)';
const HOTEL_BREAKFAST: ItineraryItem = { time: '06:30–09:30', kind: 'food', title: '早餐：飯店自助餐' };

export default defineItinerary({
  title: '2026 名古屋賞櫻八日遊',
  tagline: 'NAGOYA · GERO · TAKAYAMA · KANAZAWA · ISE',
  tags: ['8 天 7 夜', '自駕 4 天', '犬山祭', '白川鄉', '伊勢神宮'],
  theme: 'sakura',
  timeZone: 'Asia/Tokyo',

  flights: [
    { label: '去程', date: '2026-04-04', number: 'CI150', to: '名古屋 NGO', arrive: '21:05' },
    { label: '回程', date: '2026-04-11', number: 'CI155', from: '名古屋 NGO', depart: '12:20' },
  ],

  stays: [
    {
      id: 'keihan', city: '名古屋', name: '名古屋京阪飯店', checkIn: '2026-04-04', checkOut: '2026-04-05',
      href: 'https://maps.app.goo.gl/gJ6xeGAohoJNUeZW6',
      notes: [
        '入住時間 15:00–23:00',
        { text: '注意最晚入住時間 23:00（已通知飯店可能 23:00–00:00 才到）', tone: 'warn' },
      ],
    },
    {
      id: 'suimeikan', city: '下呂', name: '下呂溫泉水明館', checkIn: '2026-04-05', checkOut: '2026-04-06',
      href: 'https://maps.app.goo.gl/vasCkWmNQNxDN1bC7',
      notes: [
        '入住時間 14:00–19:00',
        '水明館 Mapcode：361 509 278*00',
        '可免費停車，入浴稅 ¥150、住宿稅 ¥200',
        {
          text: '豐富的[館內設施](https://www.suimeikan.co.jp/facilities/)，有三個公共浴池',
          items: [
            '臨川閣 3 階：[下留の湯](https://www.suimeikan.co.jp/hotspring/shimodame.php)',
            '飛泉閣 9 階：[展望大浴場](https://www.suimeikan.co.jp/hotspring/daitenboburo.php)',
            '山水閣 1 階：[野天風呂](https://www.suimeikan.co.jp/hotspring/noten.php)',
          ],
        },
      ],
    },
    {
      id: 'koko', city: '高山', name: 'KOKO飯店飛驒高山', checkIn: '2026-04-06', checkOut: '2026-04-07',
      href: 'https://maps.app.goo.gl/kAbdgtiB1k2weCL68',
      notes: [
        '入住時間 15:00–23:00',
        'Mapcode：191 195 893*25',
        '停車每晚 ¥1,000（僅接受電話預約），不過附近都有停車場',
        '入浴稅 ¥150，住宿稅 ¥100 或 ¥200',
      ],
    },
    {
      id: 'nono', city: '金澤', name: '御宿野乃 金澤天然溫泉飯店', checkIn: '2026-04-07', checkOut: '2026-04-08',
      href: 'https://maps.app.goo.gl/2QXYRxLwnEmYePPy8',
      notes: ['入住時間 15:00–03:00', 'Mapcode：41 558 059*88', '停車每晚 ¥1,500', '有免費蕎麥麵和冰棒可以吃'],
    },
    {
      id: 'comfort', city: '名古屋', name: 'Comfort Hotel Nagoya Shinkansenguchi', checkIn: '2026-04-08', checkOut: '2026-04-11',
      href: 'https://maps.app.goo.gl/z1fYhM3hFzkaPTk57',
      notes: ['15:00 後皆可入住', 'Mapcode：4 315 259*05', '若 20:00 前回到飯店，也可以提早還車'],
    },
  ],

  days: [
    {
      date: '2026-04-04', city: '名古屋', title: '抵達名古屋', stay: 'keihan',
      route: [[34.8584, 136.8053], [35.1429, 136.9014], [35.1738, 136.9080]],
      items: [
        { time: '14:00', kind: 'car', title: '送機專車到家（台灣時間）', notes: ['[Klook 訂單](https://www.klook.com/zh-TW/airport-transfers/order-details/?orderGuid=5411353041&bookingNo=NFP611467)'] },
        { time: '21:05', kind: 'flight', title: '到達名古屋中部國際機場', places: [CENTRAIR], notes: ['航班 CI150'] },
        {
          kind: 'train', slot: '機場 → 金山', title: '搭乘名鐵到金山站',
          notes: [
            {
              text: '主要分成三種列車',
              items: [
                {
                  text: '**特殊列車 μ-SKY（ミュースカイ）**，全車指定席',
                  items: [
                    'μ-SKY 請至 1 號專用月台（進閘門後右前方）',
                    '除了購買單程票（片道きっぷ）以外，還需要購買指定席券（特別車両券）',
                    '[購票攻略](https://nicklee.tw/1803/centrair-to-nagoya-usky/)',
                  ],
                },
                { text: '**特急**為紅白車，一半指定席一半自由座', items: ['第 2 或第 3 月台，直接西瓜卡或信用卡逼卡進站即可', 'CP 值較高'] },
                '**一般車**為全紅車（準急或急行），比較慢',
              ],
            },
            {
              text: '中部國際機場（TA24）至金山站（NH34）的班次',
              items: [
                '準急：21:22–22:06',
                'μ-SKY：21:37–22:01',
                { text: '特急：21:47–22:19（推薦 1）', tone: 'tip' },
                '準急：21:52–22:36',
                { text: 'μ-SKY：22:07–22:31（推薦 2）', tone: 'tip' },
              ],
            },
          ],
        },
        { kind: 'train', slot: '金山 → 久屋大通', title: '搭市營地下鐵紫色 M 名城線', notes: ['金山站至久屋大通約 12 分鐘'] },
      ],
    },
    {
      date: '2026-04-05', city: '犬山 → 下呂', title: '犬山祭與下呂溫泉', stay: 'suimeikan',
      route: [[35.1738, 136.9080], [35.3346, 136.8724], [35.3883, 136.9392], [35.8037, 137.2472], [35.8053, 137.2407]],
      items: [
        { time: '07:00–08:30', kind: 'food', title: '早餐：飯店自助餐' },
        { time: '09:00', kind: 'car', title: '租車取車：トヨタレンタカー 名古屋錦店', places: [TOYOTA_NISHIKI], notes: ['租車店 Mapcode：4 318 223*04'] },
        {
          kind: 'sight', slot: '上午', title: '前往犬山，在針綱神社前參加[犬山祭](https://aichinow.pref.aichi.jp/tw/spots/detail/67/)',
          places: [{ name: '針綱神社', href: 'https://maps.app.goo.gl/15vw277soSoqKwTUA' }],
          notes: [
            '有交通管制，停車非常不方便',
            { text: '可以在江南車站停車，再搭車前往（10 分鐘）', items: ['江南駅 Mapcode：4 885 720*20'] },
            { text: '最晚 16:30 一定要離開犬山，往下呂路上有車潮，否則會吃不到 19:30 的晚餐', tone: 'warn' },
          ],
        },
        {
          kind: 'sight', slot: '下午', title: '前往下呂溫泉合掌村',
          places: [{ name: '下呂溫泉合掌村', href: 'https://maps.app.goo.gl/j5yppFyy9DFANHpX7' }],
          notes: [
            '合掌村前駐車場 Mapcode：772 480 612*11',
            '營業時間 08:30–17:00（16:30 最後入場），也可以隔天再玩',
            '175 公尺溜滑梯：[森の滑り台](https://maps.app.goo.gl/jjT4CN7hjQXffTxS8)',
          ],
        },
        { time: '19:30', kind: 'food', title: '晚餐：飯店的懷石料理', notes: ['飛泉閣 1 階：[常磐](https://www.suimeikan.co.jp/cuisine/tokiwa/)（Tokiwa）'] },
      ],
    },
    {
      date: '2026-04-06', city: '下呂 → 高山', title: '高山飛驒牛之旅', stay: 'koko',
      route: [[35.8053, 137.2407], [36.1432, 137.2589], [36.1408, 137.2519]],
      items: [
        {
          time: '07:00–10:00', kind: 'food', title: '早餐：飯店和洋自助餐',
          notes: ['有規定分流時間', '飛泉閣 1 階：[常磐](https://www.suimeikan.co.jp/cuisine/tokiwa/)（Tokiwa）'],
        },
        { time: '11:00', kind: 'hotel', title: '退房' },
        {
          kind: 'car', slot: '中午', title: '前往高山（車程約 1 小時）',
          notes: [
            '[かみいち駐車場](https://maps.app.goo.gl/YXFu4SdTcyD4hJFC6) Mapcode：191 196 710*00',
            { text: '人很多，建議不要拖著行李箱逛', tone: 'warn' },
            {
              text: '**高山老街美食與逛街**（可以逛 2–3 小時）',
              items: [
                '飛驒牛壽司（[こって牛](https://maps.app.goo.gl/Pxs3mnfucH5NoBHz6) 或 [坂口屋](https://maps.app.goo.gl/SFeJ2CYpKiKi9BXz6)）',
                '飛驒牛串燒、五平餅（米上面塗甜醬油去烤）',
                '夢幻雪國布丁（[高山布丁亭](https://maps.app.goo.gl/3yFxhskWw8PftWbc6)，限量）',
                '清酒扭蛋機（[舩坂酒造店](https://maps.app.goo.gl/NgNuV7z1F63JgaXY8)）',
              ],
            },
          ],
        },
        {
          time: '12:00', kind: 'food', title: '午餐：朴葉味噌（飛驒著名鄉土料理）',
          notes: ['[寿々や（Suzuya）](https://maps.app.goo.gl/Ua1oXfTHiLke6GoZ7)', '[京や（Kyoya）](https://maps.app.goo.gl/6dYZWpnhbjUnjNvC6)'],
        },
        {
          time: '18:00', kind: 'food', title: '晚餐：飛驒牛燒肉', tag: '爸爸想吃味藏天國',
          notes: [
            { text: '[味藏天國](https://maps.app.goo.gl/a2HQMFCLiDqB3Crv7)', items: ['很熱門，建議 16:00 左右先來抽號碼牌'] },
            {
              text: '或是其他選擇',
              items: [
                {
                  text: '飛驒牛壽喜燒',
                  items: [
                    '[鳩谷（Hatoya）](https://maps.app.goo.gl/Vwvhm5i2kHbt1rfA8)：[YouTube 影片](https://youtu.be/tPTFTmVdQJQ?t=611)',
                    '[中橋 わかちや](https://maps.app.goo.gl/KNiP8HSkrBuFmnRg6)',
                  ],
                },
                '飛驒牛定食：[味之與平](https://maps.app.goo.gl/aurQQBco4ebRsvy6A)',
              ],
            },
          ],
        },
        {
          kind: 'food', slot: '宵夜', title: '21:00 前可以吃宵夜',
          notes: [{
            text: '高山拉麵（通常 20、21 點就差不多都關了）',
            items: ['[麵屋真菜](https://maps.app.goo.gl/TjfJocaRx78TukSY9)', '[中華そばM](https://maps.app.goo.gl/bkyyxjBq4RpiwnvG9)'],
          }],
        },
      ],
    },
    {
      date: '2026-04-07', city: '高山 → 金澤', title: '朝市、合掌村與金澤', stay: 'nono',
      route: [[36.1408, 137.2519], [36.1436, 137.2603], [36.2566, 136.9066], [36.5714, 136.6554], [36.5780, 136.6482]],
      items: [
        { time: '07:00–10:00', kind: 'food', title: '早餐：飯店自助餐' },
        { time: '11:00', kind: 'hotel', title: '退房' },
        {
          kind: 'shopping', slot: '早上', title: '逛宮川朝市',
          places: [{ name: '宮川朝市', href: 'https://maps.app.goo.gl/q1fiKeZcbMT7Jr9N6' }],
          notes: ['開放時間 07:00–12:00', '新鮮水果、飛驒娃娃（猿寶寶）', '[Koma Coffee 餅乾咖啡](https://maps.app.goo.gl/rSy1BZdaNoGPFsYX6)'],
        },
        {
          kind: 'car', slot: '下午', title: '前往白川鄉合掌村（車程約 50 分鐘）',
          places: [{ name: '白川鄉合掌村', href: 'https://maps.app.goo.gl/pUhmfF9xFMbxVaKr9' }],
          notes: [
            {
              text: '自駕要停在[村営せせらぎ公園駐車場](https://maps.app.goo.gl/k1oYCfwSs3pk7RN49)',
              items: ['Mapcode：549 018 409*44', { text: '下午 17:00 前需離場，停車費已漲價到 ¥2,000', tone: 'warn' }],
            },
            '在和田家旁可搭乘[展望台接駁車](https://maps.app.goo.gl/PoxUMDY3upq2nCqx9)',
            { text: '推薦店家', items: [{ text: '16:00 後店家就陸續打烊了', tone: 'warn' }, '[布丁的家](https://maps.app.goo.gl/9ZWK5jDtWg3gHK4a6)'] },
          ],
        },
        {
          kind: 'car', slot: '傍晚', title: '前往金澤，到近江町市場找東西吃',
          places: [{ name: '近江町市場', href: 'https://maps.app.goo.gl/vYXBD8Z1YVQrqKceA' }],
        },
      ],
    },
    {
      date: '2026-04-08', city: '金澤 → 名古屋', title: '兼六園、休息站巡禮與名花之里', stay: 'comfort',
      route: [[36.5780, 136.6482], [36.5621, 136.6627], [36.3533, 136.3113], [35.8398, 136.1947], [35.4984, 136.2163], [35.0844, 136.7027], [35.1709, 136.8815]],
      items: [
        { time: '06:30–10:00', kind: 'food', title: '早餐：飯店自助餐（海鮮丼飯、天婦羅吃到飽）' },
        { time: '11:00', kind: 'hotel', title: '退房' },
        {
          time: '11:00–12:30', kind: 'sight', title: '金澤兼六園',
          places: [{ name: '兼六園', href: 'https://maps.app.goo.gl/v7oXXWwbLEc9MtsA6' }],
          notes: ['[兼六停車場](https://maps.app.goo.gl/AUY8kAApkuAiJuzg6) Mapcode：41 530 064*12', '可以找海鮮店當午餐'],
        },
        {
          kind: 'car', slot: '下午', title: '開往名花之里，中途在休息站稍作停留',
          notes: [
            '[兼六園至名花之里的 Google 地圖路線](https://maps.app.goo.gl/H4di1BMzhhqF1ogC8)',
            '約 50 分鐘：[尼御前 SA（上り）](https://maps.app.goo.gl/QafTvMmLQbt3XRGB7) Mapcode：120 339 692*06',
            { text: '約 50 分鐘：[南条服務休息站（上行）](https://maps.app.goo.gl/RL2ERgGRahL6FcWE9) Mapcode：200 294 255*40', items: ['福井名產「羽二重餅」'] },
            { text: '約 40 分鐘：[賤ヶ岳 SA（上り）](https://maps.app.goo.gl/Dc7N8YNJNkhfLg7LA) Mapcode：192 386 015*38', items: ['滋賀名產「沙拉麵包」'] },
            { text: '約 75 分鐘：前往名花之里或先入住飯店', items: ['從飯店過去名花之里開車 30 分鐘，建議直接去名花之里'] },
          ],
        },
        {
          kind: 'sight', slot: '晚上', title: '名花之里',
          places: [{ name: '名花之里', href: 'https://maps.app.goo.gl/okKei19fipuBX7tP7' }],
          notes: ['Mapcode：38 894 443*56', '約 17:00 開始點燈，21:00 關門', '有免費超大停車場'],
        },
      ],
    },
    {
      date: '2026-04-09', city: '名古屋', title: '名古屋市區與鰻魚飯', stay: 'comfort',
      route: [[35.1709, 136.8815], [35.1705, 136.9032], [35.1264, 136.9089], [35.1709, 136.8815]],
      items: [
        HOTEL_BREAKFAST,
        { time: '09:00', kind: 'car', title: '還車：トヨタレンタカー 名古屋錦店', places: [TOYOTA_NISHIKI], notes: ['租車店 Mapcode：4 318 223*04'] },
        {
          kind: 'food', slot: '中午', title: '前往熱田神宮，到熱田蓬萊軒吃鰻魚飯',
          places: [{ name: '熱田神宮', query: '熱田神宮' }, { name: '熱田蓬萊軒', query: 'あつた蓬莱軒 本店' }],
        },
        { time: '12:20', kind: 'info', title: '華航開放報到選位' },
      ],
    },
    {
      date: '2026-04-10', city: '名古屋 → 伊勢', title: '伊勢神宮參拜', stay: 'comfort',
      route: [[35.1709, 136.8815], [34.9667, 136.6167], [34.4914, 136.7095], [34.4550, 136.7258], [34.4914, 136.7095], [34.9667, 136.6167], [35.1709, 136.8815]],
      tips: [{ text: '記得要吃赤福（紅豆泥裹麻糬）', tone: 'tip' }],
      items: [
        HOTEL_BREAKFAST,
        {
          time: '10:25–11:40', kind: 'train', title: '島風號：近鐵名古屋站 → 伊勢市站',
          notes: [KINTETSU_TICKETS, { text: '只買了特急券，當下要另外購買乘車券', tone: 'warn' }, '座位：5 車 5A、6A 與 2 車 5A、6A'],
        },
        { time: '11:50–12:30', kind: 'sight', title: '伊勢外宮參拜', places: [{ name: '伊勢外宮', query: '伊勢神宮 外宮' }] },
        { time: '12:50–14:00', kind: 'car', title: '坐計程車到伊勢內宮', places: [{ name: '伊勢內宮', query: '伊勢神宮 内宮' }] },
        {
          time: '14:00–15:50', kind: 'food', title: '托福橫丁與厄除町美食',
          places: [{ name: '托福橫丁', query: 'おかげ横丁' }],
          notes: ['這兩條街道就在內宮出口處', '赤福本店、伊勢烏龍麵、手捏壽司、松阪牛串燒／可樂餅'],
        },
        {
          time: '15:50–16:10', kind: 'car', title: '返回伊勢市站',
          notes: [{ text: '回程島風號不等人，建議 15:50 前就在內宮計程車站搭車回伊勢市站，避免公車塞車', tone: 'warn' }],
        },
        {
          time: '16:24–17:44', kind: 'train', title: '島風號：伊勢市站 → 近鐵名古屋站',
          notes: [
            KINTETSU_TICKETS,
            { text: '只買了特急券，當下要另外購買乘車券', tone: 'warn' },
            { text: '車票時間固定，要注意時間', tone: 'warn' },
            '座位：5 車 4B、4C、6B、6C',
          ],
        },
      ],
    },
    {
      date: '2026-04-11', city: '名古屋', title: '返程',
      route: [[35.1709, 136.8815], [34.8584, 136.8053]],
      items: [
        HOTEL_BREAKFAST,
        {
          kind: 'train', slot: '早上', title: '搭名鐵特殊列車 μ-SKY（ミュースカイ）到機場',
          notes: [
            '09:19–09:47 或 09:49–10:17，中間時段也有一般地鐵但比較慢',
            '[名鐵班次查詢](https://trainbus.meitetsu.co.jp/meitetsu-transfer-zh-tw/pc/transfer/TransferSearchSelect?orvName=%E5%90%8D%E9%90%B5%E5%90%8D%E5%8F%A4%E5%B1%8B%28NH36%29&orvNode=&dnvName=%E4%B8%AD%E9%83%A8%E5%9C%8B%E9%9A%9B%E6%A9%9F%E5%A0%B4%28TA24%29&dnvNode=&month=2026%2F4&day=11&hour=9&minute=0&basis=1&sort=0&wspeed=standard&method=0&unuse=&month_select=on&day_select=on&hour_select=on&minute_select=on)',
          ],
        },
        { time: '10:00', kind: 'flight', title: '到達名古屋中部國際機場', places: [CENTRAIR] },
        { time: '12:20', kind: 'flight', title: '飛機起飛，滿載而歸', notes: ['航班 CI155'] },
        { time: '14:30', kind: 'car', title: '接機專車到機場（台灣時間）', notes: ['[Klook 訂單](https://www.klook.com/zh-TW/airport-transfers/order-details/?orderGuid=5411398979&bookingNo=FPG611969)'] },
      ],
    },
  ],
});
