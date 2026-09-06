import type { PostComment } from '@hubfetch/shared'
import { hubRelativeUrl } from '@hubfetch/shared'

interface RawReaction {
  reaction?: string
  count?: number
  users?: string[]
}

interface RawPostComment {
  id?: string
  type?: string
  author?: { name?: string; fullname?: string; avatarUrl?: string; isPro?: boolean }
  createdAt?: string
  data?: {
    hidden?: boolean
    hiddenReason?: string
    hiddenBy?: string
    latest?: { raw?: string }
    reactions?: RawReaction[]
  }
  replies?: RawPostComment[]
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function normalizeReactions(raw: RawReaction[] | undefined): PostComment['reactions'] {
  return (raw ?? []).flatMap((reaction) => {
    const emoji = reaction.reaction
    if (!emoji) return []
    const users = Array.isArray(reaction.users)
      ? reaction.users.filter((user): user is string => typeof user === 'string')
      : []
    return [{ emoji, count: typeof reaction.count === 'number' ? reaction.count : users.length, users }]
  })
}

export function parsePostComments(html: string, endpoint: string): PostComment[] | undefined {
  const match =
    /data-target="SocialPost"[^>]*data-props="([^"]*)"/.exec(html) ??
    /data-props="([^"]*)"[^>]*data-target="SocialPost"/.exec(html)
  if (!match) return undefined
  let comments: RawPostComment[]
  try {
    const props = JSON.parse(decodeHtmlAttribute(match[1] ?? '')) as {
      socialPost?: { comments?: RawPostComment[] }
    }
    comments = props.socialPost?.comments ?? []
  } catch {
    return undefined
  }
  const absolutize = (url: string | undefined): string | undefined =>
    url ? hubRelativeUrl(url, endpoint) : undefined
  const mapOne = (comment: RawPostComment): PostComment[] => {
    if (comment.type !== 'comment' || !comment.id) return []
    const hidden = comment.data?.hidden === true
    const replies = (comment.replies ?? []).flatMap(mapOne)
    return [
      {
        id: comment.id,
        author: comment.author?.name ?? '',
        authorFullname: comment.author?.fullname,
        authorAvatarUrl: absolutize(comment.author?.avatarUrl),
        authorIsPro: comment.author?.isPro,
        createdAt: comment.createdAt,
        content: hidden ? '' : (comment.data?.latest?.raw ?? ''),
        reactions: normalizeReactions(comment.data?.reactions),
        ...(replies.length > 0 ? { replies } : {}),
        ...(hidden
          ? {
              hidden: true,
              hiddenReason: comment.data?.hiddenReason,
              hiddenBy: comment.data?.hiddenBy
            }
          : {})
      }
    ]
  }
  return comments.flatMap(mapOne)
}
