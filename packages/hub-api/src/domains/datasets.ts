import type { DatasetRows, DatasetSplit, RepoKind } from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { DATASETS_SERVER } from '../constants'
import { HubApiError, HubCapabilityError } from '../errors'
import { fetchRepoPage } from './repo-page'
import { parseDatasetSampleRows } from './datasets-mappers'
import { resolveUrl } from './repos-read'

const RANGE_FALLBACK_MAX = 64 * 1024 * 1024

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

export async function fetchFileRange(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string,
  path: string,
  start: number,
  end: number,
  revision = 'main'
): Promise<Uint8Array> {
  const url = resolveUrl(transport, kind, repoId, revision, path)
  const response = await transport.request(url, {
    headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }
  })
  if (response.status !== 200 && response.status !== 206) {
    await transport.ensureOk(response, 'GET', url)
  }
  if (response.status === 206) return new Uint8Array(await response.arrayBuffer())
  if (end >= RANGE_FALLBACK_MAX) {
    await response.body?.cancel()
    throw new HubApiError('server does not support range requests', response.status, url)
  }
  const { bytes } = await transport.readBodyCapped(response, end + 1)
  return bytes.slice(start, end + 1)
}

export async function getDatasetSampleRows(
  transport: HubTransport,
  repoId: string
): Promise<DatasetRows | undefined> {
  return parseDatasetSampleRows(await fetchRepoPage(transport, 'dataset', repoId))
}

export async function getDatasetSplits(
  transport: HubTransport,
  repoId: string
): Promise<DatasetSplit[]> {
  const { body } = await transport.getJson<{
    splits?: Array<{ config?: string; split?: string }>
  }>(`${DATASETS_SERVER}/splits?dataset=${encodeURIComponent(repoId)}`)
  if (!Array.isArray(body.splits)) {
    throw new HubCapabilityError(
      'getDatasetSplits',
      'upstream-changed',
      'The datasets server split response changed.'
    )
  }
  return body.splits.map((split) => ({
    config: split.config ?? '',
    split: split.split ?? ''
  }))
}

export async function getDatasetRows(
  transport: HubTransport,
  repoId: string,
  config: string,
  split: string,
  offset = 0,
  length = 20
): Promise<DatasetRows> {
  const url = new URL(`${DATASETS_SERVER}/rows`)
  url.searchParams.set('dataset', repoId)
  url.searchParams.set('config', config)
  url.searchParams.set('split', split)
  url.searchParams.set('offset', String(offset))
  url.searchParams.set('length', String(length))
  const { body } = await transport.getJson<{
    features?: Array<{ name?: string }>
    rows?: Array<{ row?: Record<string, unknown> }>
    num_rows_total?: number
  }>(url.toString())
  if (!Array.isArray(body.features) || !Array.isArray(body.rows)) {
    throw new HubCapabilityError(
      'getDatasetRows',
      'upstream-changed',
      'The datasets server rows response changed.'
    )
  }
  const columns = body.features.map((feature) => feature.name ?? '')
  const values = body.rows.map((row) => {
    const record = row.row ?? {}
    return columns.map((column) => record[column] ?? null)
  })
  const rows = values.map((row) => row.map((cell) => formatCell(cell)))
  return { columns, rows, values, total: body.num_rows_total }
}
