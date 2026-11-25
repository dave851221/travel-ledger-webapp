import { describe, expect, it } from 'vitest'
import { buildConversation, prepareProposedExpenses } from './chat.ts'
import type { OutstandingDraft } from './types.ts'
import type { TripRow } from '../types.ts'

const trip: TripRow = {
  id: 't', name: '測試', access_code: null, members: ['代杰', '小明', '阿花'], categories: ['餐飲', '購物'],
  base_currency: 'TWD', rates: { TWD: 1, JPY: 0.21 }, precision_config: { TWD: 0, JPY: 0 }, is_archived: false,
  default_currency: 'JPY', created_at: '',
}

const draft: OutstandingDraft = {
  nonce: 'n1', tripId: 't', photoIds: ['expenses/t/a.jpg'], receipt: true,
  exp: { d: '伴手禮', a: 5690, c: 'JPY', dt: '2026-11-22', cat: '購物', p: { 代杰: 5690 }, s: { 代杰: 1897, 小明: 1897, 阿花: 1896 } },
  items: [{ name: '餅乾', amount: 2400 }, { name: '巧克力', amount: 2350 }, { name: '砂糖奶油餅', amount: 940 }],
  subtotal: 5690,
}

const expense = {
  description: '伴手禮', amount: 5690, currency: 'JPY', currency_source: 'none', date: '2026-11-22', category: '購物',
  payer_data: [{ member: '代杰', amount: 5690 }],
  split_details: [{ member: '代杰', amount: 1897 }, { member: '小明', amount: 1897 }, { member: '阿花', amount: 1896 }],
}
const scope = { trip, today: '2026-11-25', memberName: '代杰', cleanText: '第一項是小明的，其他平分', drafts: [draft] }

describe('prepareProposedExpenses — 逐項分（打字版）', () => {
  const expected = { 小明: 3497, 代杰: 1096, 阿花: 1097 }

  it('item_assignments 放在最外層', () => {
    const out = prepareProposedExpenses({
      expenses: [expense], corrects_draft: 'n1',
      item_assignments: [{ items: [0], members: ['小明'] }], others: ['代杰', '小明', '阿花'],
    }, scope)
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') {
      expect(out.proposals[0].expense.split_details).toEqual(expected)
      expect(out.proposals[0].photoIds).toEqual(['expenses/t/a.jpg'])
    }
  })

  it('模型把 item_assignments 塞進 expenses[0] 也照樣算', () => {
    const out = prepareProposedExpenses({
      expenses: [{ ...expense, item_assignments: [{ items: [0], members: ['小明'] }], others: ['代杰', '小明', '阿花'] }],
      corrects_draft: 'n1',
    }, scope)
    expect(out.kind === 'ok' && out.proposals[0].expense.split_details).toEqual(expected)
  })

  it('沒有草稿、聽起來像在改已存的那筆：交給管道列清單', () => {
    expect(prepareProposedExpenses({ expenses: [expense] }, { ...scope, drafts: [], cleanText: '剛剛那個改 250' }).kind).toBe('edit_existing')
  })
})

describe('buildConversation', () => {
  it('結尾沒得到回覆的 user 訊息丟掉，連續同角色合併', () => {
    const conv = buildConversation('ctx', [
      { role: 'model', content: 'a' }, { role: 'model', content: 'b' }, { role: 'user', content: '沒回到的' },
    ], '現在這句')
    expect(conv.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(conv[1].parts).toHaveLength(3)
    expect(conv[2].parts).toEqual([{ text: '現在這句' }])
  })
})

describe('unwrapFakeReplyCall', () => {
  it('把寫成文字的 reply(...) 拆回內容，其他原樣', async () => {
    const { unwrapFakeReplyCall, sanitizeReplyText } = await import('./chat.ts')
    expect(unwrapFakeReplyCall('reply({"text": "有 3 樣：\\n餅乾 ¥2,400"})')).toBe('有 3 樣：\n餅乾 ¥2,400')
    expect(unwrapFakeReplyCall('reply 一下')).toBe('reply 一下')
    expect(sanitizeReplyText('reply({"text":"好"})', '')).toBe('好')
  })
})
