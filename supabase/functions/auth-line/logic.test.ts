import { describe, expect, it } from 'vitest'
import { accessTokenIsOurs, lineLoginEmail, parseAuthLineRequest } from './logic.ts'

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
