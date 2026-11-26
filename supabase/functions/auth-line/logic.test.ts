import { describe, expect, it } from 'vitest'
import { lineLoginEmail, parseAuthLineRequest } from './logic.ts'

describe('parseAuthLineRequest', () => {
  it('accepts an ID token from LIFF', () => {
    expect(parseAuthLineRequest({ idToken: 'abc' })).toEqual({ action: 'signin', idToken: 'abc', code: undefined, redirectUri: undefined, nonce: undefined })
  })

  it('accepts a web OAuth code with its redirect URI', () => {
    expect(parseAuthLineRequest({ code: 'c', redirectUri: 'https://x.test/next/', nonce: 'n' })?.code).toBe('c')
  })

  it('rejects a code without redirect URI, empty bodies and unknown actions', () => {
    expect(parseAuthLineRequest({ code: 'c' })).toBeNull()
    expect(parseAuthLineRequest({})).toBeNull()
    expect(parseAuthLineRequest(null)).toBeNull()
    expect(parseAuthLineRequest({ action: 'delete', idToken: 'a' })).toBeNull()
  })

  it('rejects non-http redirect URIs and oversized values', () => {
    expect(parseAuthLineRequest({ code: 'c', redirectUri: 'javascript:alert(1)' })).toBeNull()
    expect(parseAuthLineRequest({ idToken: 'x'.repeat(5000) })).toBeNull()
  })

  it('keeps the link action', () => {
    expect(parseAuthLineRequest({ action: 'link', idToken: 'a' })?.action).toBe('link')
  })
})

describe('lineLoginEmail', () => {
  it('builds a stable, non-deliverable address from the LINE user id', () => {
    expect(lineLoginEmail('U1234abcdEF')).toBe('line-u1234abcdef@line.users.invalid')
  })
})
