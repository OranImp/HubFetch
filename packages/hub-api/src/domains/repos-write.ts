import type { AccessRequest, MyRepoEntry, RepoAccessGate, RepoKind } from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { API_PATH, RESOLVE_PREFIX } from '../constants'
import { HubApiError } from '../errors'
import { mapAccessRequest, mapMyRepos } from '../mappers'
import { fetchRepoPage } from './repo-page'
import { parseAskAccessForm } from './repos-write-mappers'

const LINK_DRAIN_MAX_PAGES = 50
type GatedRepoKind = Extract<RepoKind, 'model' | 'dataset'>

export async function getRepoAccessGate(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string
): Promise<RepoAccessGate> {
  const checkUrl = `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/auth-check`
  const response = await transport.request(checkUrl)
  if (response.ok) return { status: 'granted', fields: [] }
  if (response.status !== 401 && response.status !== 403) {
    await transport.ensureOk(response, 'GET', checkUrl)
  }
  const form = parseAskAccessForm(await fetchRepoPage(transport, kind, repoId))
  return form ? { status: 'ask', fields: form.fields } : { status: 'pending', fields: [] }
}

export async function askRepoAccess(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  fields: Record<string, string>
): Promise<void> {
  const url = `${transport.endpoint}/${RESOLVE_PREFIX[kind]}${repoId}/ask-access`
  transport.requireCookie(url)
  const form = parseAskAccessForm(await fetchRepoPage(transport, kind, repoId))
  if (!form) throw new HubApiError('the repo offers no access-request form', 409, url)
  const response = await transport.request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: form.csrf, ...fields }).toString()
    },
    { auth: 'cookie' }
  )
  await transport.ensureOk(response, 'POST', url)
}

export async function listMyRepos(transport: HubTransport): Promise<MyRepoEntry[]> {
  const { body } = await transport.getJson<unknown[]>(`${transport.endpoint}/api/settings/repositories`, {
    ttl: 10_000
  })
  return mapMyRepos(body as never[])
}

export async function updateRepoSettings(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  patch: { private?: boolean; gated?: false | 'auto' | 'manual'; discussionsDisabled?: boolean }
): Promise<void> {
  await transport.sendJson('PUT', `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/settings`, patch)
}

export async function moveRepo(
  transport: HubTransport,
  kind: RepoKind,
  fromRepo: string,
  toRepo: string
): Promise<void> {
  await transport.sendJson('POST', `${transport.endpoint}/api/repos/move`, { fromRepo, toRepo, type: kind })
}

export async function deleteRepo(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string
): Promise<void> {
  const slash = repoId.indexOf('/')
  const body: Record<string, unknown> = {
    type: kind,
    name: slash === -1 ? repoId : repoId.slice(slash + 1)
  }
  if (slash !== -1) body.organization = repoId.slice(0, slash)
  await transport.sendJson('DELETE', `${transport.endpoint}/api/repos/delete`, body)
}

export async function duplicateSpace(
  transport: HubTransport,
  repoId: string,
  toRepo: string,
  options: { private?: boolean } = {}
): Promise<{ url?: string }> {
  const response = await transport.sendJson('POST', `${transport.endpoint}/api/spaces/${repoId}/duplicate`, {
    repository: toRepo,
    private: options.private
  })
  const body = (await response.json()) as { url?: string }
  return { url: body.url }
}

export async function createBranch(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  branch: string,
  startingPoint?: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/branch/${encodeURIComponent(branch)}`,
    startingPoint === undefined ? {} : { startingPoint }
  )
}

export async function deleteBranch(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  branch: string
): Promise<void> {
  await transport.sendJson(
    'DELETE',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/branch/${encodeURIComponent(branch)}`
  )
}

export async function createTag(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  tag: string,
  revision = 'main',
  message?: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/tag/${encodeURIComponent(revision)}`,
    { tag, message }
  )
}

export async function deleteTag(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  tag: string
): Promise<void> {
  await transport.sendJson(
    'DELETE',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/tag/${encodeURIComponent(tag)}`
  )
}

export async function listAccessRequests(
  transport: HubTransport,
  kind: GatedRepoKind,
  repoId: string,
  status: 'pending' | 'accepted' | 'rejected'
): Promise<AccessRequest[]> {
  let url: string | undefined =
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/user-access-request/${status}`
  const all: AccessRequest[] = []
  let pages = 0
  while (url && pages < LINK_DRAIN_MAX_PAGES) {
    const page: { body: unknown[]; nextUrl?: string } = await transport.getJson(url, { ttl: 5_000 })
    all.push(...page.body.map((raw) => mapAccessRequest(raw as never, transport.endpoint)))
    url = page.nextUrl
    pages++
  }
  return all
}

export async function handleAccessRequest(
  transport: HubTransport,
  kind: GatedRepoKind,
  repoId: string,
  user: string,
  status: 'accepted' | 'rejected' | 'pending',
  rejectionReason?: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/user-access-request/handle`,
    { user, status, rejectionReason }
  )
}

export async function grantAccess(
  transport: HubTransport,
  kind: GatedRepoKind,
  repoId: string,
  user: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/user-access-request/grant`,
    { user }
  )
}
