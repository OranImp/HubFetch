import { describe, expect, it, vi } from 'vitest'
import { CookieRequiredError, HubApiError } from '../src/errors'
import { HubTransport } from '../src/core/transport'

const FAST = { maxConcurrent: 4, minRequestGapMs: 0 } as const

function transport(
  fetchImpl: typeof fetch,
  options: Partial<{
    endpoint: string
    cacheTtlMs: number
    maxRetries: number
    getAccessToken: () => string | undefined
    getSessionCookie: () => string | undefined
  }> = {}
): HubTransport {
  return new HubTransport({
    endpoint: options.endpoint ?? 'https://hub.example.test',
    userAgent: 'test-agent',
    fetchImpl,
    cacheTtlMs: options.cacheTtlMs ?? 30_000,
    maxRetries: options.maxRetries ?? 0,
    ...FAST,
    getAccessToken: options.getAccessToken ?? (() => undefined),
    getSessionCookie: options.getSessionCookie ?? (() => undefined)
  })
}

function requestHeaders(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  const entry = fetchImpl.mock.calls[call]
  if (!entry || !entry[1]) throw new Error(`missing request ${call}`)
  return entry[1].headers as Record<string, string>
}

describe('HubTransport extracted policy core', () => {
  it('does not attach a token to an outside host and keeps cookie auth separate', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    const hub = transport(fetchImpl, {
      getAccessToken: () => 'hf_token',
      getSessionCookie: () => 'session-cookie'
    })

    await hub.getJson('https://outside.example.test/data')
    expect(requestHeaders(fetchImpl).Authorization).toBeUndefined()

    await hub.sendJson('POST', 'https://hub.example.test/api/like', {}, { auth: 'cookie' })
    const sessionHeaders = requestHeaders(fetchImpl, 1)
    expect(sessionHeaders.Cookie).toBe('token=session-cookie')
    expect(sessionHeaders.Authorization).toBeUndefined()
  })

  it('requires cookie auth locally without falling back to the token', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const hub = transport(fetchImpl, {
      getAccessToken: () => 'hf_token'
    })

    await expect(
      hub.sendJson('POST', 'https://hub.example.test/api/like', {}, { auth: 'cookie' })
    ).rejects.toBeInstanceOf(CookieRequiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves malformed-endpoint behavior without attaching credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    const hub = transport(fetchImpl, {
      endpoint: 'not-a-url',
      getAccessToken: () => 'hf_token'
    })

    await hub.getJson('not-a-url/api/models')
    expect(hub.endpoint).toBe('not-a-url')
    expect(requestHeaders(fetchImpl).Authorization).toBeUndefined()

    await hub.requestWithCookie('not-a-url/api/whoami-v2', 'session-cookie', 1000)
    expect(requestHeaders(fetchImpl, 1).Cookie).toBeUndefined()
  })

  it('caps retries and never retries a mutation 503', async () => {
    const retryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('busy', { status: 429, headers: { 'Retry-After': '0' } }))
    const retryHub = transport(retryFetch, { maxRetries: 1 })
    await expect(retryHub.getJson('https://hub.example.test/api/models')).rejects.toMatchObject({
      status: 429
    })
    expect(retryFetch).toHaveBeenCalledTimes(2)

    const mutationFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('busy', { status: 503 }))
    const mutationHub = transport(mutationFetch, { maxRetries: 4 })
    await expect(
      mutationHub.sendJson('POST', 'https://hub.example.test/api/write', {})
    ).rejects.toMatchObject({
      status: 503
    })
    expect(mutationFetch).toHaveBeenCalledTimes(1)
  })

  it('caps an oversized response body and preserves the declared size', async () => {
    const hub = transport(vi.fn<typeof fetch>())
    const body = new Response('0123456789extra', {
      status: 200,
      headers: { 'Content-Length': '15' }
    })

    const result = await hub.readBodyCapped(body, 10)

    expect(new TextDecoder().decode(result.bytes)).toBe('0123456789')
    expect(result.capped).toBe(true)
    expect(hub.totalSizeFrom(body, result.bytes.byteLength)).toBe(15)
  })

  it('serves stale data only for transient refresh failures', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ value: 'old' })))
        .mockResolvedValueOnce(new Response('busy', { status: 503 }))
        .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      const hub = transport(fetchImpl, { cacheTtlMs: 100 })

      await hub.getJson('https://hub.example.test/api/models')
      vi.advanceTimersByTime(101)
      await expect(hub.getJson('https://hub.example.test/api/models')).resolves.toEqual({
        body: { value: 'old' },
        nextUrl: undefined
      })
      vi.advanceTimersByTime(101)
      await expect(hub.getJson('https://hub.example.test/api/models')).rejects.toBeInstanceOf(
        HubApiError
      )
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
