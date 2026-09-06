export type ShardName = {
  readonly prefix: string
  readonly index: number
  readonly total: number
  readonly extension: string
  readonly directory: string
}

const SHARD_RE = /^(.*)-(\d+)-of-(\d+)\.([A-Za-z0-9]+)$/

export function parseShardName(path: string): ShardName | undefined {
  const normalized = path.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  const directory = slash === -1 ? '' : normalized.slice(0, slash)
  const base = slash === -1 ? normalized : normalized.slice(slash + 1)
  const match = SHARD_RE.exec(base)
  if (!match) return undefined
  const prefix = match[1]
  const extension = match[4]?.toLowerCase()
  const index = Number(match[2])
  const total = Number(match[3])
  if (prefix === undefined || extension === undefined) return undefined
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1) return undefined
  return { prefix, index, total, extension, directory }
}

export function shardKey(shard: ShardName): string {
  const stem = `${shard.prefix}|${shard.total}`
  return shard.directory === '' ? stem : `${shard.directory}/${stem}`
}
