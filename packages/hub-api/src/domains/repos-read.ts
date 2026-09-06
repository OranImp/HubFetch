import type {
  FileTextResult,
  FileTreeEntry,
  Page,
  RepoDetail,
  RepoKind,
  RepoSummary,
  SafetensorsHeader,
  SafetensorsTensor,
  SearchQuery
} from '@hubfetch/shared'
import { HubApiError, isNotFound } from '../errors'
import type { HubTransport } from '../core/transport'
import { API_PATH, RESOLVE_PREFIX } from '../constants'
import { mapFileTree, mapRepoDetail, mapRepoSummary } from '../mappers'

const SORT_PARAM: Record<SearchQuery['sort'], string> = {
  trending: 'trendingScore',
  downloads: 'downloads',
  likes: 'likes',
  updated: 'lastModified',
  created: 'createdAt'
}

const LIST_EXPAND: Record<RepoKind, string[]> = {
  model: [
    'downloads',
    'likes',
    'lastModified',
    'createdAt',
    'pipeline_tag',
    'library_name',
    'tags',
    'private',
    'gated',
    'trendingScore',
    'safetensors'
  ],
  dataset: [
    'downloads',
    'likes',
    'lastModified',
    'createdAt',
    'tags',
    'private',
    'gated',
    'trendingScore'
  ],
  space: [
    'likes',
    'lastModified',
    'createdAt',
    'tags',
    'private',
    'sdk',
    'cardData',
    'runtime'
  ]
}

const SAFETENSORS_MAX_HEADER_BYTES = 8 * 1024 * 1024

export function buildSearchUrl(transport: HubTransport, query: SearchQuery): string {
  const url = new URL(`${transport.endpoint}/api/${API_PATH[query.kind]}`)
  if (query.search) url.searchParams.set('search', query.search)
  if (query.author) url.searchParams.set('author', query.author)
  if (query.pipelineTag) url.searchParams.set('pipeline_tag', query.pipelineTag)
  if (query.library) url.searchParams.set('library', query.library)
  for (const tag of query.tags ?? []) url.searchParams.append('filter', tag)
  if (query.license) url.searchParams.append('filter', `license:${query.license}`)
  if (query.inferenceProvider && query.kind === 'model') {
    url.searchParams.set('inference_provider', query.inferenceProvider)
  }
  url.searchParams.set('sort', SORT_PARAM[query.sort])
  url.searchParams.set('direction', '-1')
  url.searchParams.set('limit', String(query.limit ?? 30))
  for (const field of LIST_EXPAND[query.kind]) url.searchParams.append('expand[]', field)
  return url.toString()
}

export async function searchRepos(
  transport: HubTransport,
  query: SearchQuery
): Promise<Page<RepoSummary>> {
  const { body, nextUrl } = await transport.getJson<unknown[]>(
    query.cursor ?? buildSearchUrl(transport, query)
  )
  return { items: body.map((raw) => mapRepoSummary(raw as never, query.kind)), nextCursor: nextUrl }
}

export async function getRepoDetail(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  revision?: string
): Promise<RepoDetail> {
  const revisionSuffix = revision ? `/revision/${encodeURIComponent(revision)}` : ''
  const { body } = await transport.getJson<unknown>(
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}${revisionSuffix}`
  )
  return mapRepoDetail(body as never, kind)
}

export function resolveUrl(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  revision: string,
  path: string
): string {
  const rev = encodeURIComponent(revision)
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `${transport.endpoint}/${RESOLVE_PREFIX[kind]}${repoId}/resolve/${rev}/${encodedPath}`
}

export async function getReadme(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  revision = 'main'
): Promise<string> {
  try {
    return await transport.getText(resolveUrl(transport, kind, repoId, revision, 'README.md'))
  } catch (error) {
    if (isNotFound(error)) return ''
    throw error
  }
}

export async function getFileTree(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  revision = 'main',
  path = '',
  opts: { recursive?: boolean } = {}
): Promise<FileTreeEntry[]> {
  const rev = encodeURIComponent(revision)
  const suffix = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''
  let url: string | undefined =
    `${transport.endpoint}/api/${API_PATH[kind]}/${repoId}/tree/${rev}${suffix}` +
    (opts.recursive ? '?recursive=true' : '')
  const all: FileTreeEntry[] = []
  while (url) {
    const page: { body: never[]; nextUrl?: string } = await transport.getJson<never[]>(url)
    all.push(...mapFileTree(page.body))
    url = page.nextUrl
  }
  return all
}

export async function listByAuthor(
  transport: HubTransport,
  kind: RepoKind,
  author: string,
  limit = 20
): Promise<RepoSummary[]> {
  return (await searchRepos(transport, { kind, author, sort: 'updated', limit })).items
}

export async function getFileText(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  path: string,
  revision = 'main',
  maxBytes = 512 * 1024
): Promise<FileTextResult> {
  const url = resolveUrl(transport, kind, repoId, revision, path)
  const response = await transport.request(url, {
    headers: { Range: `bytes=0-${maxBytes - 1}`, 'Accept-Encoding': 'identity' }
  })
  if (response.status !== 200 && response.status !== 206) {
    await transport.ensureOk(response, 'GET', url)
  }
  const { bytes, capped } =
    response.status === 200
      ? await transport.readBodyCapped(response, maxBytes)
      : { bytes: new Uint8Array(await response.arrayBuffer()), capped: false }
  if (bytes.includes(0)) throw new HubApiError('binary file', undefined, url)
  const size = transport.totalSizeFrom(response, bytes.byteLength)
  return { content: new TextDecoder().decode(bytes), truncated: capped || size > bytes.byteLength, size }
}

export async function fetchFileResponse(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  path: string,
  revision = 'main'
): Promise<Response> {
  const url = resolveUrl(transport, kind, repoId, revision, path)
  const response = await transport.request(url)
  await transport.ensureOk(response, 'GET', url)
  return response
}

export async function getSafetensorsHeader(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  path: string,
  revision = 'main'
): Promise<SafetensorsHeader> {
  const url = resolveUrl(transport, kind, repoId, revision, path)
  const lengthBytes = await transport.fetchRange(url, 0, 7)
  if (lengthBytes.byteLength < 8) {
    throw new HubApiError('safetensors: file too short for a header', undefined, url)
  }
  const headerLength = new DataView(
    lengthBytes.buffer,
    lengthBytes.byteOffset,
    8
  ).getBigUint64(0, true)
  if (headerLength <= 0n || headerLength > BigInt(SAFETENSORS_MAX_HEADER_BYTES)) {
    throw new HubApiError(`safetensors: implausible header length ${headerLength}`, undefined, url)
  }
  const length = Number(headerLength)
  const jsonBytes = await transport.fetchRange(url, 8, 8 + length - 1)
  const parsed = JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, unknown>
  let metadata: Record<string, string> | undefined
  const tensors: SafetensorsTensor[] = []
  let totalParams = 0
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '__metadata__') {
      metadata = value as Record<string, string>
      continue
    }
    const entry = value as { dtype?: string; shape?: unknown }
    const shape = Array.isArray(entry.shape)
      ? entry.shape.filter((dimension): dimension is number => typeof dimension === 'number')
      : []
    tensors.push({ name, dtype: entry.dtype ?? '', shape })
    totalParams += shape.reduce((total, dimension) => total * dimension, 1)
  }
  tensors.sort((left, right) => left.name.localeCompare(right.name))
  return { tensors, metadata, totalParams }
}

export async function isInferenceAvailable(transport: HubTransport, repoId: string): Promise<boolean> {
  const url = new URL(`${transport.endpoint}/api/models/${repoId}`)
  url.searchParams.append('expand[]', 'inference')
  url.searchParams.append('expand[]', 'inferenceProviderMapping')
  try {
    const { body } = await transport.getJson<{
      inference?: string
      inferenceProviderMapping?: Record<string, unknown> | unknown[]
    }>(url.toString(), { ttl: 10 * 60_000 })
    const mapping = body.inferenceProviderMapping
    const providers = Array.isArray(mapping) ? mapping.length : mapping ? Object.keys(mapping).length : 0
    return providers > 0 || body.inference === 'warm'
  } catch {
    return false
  }
}
