import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadProxyOverride, ProxyConfig, ProxySnapshot } from '@hubfetch/shared'
import { DownloadManager } from './downloads'
import type { TaskTransport } from './transport'

const workerMocks = vi.hoisted(() => ({
  jobs: [] as Array<{ taskId: string; url: string; proxy: unknown }>,
  workers: [] as Array<{
    handlers: Record<string, Array<(payload: unknown) => void>>
    postMessage: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('node:worker_threads', () => ({
  Worker: class MockWorker {
    readonly handlers: Record<string, Array<(payload: unknown) => void>> = {}
    readonly postMessage = vi.fn()
    constructor(
      _file: string,
      opts: { workerData?: { taskId: string; url: string; proxy: unknown } }
    ) {
      if (opts?.workerData) workerMocks.jobs.push(opts.workerData)
      workerMocks.workers.push(this)
    }
    on(event: string, cb: (payload: unknown) => void): this {
      ;(this.handlers[event] ??= []).push(cb)
      return this
    }
    removeAllListeners(): this {
      return this
    }
    terminate(): Promise<number> {
      return Promise.resolve(0)
    }
  }
}))

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

function createSettings(proxy: ProxyConfig, concurrency = 2) {
  const value = {
    downloadConcurrency: concurrency,
    speedLimitBps: null,
    hfCacheDir: '/tmp/omh-transport-test-cache',
    proxy
  }
  return { get: () => value }
}

interface TransportSpy {
  resolveProxyFor: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  partitions: string[]
}

function createManager(
  db: FakeDatabase,
  settings: ReturnType<typeof createSettings>,
  transports: Map<string, TransportSpy>
) {
  const factory = (taskId: string, _snapshot: ProxySnapshot): TaskTransport => {
    const spy: TransportSpy = {
      resolveProxyFor: vi.fn().mockResolvedValue('http://127.0.0.1:9090'),
      close: vi.fn().mockResolvedValue(undefined),
      partitions: []
    }
    const partition = `persist:hubfetch-task-${taskId}`
    spy.partitions.push(partition)
    transports.set(taskId, spy)
    return {
      taskId,
      snapshot: _snapshot,
      partition,
      ses: { setProxy: vi.fn() } as never,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
      resolveProxyFor: spy.resolveProxyFor,
      close: spy.close
    } as TaskTransport
  }
  return new DownloadManager(
    db as never,
    settings as never,
    createHub() as never,
    { show: vi.fn() } as never,
    () => 'hf_test',
    vi.fn(),
    factory
  )
}

async function flushSpawns(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(workerMocks.jobs.length).toBeGreaterThan(0)
    },
    { timeout: 2000 }
  )
}

afterEach(() => {
  workerMocks.jobs.length = 0
  workerMocks.workers.length = 0
  vi.useRealTimers()
})

describe('DownloadManager per-task transport policy', () => {
  it('manual snapshot → worker job carries the pinned manual proxy URL', async () => {
    const transports = new Map<string, TransportSpy>()
    const manager = createManager(
      new FakeDatabase(),
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' }),
      transports
    )
    await manager.start({
      repoId: 'org/repo',
      kind: 'model',
      proxy: { mode: 'manual', url: 'http://10.0.0.1:3128' } satisfies DownloadProxyOverride
    })
    await flushSpawns()
    const job = workerMocks.jobs[0]!
    expect(job.proxy).toEqual({ mode: 'manual', url: 'http://10.0.0.1:3128' })
    // Manual never consults the system resolver.
    for (const spy of transports.values()) expect(spy.resolveProxyFor).not.toHaveBeenCalled()
    manager.shutdown()
  })

  it('direct snapshot → worker job is Direct and never resolves a proxy', async () => {
    const transports = new Map<string, TransportSpy>()
    const manager = createManager(
      new FakeDatabase(),
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' }),
      transports
    )
    await manager.start({
      repoId: 'org/repo',
      kind: 'model',
      proxy: { mode: 'direct' } satisfies DownloadProxyOverride
    })
    await flushSpawns()
    expect(workerMocks.jobs[0]!.proxy).toEqual({ mode: 'direct' })
    for (const spy of transports.values()) expect(spy.resolveProxyFor).not.toHaveBeenCalled()
    manager.shutdown()
  })

  it('system snapshot → worker job resolves the OS route at spawn through ITS task session', async () => {
    const transports = new Map<string, TransportSpy>()
    const manager = createManager(
      new FakeDatabase(),
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' }),
      transports
    )
    await manager.start({ repoId: 'org/repo', kind: 'model' })
    await flushSpawns()
    const job = workerMocks.jobs[0]!
    expect(job.proxy).toEqual({ mode: 'system', url: 'http://127.0.0.1:9090' })
    const spy = transports.get(job.taskId)!
    expect(spy.resolveProxyFor).toHaveBeenCalledWith(job.url)
    manager.shutdown()
  })

  it('two concurrent tasks with different snapshots use distinct partitions and routes', async () => {
    const transports = new Map<string, TransportSpy>()
    const manager = createManager(
      new FakeDatabase(),
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' }, 2),
      transports
    )
    await manager.start({
      repoId: 'org/manual',
      kind: 'model',
      proxy: { mode: 'manual', url: 'http://10.0.0.1:3128' } satisfies DownloadProxyOverride
    })
    await manager.start({
      repoId: 'org/direct',
      kind: 'model',
      proxy: { mode: 'direct' } satisfies DownloadProxyOverride
    })
    await vi.waitFor(() => expect(workerMocks.jobs.length).toBe(2), { timeout: 2000 })

    const [manualJob, directJob] = workerMocks.jobs
    expect(manualJob!.proxy).toEqual({ mode: 'manual', url: 'http://10.0.0.1:3128' })
    expect(directJob!.proxy).toEqual({ mode: 'direct' })
    // Sessions are per task id — never shared between concurrent tasks.
    expect(manualJob!.taskId).not.toBe(directJob!.taskId)
    const partitions = new Set<string>()
    for (const spy of transports.values()) for (const p of spy.partitions) partitions.add(p)
    expect(partitions.size).toBe(2)
    manager.shutdown()
  })

  it('changing settings during an active transfer never affects the frozen worker policy', async () => {
    const settingsValue: {
      downloadConcurrency: number
      speedLimitBps: null
      hfCacheDir: string
      proxy: ProxyConfig
    } = {
      downloadConcurrency: 2,
      speedLimitBps: null,
      hfCacheDir: '/tmp/omh-transport-test-cache',
      proxy: { mode: 'system', manualUrl: 'http://127.0.0.1:7897' }
    }
    const settings = { get: () => settingsValue }
    const transports = new Map<string, TransportSpy>()
    const manager = new DownloadManager(
      new FakeDatabase() as never,
      settings as never,
      createHub() as never,
      { show: vi.fn() } as never,
      () => 'hf_test',
      vi.fn(),
      (taskId, snapshot) => {
        const spy: TransportSpy = {
          resolveProxyFor: vi.fn().mockResolvedValue('http://127.0.0.1:9090'),
          close: vi.fn().mockResolvedValue(undefined),
          partitions: [`persist:hubfetch-task-${taskId}`]
        }
        transports.set(taskId, spy)
        return {
          taskId,
          snapshot,
          partition: spy.partitions[0]!,
          ses: { setProxy: vi.fn() } as never,
          fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
          resolveProxyFor: spy.resolveProxyFor,
          close: spy.close
        } as TaskTransport
      }
    )
    await manager.start({
      repoId: 'org/repo',
      kind: 'model',
      proxy: { mode: 'manual', url: 'http://10.0.0.1:3128' } satisfies DownloadProxyOverride
    })
    await flushSpawns()
    const before = workerMocks.jobs[0]!.proxy

    // Settings now point at a completely different manual proxy.
    settingsValue.proxy = { mode: 'manual', manualUrl: 'http://9.9.9.9:8080' }
    workerMocks.jobs.length = 0
    manager.pause(manager.list()[0]!.id)
    manager.resume(manager.list()[0]!.id)
    await vi.waitFor(() => expect(workerMocks.jobs.length).toBe(1), { timeout: 2000 })

    expect(workerMocks.jobs[0]!.proxy).toEqual(before)
    expect(manager.list()[0]!.proxy).toEqual(before)
    manager.shutdown()
  })

  it('releases the task transport once the last worker settles', async () => {
    const transports = new Map<string, TransportSpy>()
    const manager = createManager(
      new FakeDatabase(),
      createSettings({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' }),
      transports
    )
    // Resolved-commit revision: no revision ref write, so settleTask completes cleanly.
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: COMMIT })
    await flushSpawns()
    const taskId = workerMocks.jobs[0]!.taskId
    const spy = transports.get(taskId)!
    expect(spy.close).not.toHaveBeenCalled()

    // Simulate a clean worker completion: the manager finishes the worker and
    // settles the task (single file), releasing the transport.
    const worker = workerMocks.workers[0]!
    const emit = (type: string, payload: Record<string, unknown>) => {
      for (const cb of worker.handlers[type] ?? []) cb(payload)
    }
    emit('message', { type: 'done', verified: true })

    await vi.waitFor(() => expect(spy.close).toHaveBeenCalled(), { timeout: 2000 })
    manager.shutdown()
  })
})
