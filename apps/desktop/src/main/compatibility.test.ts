import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { HubApiError, HubCapabilityError, HubClient } from '@hubfetch/hub-api'
import type { AuthState } from '@hubfetch/shared'
import { CompatibilityService, type CompatibilityServiceOptions } from './compatibility'

const NOW = '2026-09-05T00:00:00.000Z'

function signedIn(hubSession = true): AuthState {
  return {
    status: 'signedIn',
    accountId: '11111111-1111-4111-8111-111111111111',
    user: { name: 'fixture-user', orgs: [] },
    hubSession
  }
}

function clientFixture(): {
  readonly client: ReturnType<CompatibilityServiceOptions['getClient']>
  readonly getClient: CompatibilityServiceOptions['getClient']
} {
  const client = {
    searchRepos: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    getPosts: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    getPostComments: vi.fn().mockResolvedValue([]),
    listWatched: vi.fn().mockResolvedValue([]),
    getProfileSettings: vi.fn().mockResolvedValue({}),
    getDatasetSplits: vi.fn().mockResolvedValue([]),
    getDatasetRows: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    getDatasetSampleRows: vi.fn().mockResolvedValue(undefined),
    whoAmI: vi.fn().mockResolvedValue({})
  }
  return { client, getClient: () => client }
}

function service(
  getClient: CompatibilityServiceOptions['getClient'],
  auth: AuthState = signedIn()
): CompatibilityService {
  return new CompatibilityService({ getClient, getAuthState: () => auth, now: () => NOW })
}

async function loopback(
  status: number,
  body: string,
  run: (endpoint: string) => Promise<void>
): Promise<void> {
  const server = createServer((_request, response) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server did not bind')
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    await run(endpoint)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

describe('CompatibilityService', () => {
  it('reads static knowledge without invoking the Hub client', () => {
    const fixture = clientFixture()
    const getClient = vi.fn(fixture.getClient)
    const statuses = service(getClient).read()
    expect(getClient).not.toHaveBeenCalled()
    expect(statuses.find((entry) => entry.key === 'searchRepos')).toMatchObject({
      status: 'available',
      sourceClass: 'official-public',
      domain: 'models',
      lastCheckedAt: NOW
    })
    expect(JSON.stringify(statuses)).not.toContain('secret')
    expect(JSON.stringify(statuses)).not.toContain('Bearer')
  })

  it('keeps browsing available when cookie-backed watch compatibility changes', async () => {
    const fixture = clientFixture()
    const client = fixture.client
    const searchRepos = vi.fn().mockResolvedValue({ items: [], nextCursor: undefined })
    const listWatched = vi
      .fn()
      .mockRejectedValue(new HubCapabilityError('listWatched', 'upstream-changed', 'drift'))
    client.searchRepos = searchRepos
    client.listWatched = listWatched
    const compat = service(fixture.getClient)

    const browse = await compat.probe('searchRepos')
    const watch = await compat.probe('listWatched')

    expect(browse.status).toBe('available')
    expect(watch.status).toBe('upstream-changed')
    expect(searchRepos).toHaveBeenCalledOnce()
    expect(listWatched).toHaveBeenCalledOnce()
  })

  it('reports session-required locally without probing without a web session', async () => {
    const fixture = clientFixture()
    const getClient = vi.fn(fixture.getClient)
    const status = await service(getClient, signedIn(false)).probe('listWatched')
    expect(status.status).toBe('session-required')
    expect(getClient).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate-limited']
  ] as const)('maps HTTP %s to %s independently', async (httpStatus, expected) => {
    const fixture = clientFixture()
    fixture.client.searchRepos = vi.fn().mockRejectedValue(new HubApiError('raw response', httpStatus))
    const status = await service(fixture.getClient).probe('searchRepos')
    expect(status.status).toBe(expected)
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate-limited']
  ] as const)('maps loopback HTTP %s to %s', async (httpStatus, expected) => {
    await loopback(httpStatus, '{}', async (endpoint) => {
      const client = new HubClient({
        endpoint,
        fetchImpl: fetch,
        cacheTtlMs: 0,
        maxRetries: 0,
        minRequestGapMs: 0,
        getAccessToken: () => 'fixture-token'
      })
      const status = await service(() => client).probe('searchRepos')
      expect(status.status).toBe(expected)
    })
  })

  it('maps network failures without exposing their message', async () => {
    const fixture = clientFixture()
    fixture.client.searchRepos = vi.fn().mockRejectedValue(new Error('fetch failed token=secret'))
    const status = await service(fixture.getClient).probe('searchRepos')
    expect(status.status).toBe('network')
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it('maps SSR schema drift to upstream-changed', async () => {
    const fixture = clientFixture()
    fixture.client.getProfileSettings = vi.fn().mockRejectedValue(new Error('missing form island'))
    const status = await service(fixture.getClient).probe('getProfileSettings')
    expect(status.status).toBe('upstream-changed')
  })

  it('maps loopback SSR schema drift to upstream-changed', async () => {
    await loopback(200, '<!doctype html><html><body>changed</body></html>', async (endpoint) => {
      const client = new HubClient({
        endpoint,
        fetchImpl: fetch,
        cacheTtlMs: 0,
        maxRetries: 0,
        minRequestGapMs: 0,
        getSessionCookie: () => 'token=fixture-session'
      })
      const status = await service(() => client).probe('getProfileSettings')
      expect(status.status).toBe('upstream-changed')
    })
  })
})
