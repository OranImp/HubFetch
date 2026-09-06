import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { repoCachePaths } from '@hubfetch/hub-api'
import { computeSpeedShare } from '@hubfetch/shared'
import type { ProxyConfig } from '@hubfetch/shared'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

import {
  DownloadManager,
  buildFrozenResolveUrl,
  isResolvedCommit,
  isSafeRepoFilePath
} from './downloads'

const COMMIT_A = '0123456789abcdef0123456789abcdef01234567'
const COMMIT_B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

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

function createSettings(
  overrides: Partial<{
    downloadConcurrency: number
    speedLimitBps: number | null
    hfCacheDir: string | null
    proxy: ProxyConfig
  }> = {}
) {
  const value = {
    downloadConcurrency: 0,
    speedLimitBps: null,
    hfCacheDir: '/tmp/omh-download-test-cache',
    proxy: { mode: 'manual', manualUrl: 'http://127.0.0.1:7890' } satisfies ProxyConfig,
    ...overrides
  }
  return { get: () => value }
}

function createHub() {
  return {
    baseUrl: 'https://hub.example.test',
    getRepoDetail: vi.fn().mockResolvedValue({ sha: COMMIT_A }),
    getFileTree: vi
      .fn()
      .mockResolvedValue([
        { type: 'file', path: 'weights.bin', size: 42, lfs: { oid: 'f'.repeat(64), size: 42 } }
      ])
  }
}

function createManager(
  db: FakeDatabase,
  hub = createHub(),
  settings = createSettings()
): DownloadManager {
  return new DownloadManager(
    db as never,
    settings as never,
    hub as never,
    { show: vi.fn() } as never,
    () => 'hf_test',
    vi.fn()
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('download environment helpers', () => {
  it('accepts only immutable 40-hex commits', () => {
    expect(isResolvedCommit(COMMIT_A)).toBe(true)
    expect(isResolvedCommit(COMMIT_A.toUpperCase())).toBe(true)
    expect(isResolvedCommit('main')).toBe(false)
    expect(isResolvedCommit('../escape')).toBe(false)
  })

  it('builds a commit-pinned URL on the frozen endpoint', () => {
    expect(
      buildFrozenResolveUrl(
        'https://hub.example.test/',
        'dataset',
        'org/repo',
        COMMIT_A,
        'data/a b.json'
      )
    ).toBe(`https://hub.example.test/datasets/org/repo/resolve/${COMMIT_A}/data/a%20b.json`)
  })

  it('rejects file-tree paths that could escape a snapshot', () => {
    expect(isSafeRepoFilePath('src/model.py')).toBe(true)
    expect(isSafeRepoFilePath('../outside')).toBe(false)
    expect(isSafeRepoFilePath('src\\outside')).toBe(false)
  })
})

describe('DownloadManager frozen environment', () => {
  it('pins an authenticated task to the account that was active at creation', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    let activeAccountId = '11111111-1111-4111-8111-111111111111'
    const lease = vi.fn((accountId: string) => ({
      accountId,
      accountLabel:
        accountId === '11111111-1111-4111-8111-111111111111' ? 'account-a' : 'account-b',
      accessToken: accountId === '11111111-1111-4111-8111-111111111111' ? 'token-a' : 'token-b',
      release: vi.fn()
    }))
    const manager = new DownloadManager(
      db as never,
      createSettings() as never,
      createHub() as never,
      { show: vi.fn() } as never,
      () => undefined,
      vi.fn(),
      undefined,
      { activeAccountId: () => activeAccountId, leaseAccountCredential: lease }
    )

    await manager.start({ repoId: 'org/repo', kind: 'model' })
    activeAccountId = '22222222-2222-4222-8222-222222222222'

    expect(manager.list()[0]).toMatchObject({
      accountId: '11111111-1111-4111-8111-111111111111',
      accountLabel: 'account-a'
    })
    const runtimeTokens = (manager as unknown as { runtimeAuthTokens: Map<string, string> })
      .runtimeAuthTokens
    expect([...runtimeTokens.values()]).toEqual(['token-a'])
    expect(lease).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
    expect(db.writes.at(-1)).toMatchObject({
      accountId: '11111111-1111-4111-8111-111111111111'
    })
    manager.shutdown()
  })

  it('resolves a restarted task by its stored account id without active-account fallback', () => {
    vi.useFakeTimers()
    const accountId = '11111111-1111-4111-8111-111111111111'
    const db = new FakeDatabase([
      {
        id: 'download-a',
        repo_id: 'org/repo',
        kind: 'model',
        revision: 'main',
        resolved_commit: COMMIT_A,
        endpoint: 'https://hub.example.test',
        proxy_mode: 'system',
        proxy_url: null,
        cache_dir: 'C:\\cache',
        environment_version: 1,
        account_id: accountId,
        account_label: 'account-a',
        status: 'paused',
        total_bytes: 42,
        received_bytes: 0,
        files_json: JSON.stringify([
          { path: 'weights.bin', size: 42, receivedBytes: 0, status: 'paused' }
        ]),
        error: null,
        error_code: null,
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: null
      }
    ])
    const lease = vi.fn(() => ({
      accountId,
      accountLabel: 'account-a',
      accessToken: 'token-a',
      release: vi.fn()
    }))
    const manager = new DownloadManager(
      db as never,
      createSettings() as never,
      createHub() as never,
      { show: vi.fn() } as never,
      () => 'token-b',
      vi.fn(),
      undefined,
      {
        activeAccountId: () => '22222222-2222-4222-8222-222222222222',
        leaseAccountCredential: lease
      }
    )

    manager.resume('download-a')

    expect(lease).toHaveBeenCalledWith(accountId)
    const runtimeTokens = (manager as unknown as { runtimeAuthTokens: Map<string, string> })
      .runtimeAuthTokens
    expect(runtimeTokens.get('download-a')).toBe('token-a')
    manager.shutdown()
  })

  it('marks a restarted task unavailable instead of using the active account', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase([
      {
        id: 'download-missing',
        repo_id: 'org/repo',
        kind: 'model',
        revision: 'main',
        resolved_commit: COMMIT_A,
        endpoint: 'https://hub.example.test',
        proxy_mode: 'system',
        proxy_url: null,
        cache_dir: 'C:\\cache',
        environment_version: 1,
        account_id: '11111111-1111-4111-8111-111111111111',
        account_label: 'account-a',
        status: 'paused',
        total_bytes: 42,
        received_bytes: 0,
        files_json: JSON.stringify([
          { path: 'weights.bin', size: 42, receivedBytes: 0, status: 'paused' }
        ]),
        error: null,
        error_code: null,
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: null
      }
    ])
    const manager = new DownloadManager(
      db as never,
      createSettings() as never,
      createHub() as never,
      { show: vi.fn() } as never,
      () => 'token-b',
      vi.fn(),
      undefined,
      {
        activeAccountId: () => '22222222-2222-4222-8222-222222222222',
        leaseAccountCredential: () => {
          throw new Error('account-unavailable')
        }
      }
    )

    manager.resume('download-missing')

    expect(manager.list()[0]).toMatchObject({ status: 'error', errorCode: 'account-unavailable' })
    expect(
      (manager as unknown as { runtimeAuthTokens: Map<string, string> }).runtimeAuthTokens.size
    ).toBe(0)
    manager.shutdown()
  })

  it('resolves the revision first, then enumerates the tree at that commit', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)

    const tasks = await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })

    expect(hub.getRepoDetail).toHaveBeenCalledWith('model', 'org/repo', 'main')
    expect(hub.getFileTree).toHaveBeenCalledWith('model', 'org/repo', COMMIT_A, '', {
      recursive: true
    })
    expect(tasks[0]).toMatchObject({ revision: 'main', resolvedCommit: COMMIT_A, resumable: true })
    expect(tasks[0]).toMatchObject({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } })
    expect(tasks[0]).not.toHaveProperty('environment')
    expect(tasks[0]).not.toHaveProperty('endpoint')
    expect(tasks[0]).not.toHaveProperty('proxyUrl')
    expect(tasks[0]).not.toHaveProperty('proxyMode')
    expect(tasks[0]).not.toHaveProperty('cacheDir')
    expect(db.writes.at(-1)).toMatchObject({
      resolvedCommit: COMMIT_A,
      endpoint: 'https://hub.example.test',
      proxyMode: 'manual',
      proxyUrl: 'http://127.0.0.1:7890',
      cacheDir: '/tmp/omh-download-test-cache',
      environmentVersion: 1
    })
    manager.shutdown()
  })

  it('does not deduplicate the same branch after it moves to a new commit', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const manager = createManager(db, hub)

    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const tasks = await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })

    expect(tasks.map((task) => task.resolvedCommit).sort()).toEqual([COMMIT_A, COMMIT_B].sort())
    manager.shutdown()
  })

  it('resumes with the frozen endpoint after the applied endpoint changes', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const id = manager.list()[0]!.id
    manager.pause(id)
    hub.baseUrl = 'https://another-hub.example.test'

    const resumed = manager.resume(id).find((task) => task.id === id)

    expect(resumed).toMatchObject({
      status: 'queued',
      resolvedCommit: COMMIT_A,
      resumable: true
    })
    expect(resumed?.errorCode).toBeUndefined()
    manager.shutdown()
  })

  it('flushes every dirty task in one timer window instead of only the first', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const manager = createManager(db, hub)
    await manager.start({ repoId: 'org/a', kind: 'model' })
    await manager.start({ repoId: 'org/b', kind: 'model' })
    const internals = manager as unknown as {
      tasks: Map<string, unknown>
      schedulePersist: (task: unknown) => void
    }
    const tasks = [...internals.tasks.values()]
    db.writes.length = 0

    for (const task of tasks) internals.schedulePersist(task)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(new Set(db.writes.map((write) => write.id))).toEqual(
      new Set(tasks.map((task) => (task as { id: string }).id))
    )
    manager.shutdown()
  })

  it('applies bulk pause, resume, completed cleanup, and clear actions', async () => {
    vi.useFakeTimers()
    const manager = createManager(new FakeDatabase())
    await manager.start({ repoId: 'org/a', kind: 'model' })
    await manager.start({ repoId: 'org/b', kind: 'model' })

    expect(manager.pauseAll().every((task) => task.status === 'paused')).toBe(true)
    expect(manager.resumeAll().every((task) => task.status === 'queued')).toBe(true)

    const internals = manager as unknown as {
      tasks: Map<string, { status: string }>
    }
    const first = [...internals.tasks.values()][0]!
    first.status = 'completed'
    expect(manager.clearCompleted()).toHaveLength(1)
    expect(manager.clearAll()).toHaveLength(0)
    manager.shutdown()
  })

  it('waits for an old worker to exit before pumping an immediate resume', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const settings = createSettings()
    const manager = createManager(db, createHub(), settings)
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const internals = manager as unknown as {
      tasks: Map<
        string,
        {
          id: string
          status: string
          files: Array<{ path: string; status: string }>
        }
      >
      workers: Map<
        string,
        {
          postMessage: ReturnType<typeof vi.fn>
          removeAllListeners: ReturnType<typeof vi.fn>
          terminate: ReturnType<typeof vi.fn>
        }
      >
      stoppingTasks: Map<string, Promise<unknown>>
    }
    const task = [...internals.tasks.values()][0]!
    const file = task.files[0]!
    task.status = 'running'
    file.status = 'running'
    let finishTermination!: () => void
    const terminated = new Promise<void>((resolve) => {
      finishTermination = resolve
    })
    const worker = {
      postMessage: vi.fn(),
      removeAllListeners: vi.fn(),
      terminate: vi.fn(() => terminated)
    }
    internals.workers.set(`${task.id} ${file.path}`, worker)
    settings.get().downloadConcurrency = 1

    manager.pause(task.id)
    manager.resume(task.id)

    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(internals.stoppingTasks.has(task.id)).toBe(true)
    expect(internals.workers.size).toBe(0)
    const stopping = internals.stoppingTasks.get(task.id)!
    settings.get().downloadConcurrency = 0
    finishTermination()
    await stopping
    expect(internals.stoppingTasks.has(task.id)).toBe(false)
    manager.shutdown()
  })

  it('publishes the revision ref only after every file completes', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-'))
    const db = new FakeDatabase()
    const manager = createManager(db, createHub(), createSettings({ hfCacheDir: cacheDir }))
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    const refPath = join(refsDir, 'main')
    expect(existsSync(refPath)).toBe(false)

    const internals = manager as unknown as {
      tasks: Map<string, { files: Array<{ status: string; receivedBytes: number; size: number }> }>
      settleTask: (task: unknown) => void
    }
    const task = [...internals.tasks.values()][0]!
    for (const file of task.files) {
      file.status = 'completed'
      file.receivedBytes = file.size
    }
    internals.settleTask(task)

    expect(readFileSync(refPath, 'utf8')).toBe(COMMIT_A)
    expect(manager.list()[0]).toMatchObject({ status: 'completed', resumable: false })
    manager.shutdown()
  })

  it('does not let an older branch resolution overwrite the newest revision ref', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-order-'))
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const manager = createManager(new FakeDatabase(), hub, createSettings({ hfCacheDir: cacheDir }))
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    const internals = manager as unknown as {
      tasks: Map<
        string,
        {
          resolvedCommit: string
          files: Array<{ status: string; receivedBytes: number; size: number }>
        }
      >
      settleTask: (task: unknown) => void
    }
    const tasks = [...internals.tasks.values()]
    const older = tasks.find((task) => task.resolvedCommit === COMMIT_A)!
    const newer = tasks.find((task) => task.resolvedCommit === COMMIT_B)!
    for (const task of [newer, older]) {
      for (const file of task.files) {
        file.status = 'completed'
        file.receivedBytes = file.size
      }
      internals.settleTask(task)
    }

    expect(readFileSync(join(refsDir, 'main'), 'utf8')).toBe(COMMIT_B)
    manager.shutdown()
  })

  it('orders branch aliases by request start even when the older file tree returns last', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-concurrent-'))
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const tree = [
      {
        type: 'file' as const,
        path: 'weights.bin',
        size: 42,
        lfs: { oid: 'f'.repeat(64), size: 42 }
      }
    ]
    let releaseSlowTree!: () => void
    let markSlowTreeStarted!: () => void
    const slowTreeStarted = new Promise<void>((resolve) => {
      markSlowTreeStarted = resolve
    })
    const slowTree = new Promise<typeof tree>((resolve) => {
      releaseSlowTree = () => resolve(tree)
    })
    hub.getFileTree
      .mockImplementationOnce(() => {
        markSlowTreeStarted()
        return slowTree
      })
      .mockResolvedValueOnce(tree)
    const manager = createManager(new FakeDatabase(), hub, createSettings({ hfCacheDir: cacheDir }))

    const olderStart = manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    await slowTreeStarted
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    releaseSlowTree()
    await olderStart

    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    const internals = manager as unknown as {
      tasks: Map<
        string,
        {
          resolvedCommit: string
          files: Array<{ status: string; receivedBytes: number; size: number }>
        }
      >
      settleTask: (task: unknown) => void
    }
    const tasks = [...internals.tasks.values()]
    const newer = tasks.find((task) => task.resolvedCommit === COMMIT_B)!
    const older = tasks.find((task) => task.resolvedCommit === COMMIT_A)!
    for (const task of [newer, older]) {
      for (const file of task.files) {
        file.status = 'completed'
        file.receivedBytes = file.size
      }
      internals.settleTask(task)
    }

    expect(readFileSync(join(refsDir, 'main'), 'utf8')).toBe(COMMIT_B)
    manager.shutdown()
  })

  it('refuses to publish a revision ref through a symlinked refs directory', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'omh-download-ref-outside-'))
    const db = new FakeDatabase()
    const manager = createManager(db, createHub(), createSettings({ hfCacheDir: cacheDir }))
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    symlinkSync(outside, refsDir, process.platform === 'win32' ? 'junction' : 'dir')

    const internals = manager as unknown as {
      tasks: Map<string, { files: Array<{ status: string; receivedBytes: number; size: number }> }>
      settleTask: (task: unknown) => void
    }
    const task = [...internals.tasks.values()][0]!
    for (const file of task.files) {
      file.status = 'completed'
      file.receivedBytes = file.size
    }
    internals.settleTask(task)

    expect(existsSync(join(outside, 'main'))).toBe(false)
    expect(manager.list()[0]).toMatchObject({
      status: 'error',
      errorCode: 'integrity',
      resumable: false
    })
    expect(manager.protectedTaskIds()).not.toContain(manager.list()[0]!.id)
    manager.shutdown()
  })

  it('cleans only partials with the exact task-owned file name', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-partials-'))
    const manager = createManager(
      new FakeDatabase(),
      createHub(),
      createSettings({ hfCacheDir: cacheDir })
    )
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const internals = manager as unknown as {
      tasks: Map<string, { id: string }>
      deleteTaskPartials: (task: unknown) => Promise<void>
    }
    const task = [...internals.tasks.values()][0]!
    const { blobsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(blobsDir, { recursive: true })
    const owned = join(blobsDir, `${'a'.repeat(64)}.incomplete.${task.id}-12345678`)
    const decoy = join(blobsDir, `${'b'.repeat(64)}.incomplete.${task.id}extra-12345678`)
    writeFileSync(owned, 'owned')
    writeFileSync(decoy, 'decoy')

    await internals.deleteTaskPartials(task)

    expect(existsSync(owned)).toBe(false)
    expect(existsSync(decoy)).toBe(true)
    manager.shutdown()
  })

  it('ignores a delayed settlement after a task has been removed', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(db)
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const internals = manager as unknown as {
      tasks: Map<string, { id: string }>
      settleTask: (task: unknown) => void
    }
    const task = [...internals.tasks.values()][0]!
    manager.remove(task.id)
    const writesAfterRemove = db.writes.length

    internals.settleTask(task)

    expect(manager.list()).toHaveLength(0)
    expect(db.writes).toHaveLength(writesAfterRemove)
    manager.shutdown()
  })

  it('keeps legacy in-flight rows visible but non-resumable', () => {
    const db = new FakeDatabase([
      {
        id: 'legacy',
        repo_id: 'org/repo',
        kind: 'model',
        revision: 'main',
        resolved_commit: null,
        endpoint: null,
        proxy_url: null,
        cache_dir: null,
        environment_version: null,
        status: 'paused',
        total_bytes: 1,
        received_bytes: 0,
        files_json: JSON.stringify([{ path: 'a', size: 1, receivedBytes: 0, status: 'paused' }]),
        error: null,
        error_code: null,
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: null
      }
    ])
    const manager = createManager(db)

    expect(manager.list()[0]).toMatchObject({
      id: 'legacy',
      status: 'error',
      errorCode: 'legacy-task',
      resumable: false
    })
    manager.shutdown()
  })
})

describe('DownloadManager plan flow', () => {
  it('returns an immutable plan without writing state or spawning workers', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model', revision: 'main' })

    // Plan has all required fields.
    expect(plan.planId).toBeTruthy()
    expect(plan.repoId).toBe('org/repo')
    expect(plan.kind).toBe('model')
    expect(plan.revision).toBe('main')
    expect(plan.resolvedCommit).toBe(COMMIT_A)
    expect(plan.endpoint).toBe('https://hub.example.test')
    expect(plan.proxy).toEqual({ mode: 'manual', url: 'http://127.0.0.1:7890' })
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]!.path).toBe('weights.bin')
    expect(plan.files[0]!.size).toBe(42)
    expect(plan.totalBytes).toBe(42)
    expect(plan.totalFiles).toBe(1)
    expect(plan.expiresAt).toBeTruthy()
    expect(plan.digest).toBeTruthy()

    // No DB writes happened.
    expect(db.writes).toHaveLength(0)

    // No workers were spawned.
    const internals = manager as unknown as { workers: Map<string, unknown> }
    expect(internals.workers.size).toBe(0)

    manager.shutdown()
  })

  it('starts a download from a plan with selected paths', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const tasks = await manager.startPlanned({ planId: plan.planId, paths: ['weights.bin'] })

    expect(tasks).toHaveLength(1)
    expect(tasks[0]!).toMatchObject({
      repoId: 'org/repo',
      kind: 'model',
      revision: 'main',
      resolvedCommit: COMMIT_A,
      status: 'queued',
      totalBytes: 42
    })
    expect(tasks[0]!.files).toHaveLength(1)
    expect(tasks[0]!.files[0]!.path).toBe('weights.bin')

    // DB write happened (task persisted).
    expect(db.writes.length).toBeGreaterThan(0)
    expect(db.writes.at(-1)).toMatchObject({
      resolvedCommit: COMMIT_A,
      status: 'queued'
    })

    manager.shutdown()
  })

  it('rejects an expired plan', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(db)

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })
    // Advance time past the 15-minute TTL so the timer fires and removes the plan.
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000)

    await expect(
      manager.startPlanned({ planId: plan.planId, paths: ['weights.bin'] })
    ).rejects.toThrow('plan-not-found')

    manager.shutdown()
  })

  it('rejects a tampered plan (digest mismatch)', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(db)

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })
    // Tamper with the plan's digest.
    const internals = manager as unknown as {
      plans: Map<string, { plan: { digest: string } }>
    }
    const stored = internals.plans.get(plan.planId)
    if (stored) stored.plan.digest = 'tampered-digest'

    await expect(
      manager.startPlanned({ planId: plan.planId, paths: ['weights.bin'] })
    ).rejects.toThrow('plan-digest-mismatch')

    manager.shutdown()
  })

  it('rejects an empty selection', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(db)

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })

    await expect(
      manager.startPlanned({ planId: plan.planId, paths: [] })
    ).rejects.toThrow('empty-selection')

    manager.shutdown()
  })

  it('rejects a path not in the plan', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(db)

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })

    await expect(
      manager.startPlanned({ planId: plan.planId, paths: ['nonexistent.bin'] })
    ).rejects.toThrow('unsafe-selection')

    manager.shutdown()
  })

  it('rejects an unknown plan id', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(db)

    await expect(
      manager.startPlanned({ planId: '00000000-0000-4000-8000-000000000000', paths: ['weights.bin'] })
    ).rejects.toThrow('plan-not-found')

    manager.shutdown()
  })

  it('rejects when environment changed (different endpoint)', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })
    // Change the endpoint.
    hub.baseUrl = 'https://different-hub.example.test'

    await expect(
      manager.startPlanned({ planId: plan.planId, paths: ['weights.bin'] })
    ).rejects.toThrow('environment-mismatch')

    manager.shutdown()
  })

  it('deduplicates against live tasks when starting from plan', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)

    // Create a plan and start it.
    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })
    await manager.startPlanned({ planId: plan.planId, paths: ['weights.bin'] })

    // Create another plan for the same repo/commit and try to start.
    const plan2 = await manager.plan({ repoId: 'org/repo', kind: 'model' })
    const tasks2 = await manager.startPlanned({ planId: plan2.planId, paths: ['weights.bin'] })

    // The file is already covered by the first task — no new task created.
    expect(tasks2).toHaveLength(1) // Only the first task remains.
    expect(tasks2[0]!.files[0]!.path).toBe('weights.bin')

    manager.shutdown()
  })

  it('pins an authenticated plan to the active account', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const accountId = '11111111-1111-4111-8111-111111111111'
    const lease = vi.fn(() => ({
      accountId,
      accountLabel: 'account-a',
      accessToken: 'token-a',
      release: vi.fn()
    }))
    const manager = new DownloadManager(
      db as never,
      createSettings() as never,
      createHub() as never,
      { show: vi.fn() } as never,
      () => undefined,
      vi.fn(),
      undefined,
      { activeAccountId: () => accountId, leaseAccountCredential: lease }
    )

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })

    expect(plan.accountId).toBe(accountId)
    expect(plan.accountLabel).toBe('account-a')

    // No DB writes during planning.
    expect(db.writes).toHaveLength(0)

    manager.shutdown()
  })

  it('rejects startPlanned when account changed', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    let activeAccountId = '11111111-1111-4111-8111-111111111111'
    const lease = vi.fn(() => ({
      accountId: activeAccountId,
      accountLabel: 'account-a',
      accessToken: 'token-a',
      release: vi.fn()
    }))
    const manager = new DownloadManager(
      db as never,
      createSettings() as never,
      createHub() as never,
      { show: vi.fn() } as never,
      () => undefined,
      vi.fn(),
      undefined,
      { activeAccountId: () => activeAccountId, leaseAccountCredential: lease }
    )

    const plan = await manager.plan({ repoId: 'org/repo', kind: 'model' })
    // Switch account.
    activeAccountId = '22222222-2222-4222-8222-222222222222'

    await expect(
      manager.startPlanned({ planId: plan.planId, paths: ['weights.bin'] })
    ).rejects.toThrow('account-unavailable')

    manager.shutdown()
  })

  it('strips unsafe paths from plan file tree', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    hub.getFileTree = vi.fn().mockResolvedValue([
      { type: 'file', path: 'safe.bin', size: 42 },
      { type: 'file', path: '../escape.bin', size: 10 }
    ])
    const manager = createManager(db, hub)

    await expect(
      manager.plan({ repoId: 'org/repo', kind: 'model' })
    ).rejects.toThrow('unsafe relative path')

    manager.shutdown()
  })
})

describe('computeSpeedShare', () => {
  it('returns null (unlimited) when no limit is configured', () => {
    expect(computeSpeedShare(null, 3)).toBeNull()
    expect(computeSpeedShare(undefined, 3)).toBeNull()
    expect(computeSpeedShare(0, 3)).toBeNull()
  })

  it('splits the aggregate limit evenly across workers', () => {
    expect(computeSpeedShare(3_000_000, 3)).toBe(1_000_000)
    expect(computeSpeedShare(3_000_000, 1)).toBe(3_000_000)
    expect(computeSpeedShare(1_000_000, 3)).toBe(333_333)
  })

  it('treats zero workers as one and floors at 1 B/s', () => {
    expect(computeSpeedShare(500, 0)).toBe(500)
    expect(computeSpeedShare(2, 4)).toBe(1)
  })
})
