import { describe, expect, it } from 'vitest'
import {
  CookieRequiredError,
  HubCapabilityError,
  HubApiError,
  isForbidden,
  isNotFound,
  isTokenRejection,
  isUnauthorized,
  toHubCapabilityError
} from '../src'

describe('error classification', () => {
  it('isUnauthorized matches only a definitive 401', () => {
    expect(isUnauthorized(new HubApiError('x', 401))).toBe(true)
    // 403s come from WAF challenges, geo blocks, and gated repos — never a revoked token.
    expect(isUnauthorized(new HubApiError('x', 403))).toBe(false)
    expect(isUnauthorized(new HubApiError('x', 400))).toBe(false)
    expect(isUnauthorized(new HubApiError('x', 500))).toBe(false)
    expect(isUnauthorized(new HubApiError('x'))).toBe(false)
    expect(isUnauthorized(new CookieRequiredError())).toBe(false)
    expect(isUnauthorized(new Error('x'))).toBe(false)
  })

  it('isForbidden matches only 403', () => {
    expect(isForbidden(new HubApiError('x', 403))).toBe(true)
    expect(isForbidden(new HubApiError('x', 401))).toBe(false)
    expect(isForbidden(new HubApiError('x', 404))).toBe(false)
    expect(isForbidden(new HubApiError('x'))).toBe(false)
    expect(isForbidden(new Error('x'))).toBe(false)
  })

  it('isTokenRejection covers definitive token-endpoint rejections only', () => {
    for (const status of [400, 401, 403]) {
      expect(isTokenRejection(new HubApiError('x', status))).toBe(true)
    }
    // Transient failures must never destroy stored credentials.
    expect(isTokenRejection(new HubApiError('x', 429))).toBe(false)
    expect(isTokenRejection(new HubApiError('x', 500))).toBe(false)
    expect(isTokenRejection(new HubApiError('x'))).toBe(false)
    expect(isTokenRejection(new Error('x'))).toBe(false)
  })

  it('isNotFound matches only 404', () => {
    expect(isNotFound(new HubApiError('x', 404))).toBe(true)
    expect(isNotFound(new HubApiError('x', 403))).toBe(false)
    expect(isNotFound(new Error('x'))).toBe(false)
  })

  it('maps closed capability outcomes without carrying request data', () => {
    const session = toHubCapabilityError(
      'listWatched',
      'cookie-web',
      new CookieRequiredError('https://hub.test/api/settings/watch?token=secret')
    )
    expect(session).toBeInstanceOf(HubCapabilityError)
    expect(session.code).toBe('session-required')
    expect(session.message).toContain('HUB_WEB_SESSION_REQUIRED')
    expect(session.message).not.toContain('token=secret')

    expect(toHubCapabilityError('searchRepos', 'official-public', new HubApiError('x', 401)).code).toBe(
      'unauthorized'
    )
    expect(toHubCapabilityError('searchRepos', 'official-public', new HubApiError('x', 403)).code).toBe(
      'forbidden'
    )
    expect(toHubCapabilityError('searchRepos', 'official-public', new HubApiError('x', 429)).code).toBe(
      'rate-limited'
    )
    expect(
      toHubCapabilityError('getProfileSettings', 'ssr-scrape', new Error('schema drift')).code
    ).toBe('upstream-changed')
    expect(toHubCapabilityError('searchRepos', 'official-public', new Error('fetch failed')).code).toBe(
      'network'
    )
  })
})
