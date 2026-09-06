import type {
  FollowedAccount,
  HubProfileSettings,
  HubProfileUpdate,
  OrgSearchResult,
  UserOverview,
  UserSearchResult
} from '@hubfetch/shared'
import { hubRelativeUrl } from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { HubApiError, HubCapabilityError, isNotFound } from '../errors'
import { mapUserOverview } from '../mappers'
import { parseProfileSettingsPage } from './profiles-mappers'

export async function getUserOverview(
  transport: HubTransport,
  username: string
): Promise<UserOverview> {
  const encoded = encodeURIComponent(username)
  try {
    const { body } = await transport.getJson<unknown>(
      `${transport.endpoint}/api/users/${encoded}/overview`
    )
    return mapUserOverview(body as never, transport.endpoint)
  } catch (error) {
    if (!isNotFound(error)) throw error
    const { body } = await transport.getJson<unknown>(
      `${transport.endpoint}/api/organizations/${encoded}/overview`
    )
    return mapUserOverview(body as never, transport.endpoint, true)
  }
}

export async function getOrgMembers(
  transport: HubTransport,
  org: string,
  limit = 40
): Promise<FollowedAccount[]> {
  const { body } = await transport.getJson<
    Array<{ user?: string; fullname?: string; avatarUrl?: string; type?: string }>
  >(`${transport.endpoint}/api/organizations/${encodeURIComponent(org)}/members`, { ttl: 5 * 60_000 })
  return body
    .filter((member) => member.user)
    .slice(0, limit)
    .map((member) => ({
      name: member.user ?? '',
      fullname: member.fullname,
      avatarUrl: member.avatarUrl ? hubRelativeUrl(member.avatarUrl, transport.endpoint) : undefined,
      isOrg: member.type === 'org'
    }))
}

export async function getUserFollowing(
  transport: HubTransport,
  username: string
): Promise<FollowedAccount[]> {
  let url: string | undefined =
    `${transport.endpoint}/api/users/${encodeURIComponent(username)}/following`
  const all: FollowedAccount[] = []
  let pages = 0
  while (url && pages < 4) {
    const page: {
      body: Array<{ user?: string; fullname?: string; avatarUrl?: string; type?: string }>
      nextUrl?: string
    } = await transport.getJson(url, { ttl: 5 * 60_000 })
    for (const member of page.body) {
      if (!member.user) continue
      all.push({
        name: member.user,
        fullname: member.fullname,
        avatarUrl: member.avatarUrl ? hubRelativeUrl(member.avatarUrl, transport.endpoint) : undefined,
        isOrg: member.type === 'org'
      })
    }
    url = page.nextUrl
    pages++
  }
  return all
}

export async function searchUsers(
  transport: HubTransport,
  query: string
): Promise<UserSearchResult[]> {
  const url = new URL(`${transport.endpoint}/api/quicksearch`)
  url.searchParams.set('q', query)
  url.searchParams.set('type', 'user')
  try {
    const { body } = await transport.getJson<{
      users?: Array<{ user?: string; fullname?: string; avatarUrl?: string }>
    }>(url.toString(), { ttl: 60_000 })
    return (body.users ?? [])
      .filter((user) => user.user)
      .slice(0, 8)
      .map((user) => ({
        name: user.user ?? '',
        fullname: user.fullname,
        avatarUrl: user.avatarUrl ? hubRelativeUrl(user.avatarUrl, transport.endpoint) : undefined
      }))
  } catch {
    return []
  }
}

export async function searchOrgs(
  transport: HubTransport,
  query: string
): Promise<OrgSearchResult[]> {
  const url = new URL(`${transport.endpoint}/api/quicksearch`)
  url.searchParams.set('q', query)
  url.searchParams.set('type', 'org')
  try {
    const { body } = await transport.getJson<{
      orgs?: Array<{ name?: string; fullname?: string; avatarUrl?: string }>
    }>(url.toString(), { ttl: 60_000 })
    return (body.orgs ?? [])
      .filter((org) => org.name)
      .slice(0, 8)
      .map((org) => ({
        name: org.name ?? '',
        fullname: org.fullname,
        avatarUrl: org.avatarUrl ? hubRelativeUrl(org.avatarUrl, transport.endpoint) : undefined
      }))
  } catch {
    return []
  }
}

async function fetchProfileSettingsPage(
  transport: HubTransport,
  capability: 'getProfileSettings' | 'updateProfileSettings'
): Promise<{
  csrf: string
  settings: HubProfileSettings
  responseCookies: string[]
}> {
  const url = `${transport.endpoint}/settings/profile`
  transport.requireCookie(url)
  const response = await transport.request(url, {}, { auth: 'cookie', referer: url })
  await transport.ensureOk(response, 'GET', url)
  const responseCookies = transport.cookiePairsFromResponse(response)
  const html = await response.text()
  if (/<input[^>]*\bname=["']username["']/i.test(html)) {
    throw new HubApiError('Hub web session was rejected (401)', 401, url)
  }
  const page = parseProfileSettingsPage(html)
  if (!page) throw new HubCapabilityError(capability, 'upstream-changed', 'The Hub profile page changed.')
  return { ...page, responseCookies }
}

export async function getProfileSettings(transport: HubTransport): Promise<HubProfileSettings> {
  return (await fetchProfileSettingsPage(transport, 'getProfileSettings')).settings
}

export async function updateProfileSettings(
  transport: HubTransport,
  update: HubProfileUpdate
): Promise<void> {
  const { csrf, responseCookies } = await fetchProfileSettingsPage(transport, 'updateProfileSettings')
  const url = `${transport.endpoint}/settings/profile`
  const session = transport.sessionCookie() ?? ''
  const hasCsrfCookie =
    /\bcsrf[^=]*=/i.test(session) ||
    responseCookies.some((pair) => /^csrf/i.test(pair.split('=', 1)[0] ?? ''))
  const extras = !hasCsrfCookie && csrf !== '' ? [...responseCookies, `csrf=${csrf}`] : responseCookies
  const body = new URLSearchParams({
    csrf,
    fullname: update.fullname,
    avatar: update.avatar ?? '',
    primaryOrg: update.primaryOrg,
    homepage: update.homepage,
    details: update.details,
    github: update.github,
    twitter: update.twitter,
    linkedin: update.linkedin,
    bluesky: update.bluesky
  })
  const response = await transport.request(
    url,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    },
    { auth: 'cookie', referer: url, extraCookies: extras }
  )
  if (response.status >= 200 && response.status < 300) {
    transport.invalidateCache()
    return
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location') ?? ''
    if (/\/login(?:\?|$)/i.test(location)) {
      throw new HubApiError('Hub web session was rejected (401)', 401, url)
    }
    transport.invalidateCache()
    return
  }
  await transport.ensureOk(response, 'POST', url)
}
