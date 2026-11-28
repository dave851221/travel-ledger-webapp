// ============================================================
// bind-card.ts —— 開放版「綁定」的選旅程卡片（Flex）
//
// 以前是 quick reply 小按鈕：顏色跟聊天背景混在一起、只看得到名字，
// 使用者不確定那是按鈕、也分不出是哪一趟（David 2026-11-28）。
// 改成一張卡片：每趟一列（日期章、名稱、日期與人數），整列都能點，右邊有明顯的「選這趟」。
// 純函式，不碰 Deno.env：網址由呼叫端傳入，vitest 直接測。
// ============================================================

import type { OutgoingMessage } from "./types.ts"

export interface BindableTrip {
  id: string
  name: string
  start_date?: string | null
  end_date?: string | null
  member_count?: number | null
}

export interface BindCardOptions {
  /** 群組／多人聊天室才說「這個群組」 */
  isGroup: boolean
  /** 目前綁定的旅程，標「綁定中」 */
  currentTripId?: string | null
  /** 沒列完時的總數 */
  total: number
  webUrl: string
  postbackPrefix: string
}

const INK = '#2b2118'
const MUTED = '#8c7b6b'
const ACCENT = '#e07a2e'
const ROW_BG = '#fff6ec'
const ROW_BG_CURRENT = '#fde7cf'
const CHIP_BG = '#ffffff'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
const md = (s: string) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`

/** "11/28（六）"、"11/28–12/2"、跨年 "2026/12/30–2027/1/2" */
export function tripDateLabel(start?: string | null, end?: string | null): string {
  if (!isDate(start)) return ''
  if (!isDate(end) || end === start) {
    const d = new Date(`${start}T00:00:00Z`)
    return `${start.slice(0, 4)}/${md(start)}（${WEEKDAYS[d.getUTCDay()]}）`
  }
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${start.slice(0, 4)}/${md(start)}–${end.slice(0, 4)}/${md(end)}`
  return `${start.slice(0, 4)}/${md(start)}–${md(end)}`
}

/** 名稱太長時截斷（Flex 會自動換行，但兩行以上整列太高） */
function clip(name: string, max = 40): string {
  const chars = Array.from(name.trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

function dateChip(t: BindableTrip) {
  const has = isDate(t.start_date)
  return {
    type: 'box', layout: 'vertical', width: '52px', height: '52px',
    backgroundColor: CHIP_BG, cornerRadius: '12px', justifyContent: 'center',
    borderColor: '#f3d9bf', borderWidth: '1px',
    contents: has
      ? [
        { type: 'text', text: `${Number(t.start_date!.slice(5, 7))}月`, size: 'xxs', color: MUTED, align: 'center' },
        { type: 'text', text: String(Number(t.start_date!.slice(8, 10))), size: 'lg', weight: 'bold', color: ACCENT, align: 'center' },
      ]
      : [{ type: 'text', text: '🧳', size: 'xl', align: 'center' }],
  }
}

function tripRow(t: BindableTrip, opts: BindCardOptions, index: number) {
  const current = t.id === opts.currentTripId
  const details = [
    tripDateLabel(t.start_date, t.end_date),
    t.member_count ? `${t.member_count} 人` : '',
  ].filter(Boolean).join(' · ')
  const name = clip(t.name)
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center',
    backgroundColor: current ? ROW_BG_CURRENT : ROW_BG, cornerRadius: '14px', paddingAll: '10px',
    ...(index > 0 ? { margin: 'md' } : {}),
    // 整列都能點，不必瞄準右邊的小按鈕
    action: { type: 'postback', label: '選這趟', data: `${opts.postbackPrefix}${t.id}`, displayText: `綁定「${name}」` },
    contents: [
      dateChip(t),
      {
        type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
        contents: [
          { type: 'text', text: name, size: 'md', weight: 'bold', color: INK, wrap: true, maxLines: 2 },
          ...(details ? [{ type: 'text', text: details, size: 'xs', color: MUTED, wrap: true }] : []),
          ...(current ? [{ type: 'text', text: '✓ 目前綁定中', size: 'xs', color: ACCENT, weight: 'bold' }] : []),
        ],
      },
      {
        type: 'box', layout: 'vertical', flex: 0, backgroundColor: ACCENT, cornerRadius: '20px',
        paddingTop: '6px', paddingBottom: '6px', paddingStart: '12px', paddingEnd: '12px',
        contents: [{ type: 'text', text: current ? '重選' : '選這趟', size: 'sm', color: '#ffffff', weight: 'bold' }],
      },
    ],
  }
}

export function buildBindPickerFlex(trips: BindableTrip[], opts: BindCardOptions): OutgoingMessage {
  const where = opts.isGroup ? '這個群組' : '這裡'
  const hidden = opts.total - trips.length
  return {
    type: 'flex',
    altText: `要把${where}綁定到哪一趟？點卡片上的旅程選一個`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '16px', paddingBottom: '8px', spacing: 'sm',
        contents: [
          { type: 'text', text: '🐾 要記到哪一趟？', size: 'lg', weight: 'bold', color: INK },
          {
            type: 'text', wrap: true, size: 'sm', color: MUTED,
            text: `點一趟旅程，${where}就會綁定它，之後在${where}記的帳都會存進那一趟。隨時再輸入「綁定」就能換。`,
          },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '4px',
        contents: trips.map((t, i) => tripRow(t, opts, i)),
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px', spacing: 'sm',
        contents: [
          {
            type: 'text', wrap: true, size: 'xs', color: MUTED, align: 'center',
            text: hidden > 0
              ? `只列出最近的 ${trips.length} 趟（還有 ${hidden} 趟）。不用的旅程可以到網頁封存。`
              : '沒看到想要的旅程？先到網頁建立，或用朋友給的邀請連結加入。',
          },
          {
            type: 'button', style: 'link', height: 'sm', color: ACCENT,
            action: { type: 'uri', label: '打開旅行小本本', uri: `${opts.webUrl}/` },
          },
        ],
      },
    },
  }
}
