import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadProxyOverride, ProxyConfig, ProxySnapshot } from '@hubfetch/shared'
import { DownloadManager } from './downloads'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

interface PersistCall extends Record<string, unknown> {
  id: string
}

class FakeDatabase {
  readonly writes: PersistCall[] = []

  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  prepare(sql: string): {
    all: () => Record<string, unknown>[]
    run: (params?: PersistCall | string) => void
  } {
    if (sql.includes('SELECT * FROM downloads')) {
      return { all: () => this.rows, run: () => undefined }
    }
    if (sql.includes('INSERT INTO downloads')) {
      return {
        all: () => [],
        run: (params) => {
          if (params && typeof params !== 'string') this.writes.push({ ...params })
        }
      }
    }
    return { all: () => [], run: () => undefined }
  }

  transaction<T>(fn: () => T): () => T {
    return () => fn()
  }
}

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function createSettings(proxy: ProxyConfig) {
  const value = {
    downloadConcurrency: 0,
    speedLimitBps: null,
    hfCacheDir: '/tmp/omh-proxy-test-cache',
    proxy
  }
  return { get: () => value }
}

function createHub() {
  return {
    baseUrl: 'https://hub.example.test',
    getRepoDetail: vi.fn().mockResolvedValue({ sha: COMMIT }),
    getFileTree: vi
      .fn()
      .mockResolvedValue([
        { type: 'file', path: 'weights.bin', size: 42, lfs: { oid: 'f'.repeat(64), size: 42 } }
      ])
  }
}

function createManager(
  db: FakeDatabase,
  settings: ReturnType<typeof createSettings>
): DownloadManager {
  return new DownloadManager(
    db as never,
    settings as never,
    createHub() as never,
    { show: vi.fn() } as never,
    () => 'hf_test',
    vi.fn()
  )
}

afterEach(() => {
  vi.useRealTimers()
})

/** Compile-time exhaustiveness: adding a ProxySnapshot mode fails this typecheck. */
function snapshotLabel(snapshot: ProxySnapshot): string {
  switch (snapshot.mode) {
    case 'system':
      return 'system'
    case 'direct':
      return 'direct'
    case 'manual':
      return `manual:${snapshot.url}`
    default: {
      // When every mode is handled, `snapshot` narrows to never here; adding a
      // fourth mode makes this assignment fail, breaking the build.
      const exhaustive: never = snapshot
      return exhaustive
    }
  }
}

describe('DownloadManager frozen proxy snapshot', () => {
  it('freezes the per-create override snapshot over the settings default', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(
      db,
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' })
    )

    await manager.start({
      repoId: 'org/repo',
      kind: 'model',
      proxy: { mode: 'manual', url: 'http://10.0.0.1:3128' } satisfies DownloadProxyOverride
    })

    expect(manager.list()[0]!.proxy).toEqual({ mode: 'manual', url: 'http://10.0.0.1:3128' })
    expect(db.writes.at(-1)).toMatchObject({
      proxyMode: 'manual',
      proxyUrl: 'http://10.0.0.1:3128'
    })
    manager.shutdown()
  })

  it('freezes the settings manual config when no override is given', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(
      db,
      createSettings({ mode: 'manual', manualUrl: 'http://127.0.0.1:7897' })
    )

    await manager.start({ repoId: 'org/repo', kind: 'model' })

    expect(manager.list()[0]!.proxy).toEqual({ mode: 'manual', url: 'http://127.0.0.1:7897' })
    expect(db.writes.at(-1)).toMatchObject({
      proxyMode: 'manual',
      proxyUrl: 'http://127.0.0.1:7897'
    })
    manager.shutdown()
  })

  it('freezes direct and system snapshots with no endpoint', async () => {
    vi.useFakeTimers()
    const direct = createManager(
      new FakeDatabase(),
      createSettings({ mode: 'direct', manualUrl: null })
    )
    await direct.start({ repoId: 'org/d', kind: 'model' })
    expect(direct.list()[0]!.proxy).toEqual({ mode: 'direct' })

    const system = createManager(
      new FakeDatabase(),
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' })
    )
    await system.start({ repoId: 'org/s', kind: 'model' })
    expect(system.list()[0]!.proxy).toEqual({ mode: 'system' })

    direct.shutdown()
    system.shutdown()
  })

  it('persists a byte-identical snapshot across a simulated restart', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(
      db,
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' })
    )
    await manager.start({
      repoId: 'org/repo',
      kind: 'model',
      proxy: { mode: 'manual', url: 'http://10.0.0.1:3128' }
    })
    const first = manager.list()[0]!
    const write = db.writes.at(-1)!

    // Rehydrate a fresh manager from the exact persisted row (a restart).
    const row: Record<string, unknown> = {
      id: write.id,
      repo_id: write.repoId,
      kind: write.kind,
      revision: write.revision,
      resolved_commit: write.resolvedCommit,
      endpoint: write.endpoint,
      proxy_mode: write.proxyMode,
      proxy_url: write.proxyUrl,
      cache_dir: write.cacheDir,
      environment_version: write.environmentVersion,
      status: write.status,
      total_bytes: write.totalBytes,
      received_bytes: write.receivedBytes,
      files_json: write.filesJson,
      error: write.error,
      error_code: write.errorCode,
      created_at: write.createdAt,
      completed_at: write.completedAt
    }
    const restarted = createManager(
      new FakeDatabase([row]),
      createSettings({ mode: 'manual', manualUrl: 'http://9.9.9.9:1' })
    )
    const reloaded = restarted.list()[0]!

    expect(JSON.stringify(reloaded.proxy)).toBe(JSON.stringify(first.proxy))
    expect(reloaded.proxy).toEqual(first.proxy)
    manager.shutdown()
    restarted.shutdown()
  })

  it('never rewrites the frozen snapshot when settings change', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const settingsValue: {
      downloadConcurrency: number
      speedLimitBps: null
      hfCacheDir: string
      proxy: ProxyConfig
    } = {
      downloadConcurrency: 0,
      speedLimitBps: null,
      hfCacheDir: '/tmp/omh-proxy-test-cache',
      proxy: { mode: 'system', manualUrl: 'http://127.0.0.1:7897' }
    }
    const settings = { get: () => settingsValue }
    const manager = createManager(db, settings)
    await manager.start({ repoId: 'org/repo', kind: 'model' })
    const id = manager.list()[0]!.id
    const before = manager.list()[0]!.proxy

    // Settings switch to a different manual proxy; pause forces a persist.
    settingsValue.proxy = { mode: 'manual', manualUrl: 'http://10.9.9.9:8080' }
    db.writes.length = 0
    manager.pause(id)

    const write = db.writes.at(-1)!
    expect(write.proxyMode).toBe(before.mode)
    expect(write.proxyUrl).toBeNull()
    expect(manager.list()[0]!.proxy).toEqual(before)
    manager.shutdown()
  })
})

describe('ProxySnapshot exhaustive matching', () => {
  it('labels every closed mode with no fallback branch', () => {
    expect(snapshotLabel({ mode: 'system' })).toBe('system')
    expect(snapshotLabel({ mode: 'direct' })).toBe('direct')
    expect(snapshotLabel({ mode: 'manual', url: 'http://127.0.0.1:7897' })).toBe(
      'manual:http://127.0.0.1:7897'
    )
  })
})
