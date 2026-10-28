import { defineItinerary } from '../plan';
import type { ItineraryItem } from '../types';

/** 2026 九寨溝八日遊（6/12 – 6/19），旅行社團體行程，餐標為人民幣。 */

const BREAKFAST: ItineraryItem = { slot: '早餐', kind: 'food', title: '酒店早餐' };
const meal = (slot: '午餐' | '晚餐', title: string, rmb: number): ItineraryItem =>
  ({ slot, kind: 'food', title, notes: [`人民幣 ${rmb} 元`] });

export default defineItinerary({
  title: '2026 九寨溝八日遊',
  tagline: 'CHENGDU · JIUZHAIGOU · EMEI',
  tags: ['8 天 7 夜', '九寨溝', '黃龍', '樂山大佛', '熊貓基地'],
  theme: 'lake',
  timeZone: 'Asia/Shanghai',

  flights: [
    { label: '去程', date: '2026-06-12', number: 'BR765', from: '桃園 TPE', to: '成都 TFU', depart: '14:20', arrive: '18:05', notes: ['長榮航空，飛行時間約 3 小時 45 分鐘'] },
    { label: '回程', date: '2026-06-19', number: 'BR766', from: '成都 TFU', to: '桃園 TPE', depart: '19:20', arrive: '22:40', notes: ['長榮航空，飛行時間約 3 小時 20 分鐘'] },
  ],

  stays: [
    { id: 'chengdu-1', city: '成都', name: '成都保利公園皇冠假日酒店', nameEn: 'Crowne Plaza Chengdu Panda Garden', checkIn: '2026-06-12', checkOut: '2026-06-13', notes: ['電話 86-28-6179-8888'] },
    { id: 'jiuzhai', city: '九寨溝', name: '九寨綠發希爾頓花園酒店', nameEn: 'Hilton Garden Inn', checkIn: '2026-06-13', checkOut: '2026-06-15', notes: ['電話 86-837-7719777'] },
    { id: 'maoxian', city: '茂縣', name: '茂縣國際飯店', nameEn: 'Maoxian International Hotel', checkIn: '2026-06-15', checkOut: '2026-06-16', notes: ['電話 86-837-7427777'] },
    { id: 'emei', city: '峨嵋山', name: '峨眉山天境度假酒店', checkIn: '2026-06-16', checkOut: '2026-06-18', notes: ['電話 86-833-5365600'] },
    { id: 'chengdu-2', city: '成都', name: '成都保利公園皇冠假日酒店', nameEn: 'Crowne Plaza Chengdu Panda Garden', checkIn: '2026-06-18', checkOut: '2026-06-19', notes: ['電話 86-28-6179-8888'] },
  ],

  days: [
    {
      date: '2026-06-12', city: '桃園 → 成都', title: '桃園飛成都', stay: 'chengdu-1',
      route: [[25.0777, 121.2328], [30.3122, 104.4419], [30.5728, 104.0668]],
      items: [
        { time: '10:30', kind: 'car', title: '機場接機（共 4 人）', notes: ['前往桃園國際機場集合'] },
        { time: '14:20–18:05', kind: 'flight', title: '桃園（TPE）→ 成都（TFU）', notes: ['長榮航空 BR765', '飛行時間約 3 小時 45 分鐘'] },
        meal('晚餐', '成都風味', 50),
      ],
    },
    {
      date: '2026-06-13', city: '成都 → 九寨溝', title: '川青鐵路・松潘古城・九寨溝', stay: 'jiuzhai',
      route: [[30.5728, 104.0668], [32.6900, 103.6500], [32.6359, 103.6044], [33.2602, 103.9168]],
      items: [
        BREAKFAST,
        { slot: '上午', kind: 'train', title: '川青鐵路動車二等座，前往松潘站', notes: ['2023 年通車的新線路，貫穿岷江峽谷'] },
        { slot: '上午', kind: 'sight', title: '松潘古城', places: [{ name: '松潘古城', query: '松潘古城' }], notes: ['岷江畔的歷史邊城，茶馬古道重要驛站', '不上城樓'] },
        meal('午餐', '合菜風味', 50),
        { slot: '下午', kind: 'bus', title: '搭車前往九寨溝（約 92 km）' },
        meal('晚餐', '九寨風味', 60),
      ],
    },
    {
      date: '2026-06-14', city: '九寨溝', title: '九寨溝風景區一日遊', stay: 'jiuzhai',
      route: [[33.2602, 103.9168], [33.1564, 103.9170], [33.2602, 103.9168]],
      items: [
        BREAKFAST,
        {
          slot: '全天', kind: 'sight', title: '世界自然遺產：九寨溝風景區',
          places: [{ name: '九寨溝風景區', query: '九寨溝風景名勝區' }],
          notes: [
            '含環保公車',
            '融合原始森林、雪峰、鈣華湖泊的童話世界',
            '六絕：翠湖、疊瀑、彩林、雪峰、藏情、藍冰',
            { text: '景區內景點皆為套票，實際開放車遊及步行區域依景區規定', tone: 'muted' },
          ],
        },
        meal('午餐', '景區內自助餐', 60),
        meal('晚餐', '藏式土火鍋風味', 60),
      ],
    },
    {
      date: '2026-06-15', city: '九寨溝 → 茂縣', title: '九寨溝・黃龍・茂縣', stay: 'maoxian',
      route: [[33.2602, 103.9168], [32.7546, 103.8261], [31.6815, 103.8517]],
      items: [
        BREAKFAST,
        { slot: '上午', kind: 'bus', title: '從九寨溝出發前往松潘縣（約 94 km）' },
        {
          slot: '上午', kind: 'sight', title: '黃龍風景區',
          places: [{ name: '黃龍風景區', query: '黃龍風景名勝區' }],
          notes: ['含上行纜車與電瓶車', '世界自然遺產，有「人間瑤池」之稱', '海拔 3,576 m 的「五彩池」', '長達 1.3 km 的「金沙鋪地」鈣華景觀'],
        },
        meal('午餐', '合菜風味', 50),
        { slot: '下午', kind: 'bus', title: '搭車前往茂縣（約 174 km）' },
        meal('晚餐', '羌族風味', 60),
      ],
    },
    {
      date: '2026-06-16', city: '茂縣 → 峨嵋山', title: '古羌城・鐘書閣・峨嵋山', stay: 'emei',
      route: [[31.6815, 103.8517], [30.9886, 103.6233], [29.5994, 103.4844]],
      items: [
        BREAKFAST,
        { slot: '上午', kind: 'sight', title: '中國古羌城', places: [{ name: '中國古羌城', query: '中國古羌城 茂縣' }], notes: ['以羌族文化為核心的主題園區，展現古老民族的建築與生活'] },
        { slot: '上午', kind: 'sight', title: '仰天窩自拍熊貓與鐘書閣（約 215 km 車程）', notes: ['仰天窩：仰望熊貓打卡景點', '鐘書閣：號稱「中國最美書店」'] },
        meal('午餐', '合菜風味', 50),
        { slot: '下午', kind: 'bus', title: '前往峨嵋山（約 200 km）' },
        meal('晚餐', '柴火雞風味', 50),
      ],
    },
    {
      date: '2026-06-17', city: '峨嵋山 → 樂山', title: '樂山大佛・蘇稽古鎮・報國寺・伏虎寺', stay: 'emei',
      route: [[29.5994, 103.4844], [29.5447, 103.7720], [29.5994, 103.4844]],
      items: [
        BREAKFAST,
        { slot: '上午', kind: 'bus', title: '前往樂山（約 190 km）' },
        {
          slot: '上午', kind: 'sight', title: '樂山大佛（船遊）',
          places: [{ name: '樂山大佛', query: '樂山大佛' }],
          notes: ['世界文化與自然雙重遺產', '世界現存最大的石刻坐佛，彌勒佛像通高 71 m，面江而坐', { text: '若因水位問題停止開船，改為樂山大佛上山遊', tone: 'tip' }],
        },
        { slot: '中午', kind: 'sight', title: '蘇稽古鎮', places: [{ name: '蘇稽古鎮', query: '蘇稽古鎮' }] },
        meal('午餐', '翹腳牛肉風味', 50),
        {
          slot: '下午', kind: 'sight', title: '報國寺、伏虎寺',
          places: [{ name: '報國寺', query: '峨眉山 報國寺' }, { name: '伏虎寺', query: '峨眉山 伏虎寺' }],
          notes: ['含電瓶車'],
        },
        meal('晚餐', '酒店風味', 50),
      ],
    },
    {
      date: '2026-06-18', city: '峨嵋山 → 成都', title: '黃龍溪古鎮・寬窄巷子・IFS 翻牆熊貓', stay: 'chengdu-2',
      route: [[29.5994, 103.4844], [30.3556, 103.9750], [30.6716, 104.0590], [30.6532, 104.0795], [30.5728, 104.0668]],
      items: [
        BREAKFAST,
        { slot: '上午', kind: 'bus', title: '離開峨嵋山返回成都（約 190 km）' },
        { slot: '上午', kind: 'sight', title: '黃龍溪古鎮', places: [{ name: '黃龍溪古鎮', query: '黃龍溪古鎮' }], notes: ['古色古香的千年古鎮，融合川西民居與水鄉風情'] },
        meal('午餐', '古鎮風味', 50),
        { slot: '下午', kind: 'walk', title: '寬窄巷子', places: [{ name: '寬窄巷子', query: '寬窄巷子' }], notes: ['由寬巷子、窄巷子、井巷子組成，老成都現代與傳統交融的最佳視窗'] },
        { slot: '傍晚', kind: 'shopping', title: '太古里，打卡 IFS 翻牆熊貓', places: [{ name: 'IFS 翻牆熊貓', query: '成都國際金融中心 IFS 熊貓' }] },
        meal('晚餐', '四川鴛鴦火鍋風味', 80),
      ],
    },
    {
      date: '2026-06-19', city: '成都 → 桃園', title: '熊貓基地・東郊記憶・返程',
      route: [[30.5728, 104.0668], [30.7385, 104.1494], [30.6649, 104.1166], [30.3122, 104.4419], [25.0777, 121.2328]],
      items: [
        BREAKFAST,
        {
          slot: '上午', kind: 'sight', title: '熊貓基地',
          places: [{ name: '熊貓基地', query: '成都大熊貓繁育研究基地' }],
          notes: ['不含電瓶車', '全世界擁有大熊貓最多的生態公園，可隔著柵欄或玻璃窗觀看大熊貓'],
        },
        { slot: '上午', kind: 'sight', title: '東郊記憶文創園區', places: [{ name: '東郊記憶文創園區', query: '東郊記憶' }], notes: ['由老工業廠房改建而成的時尚文化地標'] },
        meal('午餐', '川菜風味', 50),
        { time: '19:20–22:40', kind: 'flight', title: '成都（TFU）→ 桃園（TPE）', notes: ['長榮航空 BR766', '飛行時間約 3 小時 20 分鐘'] },
        { time: '23:00', kind: 'car', title: '機場送機（共 4 人）', notes: ['滿載而歸，結束豐富的四川 8 日之旅'] },
      ],
    },
  ],
});
