import { describe, expect, it } from 'vitest'
import { cleanDraft, cleanDrafts, cleanHistory, cleanMemberName, cleanReplyTarget, isTripPhotoPath } from './payload.ts'

const TRIP = '11111111-2222-3333-4444-555555555555'

describe('web-chat payload', () => {
  it('照片只收這趟旅程資料夾裡的', () => {
    expect(isTripPhotoPath(`expenses/${TRIP}/chat_a.jpg`, TRIP)).toBe(true)
    expect(isTripPhotoPath('expenses/other/chat_a.jpg', TRIP)).toBe(false)
    expect(isTripPhotoPath(`expenses/${TRIP}/../other/a.jpg`, TRIP)).toBe(false)
    expect(isTripPhotoPath(42, TRIP)).toBe(false)
  })

  it('草稿：形狀收斂、別趟的照片丟掉、品項照 itemSplit 規則', () => {
    const d = cleanDraft({
      nonce: 'abc',
      exp: { d: '拉麵', a: '1200', c: 'JPY', dt: '2026-11-20', cat: '餐飲', p: { 代杰: 1200, bad: 'x' }, s: { 代杰: 600, 艷櫻: 600 } },
      photoIds: [`expenses/${TRIP}/a.jpg`, 'expenses/x/b.jpg'],
      receipt: true,
      items: [{ name: '拉麵', amount: 900 }, { name: '啤酒', amount: 300 }],
    }, TRIP)
    expect(d).not.toBeNull()
    expect(d!.exp.a).toBe(1200)
    expect(d!.exp.p).toEqual({ 代杰: 1200 })
    expect(d!.photoIds).toEqual([`expenses/${TRIP}/a.jpg`])
    expect(d!.items.map(i => i.name)).toEqual(['拉麵', '啤酒'])
    expect(cleanDraft({ exp: {} }, TRIP)).toBeNull()
    expect(cleanDrafts('nope', TRIP)).toEqual([])
  })

  it('對話紀錄：只留 user／model，取最後幾輪', () => {
    const h = cleanHistory([
      { role: 'user', content: 'a' }, { role: 'system', content: 'x' }, { role: 'model', content: 'b' },
      { role: 'user', content: '' }, { role: 'user', content: 'c' },
    ], 2)
    expect(h).toEqual([{ role: 'model', content: 'b' }, { role: 'user', content: 'c' }])
  })

  it('回覆對象與名字', () => {
    expect(cleanReplyTarget({ kind: 'draft', nonce: 'n1' })).toEqual({ kind: 'draft', nonce: 'n1' })
    expect(cleanReplyTarget({ kind: 'expense', id: 'not-an-id!' })).toBeNull()
    expect(cleanReplyTarget({ kind: 'expense', id: '1234abcd-0000-0000-0000-000000000000', label: '拉麵' }))
      .toEqual({ kind: 'expense', id: '1234abcd-0000-0000-0000-000000000000', label: '拉麵' })
    expect(cleanMemberName('  ')).toBe('未知')
    expect(cleanMemberName('代杰')).toBe('代杰')
  })
})
