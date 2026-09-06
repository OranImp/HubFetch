import type { DatasetRows } from '@hubfetch/shared'
import { DATASET_PREVIEW_PAGE_SIZE } from '@hubfetch/shared'
import { formatParquetCell, imageMimeOfBytes } from '@/lib/parquet'

export const JSON_VALUE_KINDS = [
  'null',
  'boolean',
  'number',
  'string',
  'array',
  'object',
  'media'
] as const
export type JsonValueKind = (typeof JSON_VALUE_KINDS)[number]

export type ColumnProfile = {
  readonly name: string
  readonly kinds: readonly JsonValueKind[]
  readonly nullCount: number
  readonly numericMin?: number
  readonly numericMax?: number
  readonly stringMinLength?: number
  readonly stringMaxLength?: number
  readonly distinctCount: number
}

export type PageProfile = {
  readonly rowCount: number
  readonly maxRows: number
  readonly columns: readonly ColumnProfile[]
}

export function pageValues(page: DatasetRows): unknown[][] {
  return page.values ?? page.rows
}

export function visibleColumnIndices(
  columns: readonly string[],
  hidden: ReadonlySet<string>
): number[] {
  return columns.flatMap((name, index) => (hidden.has(name) ? [] : [index]))
}

export function matchingColumnNames(columns: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...columns]
  return columns.filter((name) => name.toLowerCase().includes(needle))
}

export function isMediaValue(value: unknown): boolean {
  if (value instanceof Uint8Array) return imageMimeOfBytes(value) !== null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.sampling_rate === 'number') return true
  if (typeof record.src !== 'string') return false
  return typeof record.height === 'number' || typeof record.width === 'number'
}

export function inferJsonKind(value: unknown): JsonValueKind {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  if (Array.isArray(value)) return 'array'
  if (isMediaValue(value)) return 'media'
  return 'object'
}

function distinctKey(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (value instanceof Uint8Array) return `bytes:${value.byteLength}`
  if (typeof value === 'string') return `s:${value}`
  if (typeof value === 'number') return `n:${value}`
  if (typeof value === 'boolean') return `b:${value}`
  try {
    return `j:${JSON.stringify(value)}`
  } catch {
    return `x:${String(value)}`
  }
}

function profileColumn(
  name: string,
  values: readonly (readonly unknown[])[],
  index: number,
  distinctCap: number
): ColumnProfile {
  const kinds = new Set<JsonValueKind>()
  const distinct = new Set<string>()
  let nullCount = 0
  let numericMin: number | undefined
  let numericMax: number | undefined
  let stringMinLength: number | undefined
  let stringMaxLength: number | undefined
  for (const row of values) {
    const cell = row[index]
    const kind = inferJsonKind(cell)
    kinds.add(kind)
    if (kind === 'null') {
      nullCount += 1
    } else if (kind === 'number' && typeof cell === 'number' && Number.isFinite(cell)) {
      numericMin = numericMin === undefined ? cell : Math.min(numericMin, cell)
      numericMax = numericMax === undefined ? cell : Math.max(numericMax, cell)
    } else if (kind === 'string' && typeof cell === 'string') {
      const length = cell.length
      stringMinLength = stringMinLength === undefined ? length : Math.min(stringMinLength, length)
      stringMaxLength = stringMaxLength === undefined ? length : Math.max(stringMaxLength, length)
    }
    if (distinct.size < distinctCap) distinct.add(distinctKey(cell))
  }
  return {
    name,
    kinds: JSON_VALUE_KINDS.filter((kind) => kinds.has(kind)),
    nullCount,
    ...(numericMin === undefined ? {} : { numericMin, numericMax }),
    ...(stringMinLength === undefined ? {} : { stringMinLength, stringMaxLength }),
    distinctCount: distinct.size
  }
}

export function profileCurrentPage(
  columns: readonly string[],
  values: readonly (readonly unknown[])[],
  visibleIndices: readonly number[]
): PageProfile {
  const distinctCap = Math.max(values.length, 0)
  return {
    rowCount: values.length,
    maxRows: DATASET_PREVIEW_PAGE_SIZE,
    columns: visibleIndices.flatMap((index) => {
      const name = columns[index]
      return name === undefined ? [] : [profileColumn(name, values, index, distinctCap)]
    })
  }
}

export function filterPageRowIndices(
  values: readonly (readonly unknown[])[],
  query: string,
  visibleIndices: readonly number[]
): number[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return values.map((_, index) => index)
  const matches: number[] = []
  for (let i = 0; i < values.length; i++) {
    const row = values[i]
    if (!row) continue
    const hit = visibleIndices.some((col) =>
      formatParquetCell(row[col]).toLowerCase().includes(needle)
    )
    if (hit) matches.push(i)
  }
  return matches
}
