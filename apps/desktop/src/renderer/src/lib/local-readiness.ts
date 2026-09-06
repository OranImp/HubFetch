import type { ExportTarget, ExportTool } from '@hubfetch/shared'
import {
  assertNever,
  EXPORT_TOOLS,
  exportToolsFor,
  formatOf,
  READINESS_FORMATS,
  type ReadinessFormat
} from './export-tools'
import { parseShardName, shardKey, type ShardName } from './shard-name'

export { exportToolsFor, formatOf, missingGuidanceKey, READINESS_FORMATS, EXPORT_TOOLS } from './export-tools'
export type { ReadinessFormat } from './export-tools'
export { parseShardName } from './shard-name'
export type { ShardName } from './shard-name'

export const SHARD_STATES = ['single', 'complete', 'incomplete', 'duplicate', 'mixed'] as const
export type ShardState = (typeof SHARD_STATES)[number]

export type ReadinessFileInput = {
  readonly path: string
  readonly size: number
}

export type ReadinessMetadata = {
  readonly path: string
  readonly architecture?: string
  readonly quantization?: string
  readonly opset?: string
}

export type ReadinessFile = {
  readonly path: string
  readonly size: number
  readonly format: ReadinessFormat
  readonly cached: boolean
}

export type ExportTargetReadiness = {
  readonly tool: ExportTool
  readonly installed: boolean
  readonly adapterAvailable: boolean
}

export type ReadinessGroup = {
  readonly id: string
  readonly format: ReadinessFormat
  readonly formats: readonly ReadinessFormat[]
  readonly displayName: string
  readonly files: readonly ReadinessFile[]
  readonly shardState: ShardState
  readonly missingIndices: readonly number[]
  readonly duplicateIndices: readonly number[]
  readonly totalBytes: number
  readonly architecture?: string
  readonly quantization?: string
  readonly opset?: string
  readonly exportTargets: readonly ExportTargetReadiness[]
}

export type LocalReadiness = {
  readonly groups: readonly ReadinessGroup[]
}

export type LocalReadinessInput = {
  readonly files: readonly ReadinessFileInput[]
  readonly cachedPaths: ReadonlySet<string>
  readonly exportTargets: readonly ExportTarget[]
  readonly metadata?: readonly ReadinessMetadata[]
}

type GroupDraft = {
  readonly id: string
  readonly displayName: string
  readonly files: readonly ReadinessFile[]
  readonly shardState: ShardState
  readonly missingIndices: readonly number[]
  readonly duplicateIndices: readonly number[]
  readonly exportTargets: readonly ExportTarget[]
  readonly metadata: ReadonlyMap<string, ReadinessMetadata>
}

function missingIndicesOf(present: readonly number[], total: number): number[] {
  const seen = new Set(present)
  const missing: number[] = []
  for (let index = 1; index <= total; index += 1) {
    if (!seen.has(index)) missing.push(index)
  }
  return missing
}

function duplicateIndicesOf(present: readonly number[]): number[] {
  const counts = new Map<number, number>()
  for (const index of present) counts.set(index, (counts.get(index) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([index]) => index).sort((a, b) => a - b)
}

function decideShardState(
  formats: readonly ReadinessFormat[],
  indices: readonly number[],
  total: number
): { readonly state: ShardState; readonly missing: readonly number[]; readonly duplicate: readonly number[] } {
  const missing = missingIndicesOf(indices, total)
  const duplicate = duplicateIndicesOf(indices)
  if (formats.length > 1) return { state: 'mixed', missing, duplicate }
  if (duplicate.length > 0) return { state: 'duplicate', missing, duplicate }
  const extras = indices.filter((index) => index < 1 || index > total)
  if (missing.length > 0 || extras.length > 0) return { state: 'incomplete', missing, duplicate }
  return { state: 'complete', missing, duplicate }
}

function toReadinessFile(
  file: ReadinessFileInput,
  format: ReadinessFormat,
  cachedPaths: ReadonlySet<string>
): ReadinessFile {
  return { path: file.path, size: file.size, format, cached: cachedPaths.has(file.path) }
}

function targetRows(
  files: readonly ReadinessFile[],
  exportTargets: readonly ExportTarget[]
): readonly ExportTargetReadiness[] {
  const installed = new Map(exportTargets.map((row) => [row.tool, row.detected] as const))
  const adapters = new Set(files.flatMap((file) => exportToolsFor(file.path)))
  return EXPORT_TOOLS.map((tool) => ({
    tool,
    installed: installed.get(tool) === true,
    adapterAvailable: adapters.has(tool)
  }))
}

function attachMetadata(
  files: readonly ReadinessFile[],
  metadata: ReadonlyMap<string, ReadinessMetadata>
): Pick<ReadinessGroup, 'architecture' | 'quantization' | 'opset'> {
  let architecture: string | undefined
  let quantization: string | undefined
  let opset: string | undefined
  for (const file of files) {
    const row = metadata.get(file.path)
    if (!row) continue
    architecture ??= row.architecture
    quantization ??= row.quantization
    opset ??= row.opset
  }
  return {
    ...(architecture === undefined ? {} : { architecture }),
    ...(quantization === undefined ? {} : { quantization }),
    ...(opset === undefined ? {} : { opset })
  }
}

function sortFormats(formats: Iterable<ReadinessFormat>): ReadinessFormat[] {
  const set = new Set(formats)
  return READINESS_FORMATS.filter((format) => set.has(format))
}

function makeGroup(draft: GroupDraft): ReadinessGroup {
  const formats = sortFormats(draft.files.map((file) => file.format))
  return {
    id: draft.id,
    format: formats[0] ?? 'workflow',
    formats,
    displayName: draft.displayName,
    files: draft.files,
    shardState: draft.shardState,
    missingIndices: draft.missingIndices,
    duplicateIndices: draft.duplicateIndices,
    totalBytes: draft.files.reduce((sum, file) => sum + file.size, 0),
    ...attachMetadata(draft.files, draft.metadata),
    exportTargets: targetRows(draft.files, draft.exportTargets)
  }
}

function compareGroups(a: ReadinessGroup, b: ReadinessGroup): number {
  const formatDelta = READINESS_FORMATS.indexOf(a.format) - READINESS_FORMATS.indexOf(b.format)
  if (formatDelta !== 0) return formatDelta
  return a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
}

export function buildLocalReadiness(input: LocalReadinessInput): LocalReadiness {
  const metadata = new Map((input.metadata ?? []).map((row) => [row.path, row]))
  const singles: ReadinessGroup[] = []
  const buckets = new Map<string, { shard: ShardName; files: ReadinessFileInput[] }>()

  for (const file of input.files) {
    const format = formatOf(file.path)
    if (format === undefined) continue
    const shard = parseShardName(file.path)
    if (shard === undefined) {
      singles.push(
        makeGroup({
          id: file.path,
          displayName: file.path.split('/').at(-1) ?? file.path,
          files: [toReadinessFile(file, format, input.cachedPaths)],
          shardState: 'single',
          missingIndices: [],
          duplicateIndices: [],
          exportTargets: input.exportTargets,
          metadata
        })
      )
      continue
    }
    const key = shardKey(shard)
    const bucket = buckets.get(key)
    if (bucket) bucket.files.push(file)
    else buckets.set(key, { shard, files: [file] })
  }

  const groups = [...singles]
  for (const [key, bucket] of buckets) {
    const files = bucket.files
      .map((file) => {
        const format = formatOf(file.path)
        return format === undefined ? undefined : toReadinessFile(file, format, input.cachedPaths)
      })
      .filter((file): file is ReadinessFile => file !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path))
    const indices = bucket.files
      .map((file) => parseShardName(file.path)?.index)
      .filter((index): index is number => index !== undefined)
    const decided = decideShardState(
      sortFormats(files.map((file) => file.format)),
      indices,
      bucket.shard.total
    )
    groups.push(
      makeGroup({
        id: key,
        displayName: bucket.shard.prefix,
        files,
        shardState: decided.state,
        missingIndices: decided.missing,
        duplicateIndices: decided.duplicate,
        exportTargets: input.exportTargets,
        metadata
      })
    )
  }

  return { groups: groups.sort(compareGroups) }
}

export function exportFileForTool(group: ReadinessGroup, tool: ExportTool): string | undefined {
  const row = group.exportTargets.find((target) => target.tool === tool)
  if (row === undefined || !row.installed || !row.adapterAvailable) return undefined
  switch (group.shardState) {
    case 'single': {
      const file = group.files[0]
      if (file === undefined || !file.cached) return undefined
      return exportToolsFor(file.path).includes(tool) ? file.path : undefined
    }
    case 'complete': {
      if (!group.files.every((file) => file.cached)) return undefined
      return group.files.find((file) => exportToolsFor(file.path).includes(tool))?.path
    }
    case 'incomplete':
    case 'duplicate':
    case 'mixed':
      return undefined
    default:
      return assertNever(group.shardState)
  }
}

export function downloadPathsForGroup(group: ReadinessGroup): readonly string[] {
  const uncached = group.files.filter((file) => !file.cached).map((file) => file.path)
  return uncached.length > 0 ? uncached : group.files.map((file) => file.path)
}
