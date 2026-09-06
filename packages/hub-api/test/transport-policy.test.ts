import { afterEach, describe, expect, it } from 'vitest'
import modelsList from './fixtures/models-list.json'
import { HubApiError, HubClient } from '../src'
import { startHttpFixture, type FixtureResponse, type HttpFixture } from './http-fixture'

const ACCESS_TOKEN = 'fixture-access-token'
const FAST = { cacheTtlMs: 0, maxRetries: 0, minRequestGapMs: 0 } as const
const openFixtures: HttpFixture[] = []

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((fixture) => fixture.close()))
})

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): FixtureResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }
}

async function fixture(handler: Parameters<typeof startHttpFixture>[0]): Promise<HttpFixture> {
  const server = await startHttpFixture(handler)
  openFixtures.push(server)
  return server
}

describe('HubClient cache and retry baseline', () => {
  it('caches an ETagged GET response within its TTL', async () => {
    const server = await fixture(() =>
      jsonResponse(modelsList.response.body, 200, { etag: modelsList.response.headers.etag })
    )
    const client = new HubClient({ endpoint: server.url, ...FAST, cacheTtlMs: 60_000 })

    await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })
    await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })

    expect(server.requests).toHaveLength(1)
  })

  it('serves only an expired GET cache entry after a transient failure', async () => {
    const server = await fixture((request) =>
      request.method === 'GET' && server.requests.length > 1
        ? jsonResponse({ error: 'temporarily unavailable' }, 503)
        : jsonResponse(modelsList.response.body)
    )
    const client = new HubClient({ endpoint: server.url, ...FAST, cacheTtlMs: 5 })

    const first = await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const stale = await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })

    expect(first.items[0]?.id).toBe('fixture-owner/fixture-model')
    expect(stale.items[0]?.id).toBe('fixture-owner/fixture-model')
    expect(server.requests).toHaveLength(2)
  })

  it('does not manufacture stale data when there is no expired GET cache', async () => {
    const server = await fixture(() => jsonResponse({ error: 'temporarily unavailable' }, 503))
    const client = new HubClient({ endpoint: server.url, ...FAST })

    await expect(client.searchRepos({ kind: 'model', sort: 'trending' })).rejects.toMatchObject({
      name: 'HubApiError',
      status: 503
    })
  })

  it('retries a 429 once when Retry-After permits an immediate retry', async () => {
    const server = await fixture((request) =>
      server.requests.length === 1
        ? jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '0' })
        : jsonResponse([])
    )
    const client = new HubClient({ endpoint: server.url, ...FAST, maxRetries: 1 })

    await expect(client.searchRepos({ kind: 'model', sort: 'trending' })).resolves.toMatchObject({
      items: []
    })
    expect(server.requests).toHaveLength(2)
  })
})

describe('HubClient limiter baseline', () => {
  it('caps simultaneous loopback requests at maxConcurrent', async () => {
    let active = 0
    let maximum = 0
    const releases: Array<() => void> = []
    const server = await fixture(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return jsonResponse([])
    })
    const client = new HubClient({ endpoint: server.url, maxConcurrent: 2, ...FAST })
    const first = client.searchRepos({ kind: 'model', sort: 'trending' })
    const second = client.searchRepos({ kind: 'dataset', sort: 'trending' })
    const third = client.searchRepos({ kind: 'space', sort: 'trending' })

    await server.waitForRequests(2)
    expect(server.requests).toHaveLength(2)
    expect(maximum).toBe(2)
    for (const release of releases.splice(0)) release()
    await server.waitForRequests(3)
    for (const release of releases.splice(0)) release()
    await Promise.all([first, second, third])
  })

  it('spaces loopback request starts by minRequestGapMs', async () => {
    const starts: number[] = []
    const server = await fixture(() => {
      starts.push(Date.now())
      return jsonResponse([])
    })
    const client = new HubClient({ endpoint: server.url, ...FAST, minRequestGapMs: 25 })

    await Promise.all([
      client.searchRepos({ kind: 'model', sort: 'trending' }),
      client.searchRepos({ kind: 'dataset', sort: 'trending' })
    ])

    expect(starts).toHaveLength(2)
    expect(Math.abs((starts[1] ?? 0) - (starts[0] ?? 0))).toBeGreaterThanOrEqual(20)
  })
})

describe('HubClient mutation and body-cap baseline', () => {
  it('does not cache a successful mutation', async () => {
    const server = await fixture(() => jsonResponse({ accepted: true }))
    const client = new HubClient({ endpoint: server.url, ...FAST })

    await client.commentOnDiscussion('model', 'fixture-owner/fixture-model', 1, 'first')
    await client.commentOnDiscussion('model', 'fixture-owner/fixture-model', 1, 'second')

    expect(server.requests).toHaveLength(2)
  })

  it('does not retry a 503 mutation', async () => {
    const server = await fixture(() => jsonResponse({ error: 'unavailable' }, 503))
    const client = new HubClient({ endpoint: server.url, ...FAST, maxRetries: 2 })

    await expect(
      client.commentOnDiscussion('model', 'fixture-owner/fixture-model', 1, 'x')
    ).rejects.toMatchObject({
      status: 503
    })
    expect(server.requests).toHaveLength(1)
  })

  it('reads only the configured response-size cap when Range is ignored', async () => {
    const body = '0123456789EXTRA'
    const server = await fixture(() => ({
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
      body
    }))
    const client = new HubClient({ endpoint: server.url, ...FAST })

    const result = await client.getFileText(
      'model',
      'fixture-owner/fixture-model',
      'README.md',
      'main',
      10
    )

    expect(result).toEqual({ content: '0123456789', truncated: true, size: body.length })
  })
})

describe('HubClient redirect and error baseline', () => {
  it('does not forward Authorization or Cookie across a non-Hub redirect', async () => {
    const target = await fixture(() => jsonResponse([]))
    const source = await fixture(() => ({
      status: 302,
      headers: { location: `${target.url}/api/models` },
      body: ''
    }))
    const client = new HubClient({
      endpoint: source.url,
      getAccessToken: () => ACCESS_TOKEN,
      getSessionCookie: () => 'fixture-session-cookie',
      minRequestGapMs: 0
    })

    await expect(client.searchRepos({ kind: 'model', sort: 'trending' })).resolves.toEqual({
      items: [],
      nextCursor: undefined
    })
    expect(source.requests[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(target.requests[0]?.headers.authorization).toBeUndefined()
    expect(target.requests[0]?.headers.cookie).toBeUndefined()
  })

  it('strips Cookie across a non-Hub redirect from a cookie-authenticated request', async () => {
    const target = await fixture(() => jsonResponse({ accepted: true }))
    const source = await fixture(() => ({
      status: 302,
      headers: { location: `${target.url}/api/models/fixture-owner/fixture-model/like` },
      body: ''
    }))
    const client = new HubClient({
      endpoint: source.url,
      getSessionCookie: () => 'fixture-session-cookie',
      minRequestGapMs: 0
    })

    await client.setLike('model', 'fixture-owner/fixture-model', true)

    expect(source.requests[0]?.headers.cookie).toBe('token=fixture-session-cookie')
    expect(target.requests[0]?.headers.cookie).toBeUndefined()
    expect(target.requests[0]?.headers.authorization).toBeUndefined()
  })

  it('keeps error messages free of transport credentials', async () => {
    const server = await fixture(() => jsonResponse({ error: 'access denied' }, 401))
    const client = new HubClient({
      endpoint: server.url,
      getAccessToken: () => ACCESS_TOKEN,
      ...FAST
    })

    const error = await client
      .getRepoDetail('model', 'fixture-owner/fixture-model')
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(HubApiError)
    expect((error as HubApiError).message).not.toContain(ACCESS_TOKEN)
    expect((error as HubApiError).message).not.toContain('fixture-session-cookie')
  })
})
