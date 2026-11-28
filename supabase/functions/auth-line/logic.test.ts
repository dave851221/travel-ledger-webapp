import { describe, expect, it } from 'vitest'
import { accessTokenIsOurs, lineLoginEmail, parseAuthLineRequest, verifyIdTokenLocally } from './logic.ts'

describe('parseAuthLineRequest', () => {
  it('accepts a LIFF access token', () => {
    expect(parseAuthLineRequest({ accessToken: 'abc' })).toEqual({
      action: 'signin', accessToken: 'abc', code: undefined, redirectUri: undefined, nonce: undefined,
    })
  })

  it('accepts a web OAuth code with its redirect URI and nonce', () => {
    expect(parseAuthLineRequest({ code: 'c', redirectUri: 'https://x.test/next/', nonce: 'n' })?.code).toBe('c')
  })

  it('rejects a code without redirect URI or nonce', () => {
    expect(parseAuthLineRequest({ code: 'c', nonce: 'n' })).toBeNull()
    expect(parseAuthLineRequest({ code: 'c', redirectUri: 'https://x.test/' })).toBeNull()
  })

  it('does not accept a client-supplied ID token', () => {
    expect(parseAuthLineRequest({ idToken: 'replayed' })).toBeNull()
  })

  it('rejects empty bodies, unknown actions, non-http redirects and oversized values', () => {
    expect(parseAuthLineRequest({})).toBeNull()
    expect(parseAuthLineRequest(null)).toBeNull()
    expect(parseAuthLineRequest({ action: 'delete', accessToken: 'a' })).toBeNull()
    expect(parseAuthLineRequest({ code: 'c', nonce: 'n', redirectUri: 'javascript:alert(1)' })).toBeNull()
    expect(parseAuthLineRequest({ accessToken: 'x'.repeat(5000) })).toBeNull()
  })

  it('keeps the link action', () => {
    expect(parseAuthLineRequest({ action: 'link', accessToken: 'a' })?.action).toBe('link')
  })
})

describe('accessTokenIsOurs', () => {
  it('requires our channel id and a token that has not expired', () => {
    expect(accessTokenIsOurs({ client_id: '123', expires_in: 100 }, '123')).toBe(true)
    expect(accessTokenIsOurs({ client_id: '999', expires_in: 100 }, '123')).toBe(false)
    expect(accessTokenIsOurs({ client_id: '123', expires_in: 0 }, '123')).toBe(false)
    expect(accessTokenIsOurs(null, '123')).toBe(false)
  })
})

describe('lineLoginEmail', () => {
  it('builds a stable, non-deliverable address from the LINE user id', () => {
    expect(lineLoginEmail('U1234abcdEF')).toBe('line-u1234abcdef@line.users.invalid')
  })
})

describe('verifyIdTokenLocally', () => {
  const secret = 'test-secret'
  const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url')
  async function sign(payload: Record<string, unknown>, alg = 'HS256', key = secret): Promise<string> {
    const head = b64u(JSON.stringify({ alg, typ: 'JWT' }))
    const body = b64u(JSON.stringify(payload))
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${head}.${body}`)))
    return `${head}.${body}.${b64u(sig)}`
  }
  const now = 1_800_000_000
  const good = { iss: 'https://access.line.me', aud: '123', sub: 'Uabc', exp: now + 600, nonce: 'n1', name: 'Dai' }

  it('accepts a correctly signed token for our channel and nonce', async () => {
    expect(await verifyIdTokenLocally(await sign(good), '123', secret, 'n1', now)).toEqual({ status: 'ok', sub: 'Uabc', name: 'Dai' })
  })

  it('falls back (other) on wrong signature, channel, nonce, issuer, expiry or algorithm', async () => {
    const cases = [
      await sign(good, 'HS256', 'other-secret'),
      await sign({ ...good, aud: '999' }),
      await sign({ ...good, nonce: 'n2' }),
      await sign({ ...good, iss: 'https://evil.test' }),
      await sign({ ...good, exp: now - 1 }),
      await sign(good, 'ES256'),
      'not-a-token',
    ]
    for (const token of cases) expect((await verifyIdTokenLocally(token, '123', secret, 'n1', now)).status).toBe('other')
  })
})