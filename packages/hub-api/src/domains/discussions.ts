import type {
  DiscussionDetail,
  DiscussionStatusFilter,
  DiscussionSummary,
  DiscussionType,
  Page,
  RepoKind
} from '@hubfetch/shared'
import { hubRelativeUrl } from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { API_PATH } from '../constants'
import { mapDiscussionDetail, mapDiscussionSummary } from '../mappers'

const DIFF_MAX_CHARS = 2 * 1024 * 1024

export async function listDiscussions(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  opts: { type?: DiscussionType; status?: DiscussionStatusFilter; cursor?: string } = {}
): Promise<Page<DiscussionSummary>> {
  let url = opts.cursor
  if (!url) {
    const first = new URL(`${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions`)
    if (opts.type) first.searchParams.set('type', opts.type)
    if (opts.status) first.searchParams.set('status', opts.status)
    url = first.toString()
  }
  const { body, nextUrl } = await transport.getJson<{
    discussions?: unknown[]
    count?: number
    start?: number
  }>(url)
  const items = (body.discussions ?? []).map((discussion) => mapDiscussionSummary(discussion as never))
  let nextCursor = nextUrl
  if (!nextCursor && items.length > 0 && body.count !== undefined) {
    const seen = (body.start ?? 0) + items.length
    if (seen < body.count) {
      const next = new URL(url)
      const page = Number(next.searchParams.get('p') ?? '0')
      next.searchParams.set('p', String(page + 1))
      nextCursor = next.toString()
    }
  }
  return { items, nextCursor }
}

export async function getDiscussionDiff(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  num: number
): Promise<string> {
  const url = `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}`
  const { body } = await transport.getJson<{ diffUrl?: string }>(url, { ttl: 5_000 })
  if (!body.diffUrl) return ''
  const diff = await transport.getText(hubRelativeUrl(body.diffUrl, transport.endpoint))
  return diff.length <= DIFF_MAX_CHARS
    ? diff
    : `${diff.slice(0, DIFF_MAX_CHARS)}\n... (diff truncated)`
}

export async function getDiscussion(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  num: number
): Promise<DiscussionDetail> {
  const { body } = await transport.getJson<unknown>(
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}`,
    { ttl: 5_000 }
  )
  return mapDiscussionDetail(body as never)
}

export async function commentOnDiscussion(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  num: number,
  comment: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/comment`,
    { comment }
  )
}

export async function createDiscussion(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  title: string,
  description: string,
  pullRequest = false
): Promise<{ num: number }> {
  const response = await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions`,
    { title, description, pullRequest }
  )
  const body = (await response.json().catch(() => ({}))) as { num?: number }
  return { num: body.num ?? 0 }
}

export async function setDiscussionCommentReaction(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  num: number,
  commentId: string,
  reaction: string,
  active: boolean
): Promise<void> {
  const url = `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/comment/${encodeURIComponent(commentId)}/reaction`
  await transport.sendJson('POST', url, { reaction, action: active ? 'add' : 'remove' }, { auth: 'cookie' })
}

export async function mergePullRequest(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  num: number,
  comment?: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/merge`,
    { comment }
  )
}

export async function setDiscussionStatus(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  num: number,
  status: 'open' | 'closed',
  comment?: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/status`,
    { status, comment }
  )
}

export async function setDiscussionTitle(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  num: number,
  title: string
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/title`,
    { title }
  )
}
