import { afterEach, describe, expect, it, vi } from 'vitest'
import accountWhoami from './fixtures/account-whoami.json'
import datasetsServer from './fixtures/datasets-server.json'
import modelsList from './fixtures/models-list.json'
import { CookieRequiredError, HubClient } from '../src'
import {
  startHttpFixture,
  type FixtureRequest,
  type FixtureResponse,
  type HttpFixture
} from './http-fixture'

const ACCESS_TOKEN = 'fixture-access-token'
const SESSION_COOKIE = 'fixture-session-cookie'
const FAST = { cacheTtlMs: 0, maxRetries: 0, minRequestGapMs: 0 } as const

const profilePage =
  '<form method="post"><input type="hidden" name="csrf" value="fixture-form-csrf">' +
  '<input name="fullname" value="Fixture User"><input name="homepage" value="">' +
  '<textarea name="details"></textarea><input name="github" value="">' +
  '<input name="twitter" value=""><input name="linkedin" value="">' +
  '<input name="bluesky" value=""><select name="primaryOrg"></select></form>'

const openFixtures: HttpFixture[] = []

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((fixture) => fixture.close()))
})

function jsonResponse(body: unknown, headers: Record<string, string> = {}): FixtureResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  )
}

async function fixture(handler: Parameters<typeof startHttpFixture>[0]): Promise<HttpFixture> {
  const server = await startHttpFixture(handler)
  openFixtures.push(server)
  return server
}

describe('HubClient wire capability baseline', () => {
  it('uses a configured endpoint and sends token auth only to its configured host', async () => {
    const server = await fixture(() => jsonResponse(modelsList.response.body))
    const client = new HubClient({
      endpoint: `${server.url}/hf`,
      getAccessToken: () => ACCESS_TOKEN,
      ...FAST
    })

    const page = await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })

    expect(page.items[0]?.id).toBe('fixture-owner/fixture-model')
    expect(new URL(server.requests[0]?.url ?? '/', server.url).pathname).toBe('/hf/api/models')
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('validates a token identity against a loopback account fixture', async () => {
    const server = await fixture(() => jsonResponse(accountWhoami.response.body))
    const client = new HubClient({ endpoint: server.url, ...FAST })

    const identity = await client.whoAmIWithToken(ACCESS_TOKEN)

    expect(identity.user.name).toBe('fixture-user')
    expect(server.requests[0]?.url).toBe('/api/whoami-v2')
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('maps a datasets-server split response through a loopback fixture', async () => {
    const server = await fixture(() => jsonResponse(datasetsServer.response.body))
    const fetchImpl: typeof fetch = (input, init) => {
      const original = requestUrl(input)
      return fetch(`${server.url}${original.pathname}${original.search}`, init)
    }
    const client = new HubClient({
      fetchImpl,
      getAccessToken: () => ACCESS_TOKEN,
      ...FAST
    })

    await expect(client.getDatasetSplits('fixture-owner/fixture-dataset')).resolves.toEqual([
      { config: 'default', split: 'train' }
    ])
    expect(server.requests[0]?.url).toBe('/splits?dataset=fixture-owner%2Ffixture-dataset')
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('strips token auth from a cursor URL outside the configured host allowlist', async () => {
    const server = await fixture((request: FixtureRequest): FixtureResponse => {
      if (request.url.includes('cursor=outside')) return jsonResponse([])
      return {
        ...jsonResponse(modelsList.response.body),
        headers: {
          'content-type': 'application/json',
          link: '<https://outside.example.invalid/api/models?cursor=outside>; rel="next"'
        }
      }
    })
    const requests: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input).toString()
      const headers = (init?.headers ?? {}) as Record<string, string>
      requests.push({ url, headers })
      return url.includes('outside.example.invalid')
        ? new Response(JSON.stringify([]), { status: 200 })
        : fetch(input, init)
    }
    const client = new HubClient({
      endpoint: server.url,
      fetchImpl,
      getAccessToken: () => ACCESS_TOKEN,
      ...FAST
    })

    const first = await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })
    await client.searchRepos({ kind: 'model', sort: 'trending', cursor: first.nextCursor })

    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(requests[1]?.headers.Authorization).toBeUndefined()
  })

  it('uses cookie auth without a bearer header for web mutations', async () => {
    const server = await fixture(() => jsonResponse({ accepted: true }))
    const client = new HubClient({
      endpoint: server.url,
      getAccessToken: () => ACCESS_TOKEN,
      getSessionCookie: () => SESSION_COOKIE,
      ...FAST
    })

    await client.setLike('model', 'fixture-owner/fixture-model', true)

    const request = server.requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.headers.cookie).toBe(`token=${SESSION_COOKIE}`)
    expect(request?.headers.authorization).toBeUndefined()
    expect(request?.headers.origin).toBe(server.url)
    expect(request?.headers.referer).toBe(`${server.url}/`)
  })

  it('fails cookie methods locally with the session-required sentinel', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ endpoint: 'http://127.0.0.1:9', fetchImpl, ...FAST })

    await expect(
      client.setPostReaction('fixture-user', 'fixture-post', 'like', true)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CookieRequiredError && error.message.includes('HUB_WEB_SESSION_REQUIRED')
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forwards a CSRF companion cookie from the profile GET to its form POST', async () => {
    const server = await fixture((request: FixtureRequest): FixtureResponse => {
      if (request.method === 'GET') {
        return {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'set-cookie': 'csrf=fixture-csrf-cookie; Path=/'
          },
          body: profilePage
        }
      }
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: '' }
    })
    const client = new HubClient({
      endpoint: server.url,
      getSessionCookie: () => SESSION_COOKIE,
      ...FAST
    })

    await client.updateProfileSettings({
      fullname: 'Updated Fixture',
      homepage: '',
      details: '',
      github: '',
      twitter: '',
      linkedin: '',
      bluesky: '',
      primaryOrg: ''
    })

    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]?.headers.cookie).toBe(
      `token=${SESSION_COOKIE}; csrf=fixture-csrf-cookie`
    )
    expect(server.requests[1]?.headers['content-type']).toBe('application/x-www-form-urlencoded')
  })

  it('follows a representative Link pagination cursor without changing its wire shape', async () => {
    const server = await fixture((request) => {
      if (request.url.includes('cursor=fixture-page-2')) return jsonResponse([])
      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: `<${server.url}${modelsList.nextPath}>; rel="next"`
        },
        body: JSON.stringify(modelsList.response.body)
      }
    })
    const client = new HubClient({ endpoint: server.url, ...FAST })

    const first = await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })
    const second = await client.searchRepos({
      kind: 'model',
      sort: 'trending',
      cursor: first.nextCursor
    })

    expect(first.items[0]?.id).toBe('fixture-owner/fixture-model')
    expect(second.items).toEqual([])
    const secondUrl = new URL(server.requests[1]?.url ?? '/', server.url)
    expect(secondUrl.pathname).toBe('/api/models')
    expect(secondUrl.searchParams.get('cursor')).toBe('fixture-page-2')
  })
})
