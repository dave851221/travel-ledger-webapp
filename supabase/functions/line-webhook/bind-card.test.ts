import { describe, expect, it } from 'vitest'
import { buildBindPickerFlex, tripDateLabel } from './bind-card.ts'

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

describe('tripDateLabel', () => {
  it('formats one day, ranges and cross-year ranges', () => {
    expect(tripDateLabel('2026-11-28', null)).toBe('2026/11/28（六）')
    expect(tripDateLabel('2026-11-28', '2026-11-28')).toBe('2026/11/28（六）')
    expect(tripDateLabel('2026-11-28', '2026-12-02')).toBe('2026/11/28–12/2')
    expect(tripDateLabel('2026-12-30', '2027-01-02')).toBe('2026/12/30–2027/1/2')
    expect(tripDateLabel(null, null)).toBe('')
  })
})

describe('buildBindPickerFlex', () => {
  const opts = { isGroup: true, currentTripId: ID2, total: 2, webUrl: 'https://example.test', postbackPrefix: 'tlb_bind=' }
  const msg = buildBindPickerFlex([
    { id: ID1, name: '閃閃發光', start_date: '2026-11-28', end_date: '2026-12-02', member_count: 4 },
    { id: ID2, name: '八卦山莊', member_count: 0 },
  ], opts)
  const json = JSON.stringify(msg)

  it('makes each row a postback with the trip id', () => {
    const rows = (msg as unknown as { contents: { body: { contents: { action: { data: string } }[] } } }).contents.body.contents
    expect(rows).toHaveLength(2)
    expect(rows[0].action).toMatchObject({ type: 'postback', data: `tlb_bind=${ID1}`, displayText: '綁定「閃閃發光」' })
    expect(rows[1].action.data).toBe(`tlb_bind=${ID2}`)
  })

  it('shows dates, member count and the current binding', () => {
    expect(json).toContain('2026/11/28–12/2 · 4 人')
    expect(json).toContain('✓ 目前綁定中')
    expect(msg.altText).toContain('這個群組')
  })

  it('never emits empty text (LINE rejects the whole message)', () => {
    expect(json).not.toMatch(/"text":""/)
  })

  it('mentions hidden trips when the list is cut', () => {
    const cut = JSON.stringify(buildBindPickerFlex([{ id: ID1, name: 'A' }], { ...opts, total: 15 }))
    expect(cut).toContain('還有 14 趟')
  })

  it('keeps postback data under 300 bytes', () => {
    const rows = (msg as unknown as { contents: { body: { contents: { action: { data: string } }[] } } }).contents.body.contents
    for (const r of rows) expect(new TextEncoder().encode(r.action.data).length).toBeLessThan(300)
  })
})
