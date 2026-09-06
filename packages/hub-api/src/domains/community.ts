import type {
  ActivityFeed,
  CanPostResult,
  Page,
  PostComment,
  PostSummary,
  RepoKind,
  RepoSummary,
  WatchedEntry
} from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { API_PATH } from '../constants'
import { HubApiError, HubCapabilityError } from '../errors'
import {
  mapActivityFeed,
  mapPost,
  mapRepoSummary
} from '../mappers'
import { parsePostComments } from './community-mappers'

export { getDailyPapers, getPaper, getPaperComments, searchPapers, setPaperUpvote, setCollectionUpvote, commentOnPaper, setPaperCommentReaction } from './community-papers'
export { getNotifications, markNotificationsRead, clearNotifications } from './community-notifications'

const LINK_DRAIN_MAX_PAGES = 50

function postUrl(transport: HubTransport, author: string, slug: string): string {
  return `${transport.endpoint}/api/posts/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
}

function mapWatched(raw: { _id?: string; id?: string; name?: string; type?: string }[]): WatchedEntry[] {
  return raw.map((entry) => ({
    internalId: entry._id,
    name: entry.name ?? entry.id ?? '',
    type: entry.type === 'org' ? ('org' as const) : ('user' as const)
  }))
}

export async function getPosts(
  transport: HubTransport,
  cursor?: string
): Promise<Page<PostSummary>> {
  const url = cursor ?? `${transport.endpoint}/api/posts?limit=30`
  const { body, nextUrl } = await transport.getJson<{
    socialPosts?: unknown[]
    numTotalItems?: number
  }>(url)
  if (!Array.isArray(body.socialPosts)) {
    throw new HubCapabilityError('getPosts', 'upstream-changed', 'The Hub posts response changed.')
  }
  const items = body.socialPosts.map((raw) => mapPost(raw as never, transport.endpoint))
  let nextCursor = nextUrl
  if (!nextCursor && items.length > 0) {
    const next = new URL(url)
    const skip = Number(next.searchParams.get('skip') ?? '0') + items.length
    if (body.numTotalItems === undefined || skip < body.numTotalItems) {
      next.searchParams.set('skip', String(skip))
      nextCursor = next.toString()
    }
  }
  return { items, nextCursor }
}

export async function getRecentActivity(
  transport: HubTransport,
  cursor?: string
): Promise<ActivityFeed> {
  const url = cursor ?? `${transport.endpoint}/api/recent-activity?limit=30&feedType=following&activityType=all`
  const { body } = await transport.getJson<{ recentActivity?: unknown[]; cursor?: string }>(url)
  const feed = mapActivityFeed(body as never, transport.endpoint)
  if (!feed.cursor || (body.recentActivity?.length ?? 0) === 0) return { items: feed.items, cursor: undefined }
  const next = new URL(url)
  const skip = Number(next.searchParams.get('skip') ?? '0') + (body.recentActivity?.length ?? 0)
  next.searchParams.set('skip', String(skip))
  next.searchParams.set('cursor', feed.cursor)
  return { items: feed.items, cursor: next.toString() }
}

export async function getPostDetail(
  transport: HubTransport,
  author: string,
  slug: string
): Promise<PostSummary> {
  const url = `${transport.endpoint}/api/posts?slug=${encodeURIComponent(slug)}`
  const { body } = await transport.getJson<{ socialPosts?: unknown[] }>(url, { ttl: 60_000 })
  const wanted = author.toLowerCase()
  const post = (body.socialPosts ?? [])
    .map((raw) => mapPost(raw as never, transport.endpoint))
    .find((entry) => entry.slug === slug && entry.author.toLowerCase() === wanted)
  if (!post) throw new HubApiError('post not found', 404, url)
  return post
}

export async function updateWatch(
  transport: HubTransport,
  changes: { add?: Array<{ id: string; type: 'user' | 'org' }>; delete?: Array<{ id: string; type: 'user' | 'org' }> }
): Promise<WatchedEntry[]> {
  const auth = transport.hasSessionCookie() ? ('cookie' as const) : ('token' as const)
  const response = await transport.sendJson(
    'PATCH',
    `${transport.endpoint}/api/settings/watch`,
    { add: changes.add ?? [], delete: changes.delete ?? [] },
    { auth }
  )
  const responseText = await response.text()
  if (responseText.trim() === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(responseText) as unknown
  } catch {
    throw new HubCapabilityError('updateWatch', 'upstream-changed', 'The Hub watch response changed.')
  }
  if (
    raw &&
    typeof raw === 'object' &&
    Object.keys(raw).length === 0
  ) {
    return []
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { watched?: unknown }).watched)) {
    throw new HubCapabilityError('updateWatch', 'upstream-changed', 'The Hub watch response changed.')
  }
  return mapWatched((raw as { watched: Array<{ _id?: string; id?: string; name?: string; type?: string }> }).watched)
}

export async function listWatched(transport: HubTransport): Promise<WatchedEntry[]> {
  return updateWatch(transport, { delete: [{ id: '\0no-such-account\0', type: 'user' }] })
}

export async function setWatch(
  transport: HubTransport,
  target: { id: string; type: 'user' | 'org' },
  watching: boolean
): Promise<{ applied: boolean; watched: WatchedEntry[] }> {
  const watched = await updateWatch(transport, watching ? { add: [target] } : { delete: [target] })
  const present = watched.some((entry) => entry.name.toLowerCase() === target.id.toLowerCase())
  return { applied: present === watching, watched }
}

export async function setLike(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  liked: boolean
): Promise<void> {
  await transport.sendJson(
    liked ? 'POST' : 'DELETE',
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/like`,
    undefined,
    { auth: liked ? 'cookie' : 'token' }
  )
}

export async function setFollow(
  transport: HubTransport,
  username: string,
  following: boolean,
  isOrg = false
): Promise<void> {
  const encoded = encodeURIComponent(username)
  const base = `${transport.endpoint}/api/${isOrg ? 'organizations' : 'users'}/${encoded}/follow`
  await transport.sendJson(following ? 'POST' : 'DELETE', base)
}

export async function getUserLikes(
  transport: HubTransport,
  username: string
): Promise<RepoSummary[]> {
  let url: string | undefined =
    `${transport.endpoint}/api/users/${encodeURIComponent(username)}/likes?limit=100`
  const items: RepoSummary[] = []
  let pages = 0
  while (url && pages < LINK_DRAIN_MAX_PAGES) {
    const page: { body: Array<{ repo?: { name?: string; type?: string } }>; nextUrl?: string } =
      await transport.getJson(url)
    for (const entry of page.body) {
      const repo = entry.repo
      const kind = repo?.type
      if (!repo?.name || (kind !== 'model' && kind !== 'dataset' && kind !== 'space')) continue
      items.push(mapRepoSummary({ ...repo, id: repo.name } as never, kind))
    }
    url = page.nextUrl
    pages++
  }
  return items
}

export async function commentOnPost(
  transport: HubTransport,
  author: string,
  slug: string,
  comment: string,
  replyToCommentId?: string
): Promise<void> {
  const base = postUrl(transport, author, slug)
  const url = replyToCommentId
    ? `${base}/comment/${encodeURIComponent(replyToCommentId)}/reply`
    : `${base}/comment`
  await transport.sendJson('POST', url, { comment }, { auth: 'cookie' })
}

export async function setPostReaction(
  transport: HubTransport,
  author: string,
  slug: string,
  reaction: string,
  active: boolean
): Promise<void> {
  await transport.sendJson('POST', `${postUrl(transport, author, slug)}/reaction`, {
    reaction,
    action: active ? 'add' : 'remove'
  }, { auth: 'cookie' })
}

export async function setPostCommentReaction(
  transport: HubTransport,
  author: string,
  slug: string,
  commentId: string,
  reaction: string,
  active: boolean
): Promise<void> {
  await transport.sendJson('POST', `${postUrl(transport, author, slug)}/comment/${encodeURIComponent(commentId)}/reaction`, {
    reaction,
    action: active ? 'add' : 'remove'
  }, { auth: 'cookie' })
}

export async function hidePostComment(
  transport: HubTransport,
  author: string,
  slug: string,
  commentId: string,
  reason?: string
): Promise<void> {
  await transport.sendJson('POST', `${postUrl(transport, author, slug)}/comment/${encodeURIComponent(commentId)}/hide`, reason ? { reason } : {}, { auth: 'cookie' })
}

export async function uploadCommentAsset(
  transport: HubTransport,
  data: Uint8Array,
  contentType: string
): Promise<string> {
  const url = `${transport.endpoint}/uploads`
  transport.requireCookie(url)
  const response = await transport.request(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: data as unknown as RequestInit['body']
  }, { auth: 'cookie', retryStatuses: [429] })
  await transport.ensureOk(response, 'POST', url)
  return (await response.text()).trim()
}

export async function getPostComments(
  transport: HubTransport,
  author: string,
  slug: string
): Promise<PostComment[]> {
  const url = `${transport.endpoint}/posts/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
  const comments = parsePostComments(await transport.getText(url), transport.endpoint)
  if (comments === undefined) {
    throw new HubCapabilityError('getPostComments', 'upstream-changed', 'The Hub post page changed.')
  }
  return comments
}

export async function canCreatePost(transport: HubTransport): Promise<CanPostResult> {
  const url = `${transport.endpoint}/api/posts/can-post`
  if (!transport.hasSessionCookie()) return { canPost: false }
  const response = await transport.request(url, {}, { auth: 'cookie' })
  await transport.ensureOk(response, 'GET', url)
  const body = (await response.json()) as { canPost?: boolean; reason?: string }
  return { canPost: body.canPost === true, reason: body.reason }
}

export async function createPost(
  transport: HubTransport,
  content: string
): Promise<{ slug?: string }> {
  const response = await transport.sendJson('POST', `${transport.endpoint}/api/posts`, { rawContent: content }, { auth: 'cookie' })
  const body = (await response.json().catch(() => ({}))) as {
    slug?: string
    socialPost?: { slug?: string }
  }
  return { slug: body.slug ?? body.socialPost?.slug }
}
