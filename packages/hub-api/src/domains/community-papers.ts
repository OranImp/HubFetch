import type {
  Page,
  PaperSearchResult,
  PaperSummary,
  PostComment
} from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { mapPaper, mapPaperComments, mapPaperDetail } from '../mappers'

export async function getDailyPapers(
  transport: HubTransport,
  cursor?: string
): Promise<Page<PaperSummary>> {
  const { body, nextUrl } = await transport.getJson<unknown[]>(
    cursor ?? `${transport.endpoint}/api/daily_papers?limit=50`
  )
  return { items: (body as never[]).map(mapPaper), nextCursor: nextUrl }
}

export async function getPaper(transport: HubTransport, paperId: string): Promise<PaperSummary> {
  const { body } = await transport.getJson<unknown>(
    `${transport.endpoint}/api/papers/${encodeURIComponent(paperId)}`,
    { ttl: 60_000 }
  )
  return mapPaperDetail(body as never)
}

export async function getPaperComments(
  transport: HubTransport,
  paperId: string
): Promise<PostComment[]> {
  const { body } = await transport.getJson<unknown>(
    `${transport.endpoint}/api/papers/${encodeURIComponent(paperId)}?field=comments`,
    { ttl: 10_000 }
  )
  return mapPaperComments(body as never)
}

export async function searchPapers(
  transport: HubTransport,
  query: string
): Promise<PaperSearchResult[]> {
  const url = new URL(`${transport.endpoint}/api/quicksearch`)
  url.searchParams.set('q', query)
  url.searchParams.set('type', 'paper')
  try {
    const { body } = await transport.getJson<{ papers?: Array<{ _id?: string; id?: string }> }>(
      url.toString(),
      { ttl: 60_000 }
    )
    return (body.papers ?? [])
      .filter((paper) => paper._id && paper.id)
      .slice(0, 8)
      .map((paper) => ({ id: paper._id ?? '', title: paper.id ?? '' }))
  } catch {
    return []
  }
}

export async function setPaperUpvote(
  transport: HubTransport,
  paperId: string,
  upvoted: boolean
): Promise<void> {
  await transport.sendJson(
    upvoted ? 'POST' : 'DELETE',
    `${transport.endpoint}/api/papers/${encodeURIComponent(paperId)}/upvote`,
    {},
    { auth: 'cookie' }
  )
}

export async function setCollectionUpvote(
  transport: HubTransport,
  slug: string,
  upvoted: boolean
): Promise<void> {
  await transport.sendJson(
    upvoted ? 'POST' : 'DELETE',
    `${transport.endpoint}/api/collections/${slug}/upvote`,
    {},
    { auth: 'cookie' }
  )
}

export async function commentOnPaper(
  transport: HubTransport,
  paperId: string,
  comment: string,
  replyToCommentId?: string
): Promise<void> {
  const base = `${transport.endpoint}/api/papers/${encodeURIComponent(paperId)}`
  const url = replyToCommentId
    ? `${base}/comment/${encodeURIComponent(replyToCommentId)}/reply`
    : `${base}/comment`
  const auth = transport.hasSessionCookie() ? ('cookie' as const) : ('token' as const)
  await transport.sendJson('POST', url, { comment }, { auth })
}

export async function setPaperCommentReaction(
  transport: HubTransport,
  paperId: string,
  commentId: string,
  reaction: string,
  active: boolean
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/papers/${encodeURIComponent(paperId)}/comment/${encodeURIComponent(commentId)}/reaction`,
    { reaction, action: active ? 'add' : 'remove' },
    { auth: 'cookie' }
  )
}
