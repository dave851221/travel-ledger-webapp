import { describe, expect, it, vi } from 'vitest'
import { consumeAi, lineActor, quotaReply, userActor } from './quota'
import type { SupabaseClient } from './deps'

const fakeDb = (data: unknown, error: unknown = null) =>
  ({ rpc: vi.fn().mockResolvedValue({ data, error }) }) as unknown as SupabaseClient

describe('consumeAi', () => {
  it('passes the trip, actor and kind to the database', async () => {
    const db = fakeDb({ ok: true, remaining: 29, limit: 30 })
    expect(await consumeAi(db, 't1', userActor('u1'), 'receipt')).toEqual({ ok: true, remaining: 29, limit: 30 })
    expect(db.rpc).toHaveBeenCalledWith('consume_ai', { p_trip_id: 't1', p_actor: 'user:u1', p_kind: 'receipt' })
  })
  it('fails closed when the database errors', async () => {
    expect(await consumeAi(fakeDb(null, { message: 'boom' }), 't1', lineActor('U1'), 'text')).toEqual({ ok: false, reason: 'error' })
  })
})

describe('quotaReply', () => {
  it('says something for every reason', () => {
    for (const reason of ['trip_limit', 'ai_disabled', 'no_trip', 'error'] as const) {
      expect(quotaReply({ ok: false, reason, limit: 30 }).length).toBeGreaterThan(5)
    }
    expect(quotaReply({ ok: false, reason: 'trip_limit', limit: 30 })).toContain('30')
  })
})
