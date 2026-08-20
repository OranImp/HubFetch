// apps/desktop/src/main/clone/clone-manager.test.ts
//
// Todo 32 CloneManager fake-clock integration tests (real CloneHost + fake
// utility worker + real node:sqlite store):
//   - FIFO order and exactly one active clone (queue advances automatically)
//   - queued cancellation never touches a worker; active cancellation runs the
//     Todo 27 protocol and re-pumps the queue
//   - throttled progress persistence (<= one write per window) with a final
//     flush on terminal
//   - crash/restart recovery: runtime worker crash -> interrupted; a fresh
//     manager over the same DB recovers running rows and resumes FIFO
//   - retry delegates to Todo 31 (linked fresh attempt, new destination)
//   - diagnostics / destination gates fail BEFORE any worker spawns
//   - app shutdown: bounded cancel, zero Job PIDs, zero active store rows
//   - exactly one terminal event per attempt (cancel racing completion)
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS } from '../db'
import type { CloneCreateInput, CloneRecord } from '@hubfetch/shared'
import type { CloneEvent } from '../../utility/clone-protocol'
import type {
  HubFetchJobBridge,
  HubFetchJobHandle,
  HubFetchJobOpResult
} from '../native/hubfetch-job-loader'
import type { GitProbeStatus } from '../git-diagnostics'
import { CloneHost, type CloneRunRecord, type ForkFn, type UtilityProcessLike } from './clone-host'
import { CloneManager, type CloneManagerDiagnostics } from './clone-manager'
import { CloneStore, type CloneStoreDatabase } from './clone-store'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\dev\\apps\\desktop' }
}))

// ---------------------------------------------------------------------------
// Fakes (mirrors clone-host.test.ts: real CloneHost, fake worker/job/bridge)
// ---------------------------------------------------------------------------

class FakeUtility extends EventEmitter implements UtilityProcessLike {
  pid: number | undefined = undefined
  posted: unknown[] = []
  killed = false
  constructor(public readonly assignedPid: number) {
    super()
    this.pid = assignedPid
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  workerReply(message: CloneEvent): void {
    this.emit('message', message)
  }

  spawn(): void {
    this.emit('spawn')
  }

  crash(code: number): void {
    this.emit('exit', code)
  }
}

function makeJob(): HubFetchJobHandle & {
  assignProcess: ReturnType<typeof vi.fn>
  containsProcess: ReturnType<typeof vi.fn>
  activeProcessIds: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  waitForEmpty: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    assignProcess: vi.fn(() => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    containsProcess: vi.fn(() => ({ ok: true as const, contains: true })),
    activeProcessIds: vi.fn(() => ({ ok: true as const, pids: [] })),
    terminate: vi.fn(() => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    waitForEmpty: vi.fn(async () => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    close: vi.fn(() => ({ ok: true }) as const)
  }
}

function makeBridge(job: ReturnType<typeof makeJob>): HubFetchJobBridge {
  return {
    status: 'ready',
    addonPath: 'C:\\dev\\apps\\desktop\\native\\windows\\build\\Release\\hubfetch_job.node',
    runtimeInfo: {
      addonName: 'hubfetch_job',
      addonVersion: '0.2.0',
      nodeAbi: 148,
      arch: 'x64',
      napiVersion: 10
    },
    probeJob: () => ({ ok: true }),
    createJob: () => ({ ok: true, handle: job }),
    createAskPassSession: () => ({ pipeName: 'HubFetchAskPass-qa', session: {} })
  }
}

// ---------------------------------------------------------------------------
// node:sqlite store adapter (same as clone-store tests)
// ---------------------------------------------------------------------------

function nodeStoreDb(db: DatabaseSync): CloneStoreDatabase {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql) as unknown as {
        run(...params: unknown[]): unknown
        get(...params: unknown[]): Record<string, unknown> | undefined
        all(...params: unknown[]): Record<string, unknown>[]
      }
      return statement
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const value = fn()
          db.exec('COMMIT')
          return value
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
    }
  }
}

function installedReport() {
  return {
    git: { status: 'installed' as const, version: '2.47.0' },
    xet: { status: 'unknown' as const, version: null, filterCount: 0, filters: [] },
    credentials: { status: 'unknown' as const, helperCount: 0, hasGcm: false, helpers: [] },
    gcm: { status: 'unknown' as const, version: null },
    ssh: { status: 'unknown' as const, version: null },
    configFingerprint: 'fp',
    cache: { hit: false, fingerprint: 'fp' }
  }
}

function makeDiagnostics(gitStatus: GitProbeStatus = 'installed'): CloneManagerDiagnostics & {
  check: ReturnType<typeof vi.fn>
} {
  return {
    git: ['git'],
    check: vi.fn(async () =>
      gitStatus === 'installed'
        ? installedReport()
        : { ...installedReport(), git: { status: gitStatus, version: null } }
    )
  }
}

function makeInput(
  destination: string,
  overrides: Partial<CloneCreateInput> = {}
): CloneCreateInput {
  return {
    kind: 'model',
    id: 'qa-author/model-a',
    transport: 'https',
    destination,
    auth: 'none',
    proxy: { mode: 'system' },
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  db: DatabaseSync
  store: CloneStore
  host: CloneHost
  manager: CloneManager
  job: ReturnType<typeof makeJob>
  diagnostics: ReturnType<typeof makeDiagnostics>
  utilities: FakeUtility[]
  published: CloneRecord[][]
  scratchDir: string
}

const scratchDirs: string[] = []
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function makeHarness(
  options: {
    gitStatus?: GitProbeStatus
    db?: DatabaseSync
    migrate?: boolean
    progressPersistMs?: number
    broadcastMs?: number
  } = {}
): Harness {
  const db = options.db ?? new DatabaseSync(':memory:')
  if (options.migrate !== false) {
    for (const sql of MIGRATIONS) db.exec(sql)
  }
  const store = new CloneStore(nodeStoreDb(db))
  const job = makeJob()
  const bridge = makeBridge(job)
  const utilities: FakeUtility[] = []
  const fork: ForkFn = (_modulePath, _args) => {
    const fake = new FakeUtility(0)
    utilities.push(fake)
    return fake
  }
  const host = new CloneHost({
    bridge,
    fork,
    workerModulePath: 'C:\\dev\\apps\\desktop\\out\\main\\clone-worker.mjs',
    getCloneSupport: () => ({ enabled: true, reason: null }),
    taskkill: () => ({ ok: true, error: undefined }),
    graceIntervalMs: 50,
    waitTimeoutMs: 10_000,
    emptyTimeoutMs: 2000,
    now: () => Date.now()
  })
  const diagnostics = makeDiagnostics(options.gitStatus ?? 'installed')
  const published: CloneRecord[][] = []
  const manager = new CloneManager({
    store,
    host,
    diagnostics,
    publish: (records) => published.push(records),
    progressPersistMs: options.progressPersistMs ?? 250,
    broadcastMs: options.broadcastMs ?? 100
  })
  return {
    db,
    store,
    host,
    manager,
    job,
    diagnostics,
    utilities,
    published,
    scratchDir: scratch('t32-')
  }
}

function flush(turns = 4): Promise<void> {
  let count = 0
  return new Promise((resolve) => {
    const step = (): void => {
      count += 1
      if (count >= turns) {
        resolve()
        return
      }
      setImmediate(step)
    }
    setImmediate(step)
  })
}

/**
 * Ensure FIFO creation order is observable: two creates in the same millisecond
 * tie-break by UUID, so multi-clone tests space creations apart in real time.
 */
function gap(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, label = 'condition', timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setImmediate(r))
  }
}

/** Wait until the manager's gate has spawned the Nth utility worker. */
async function waitForWorkerCount(h: Harness, count: number): Promise<FakeUtility> {
  await waitFor(() => h.utilities.length >= count, `worker ${count} fork`)
  return h.utilities[count - 1] as FakeUtility
}

async function driveToStarted(h: Harness, id: string, workerIndex = 1): Promise<FakeUtility> {
  const fake = await waitForWorkerCount(h, workerIndex)
  fake.workerReply({ type: 'ready', pid: 4242 })
  await flush(2)
  fake.workerReply({ type: 'armed', assignmentId: id })
  await flush(2)
  fake.workerReply({ type: 'started', assignmentId: id, gitPid: 5151 })
  await flush(2)
  return fake
}

async function completeClone(
  h: Harness,
  id: string,
  outcome: CloneRunRecord['outcome'] = 'completed',
  workerIndex?: number
): Promise<void> {
  const fake = (
    workerIndex === undefined ? h.utilities[h.utilities.length - 1] : h.utilities[workerIndex - 1]
  ) as FakeUtility
  fake.workerReply({
    type: 'terminal',
    assignmentId: id,
    outcome,
    exitCode: outcome === 'completed' ? 0 : 1,
    signal: null
  })
  await waitFor(() => {
    const record = h.store.get(id)
    return record !== undefined && record.status !== 'running' && record.status !== 'cancelling'
  }, `terminal for ${id}`)
}

function errorCodeOf(h: Harness, id: string): string | null {
  const row = h.db.prepare('SELECT error_code FROM clone_tasks WHERE id = ?').get(id) as
    { error_code: string | null } | undefined
  return row?.error_code ?? null
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloneManager: FIFO scheduling (one active clone at a time)', () => {
  it('runs three clones in FIFO order, one at a time, advancing automatically', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(
      makeInput(join(h.scratchDir, 'dest-a'), { id: 'qa-author/model-a' })
    )
    await gap()
    const c2 = h.manager.create(
      makeInput(join(h.scratchDir, 'dest-b'), { id: 'qa-author/model-b' })
    )
    await gap()
    const c3 = h.manager.create(
      makeInput(join(h.scratchDir, 'dest-c'), { id: 'qa-author/model-c' })
    )

    // create() pumps synchronously up to the first gate await: c1 is already
    // running in the store, c2/c3 stay queued.
    expect(h.store.get(c1.id)?.status).toBe('running')
    expect(h.store.get(c2.id)?.status).toBe('queued')
    expect(h.store.get(c3.id)?.status).toBe('queued')
    expect(h.store.activeCount()).toBe(1)

    // Publish events reached the typed publisher (list snapshots).
    expect(h.published.length).toBeGreaterThan(0)

    await driveToStarted(h, c1.id, 1)
    expect(h.utilities).toHaveLength(1)
    await completeClone(h, c1.id, 'completed', 1)
    await waitFor(() => h.store.get(c1.id)?.status === 'completed', 'c1 completed')
    // Queue advances automatically: c2 starts right after c1 terminal.
    await waitFor(() => h.store.get(c2.id)?.status === 'running', 'c2 running')
    expect(h.store.activeCount()).toBe(1)

    await driveToStarted(h, c2.id, 2)
    expect(h.utilities).toHaveLength(2)
    await completeClone(h, c2.id, 'completed', 2)
    await waitFor(() => h.store.get(c3.id)?.status === 'running', 'c3 running')
    expect(h.store.activeCount()).toBe(1)

    await driveToStarted(h, c3.id, 3)
    expect(h.utilities).toHaveLength(3)
    await completeClone(h, c3.id, 'completed', 3)
    await waitFor(() => h.store.get(c3.id)?.status === 'completed', 'c3 completed')

    expect(h.store.list().map((r) => r.id)).toEqual([c1.id, c2.id, c3.id])
    expect(h.store.list().every((r) => r.status === 'completed')).toBe(true)
    expect(h.store.activeCount()).toBe(0)
    expect(h.store.hasActive()).toBe(false)
  })

  it('never starts a second clone while one is running', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await gap()
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    await gap()
    const c3 = h.manager.create(makeInput(join(h.scratchDir, 'dest-c')))
    await driveToStarted(h, c1.id)

    // While c1 is live, creates never double-start (single active invariant).
    const c4 = h.manager.create(makeInput(join(h.scratchDir, 'dest-d')))
    expect(h.utilities).toHaveLength(1)
    expect(h.store.get(c2.id)?.status).toBe('queued')
    expect(h.store.get(c3.id)?.status).toBe('queued')
    expect(h.store.get(c4.id)?.status).toBe('queued')

    await completeClone(h, c1.id, 'completed', 1)
    await waitFor(() => h.store.get(c2.id)?.status === 'running', 'c2 running')
    // c2's worker is spawned by its own gate after store.start.
    await waitForWorkerCount(h, 2)
    expect(h.utilities).toHaveLength(2)
    expect(h.store.activeCount()).toBe(1)
  })
})

describe('CloneManager: cancellation', () => {
  it('cancels a queued clone without touching a worker', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await gap()
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    await gap()
    const c3 = h.manager.create(makeInput(join(h.scratchDir, 'dest-c')))
    await driveToStarted(h, c1.id)

    const list = await h.manager.cancel(c2.id)
    expect(list.find((r) => r.id === c2.id)?.status).toBe('cancelled')
    // No worker was ever forked for the queued cancel (only c1's worker exists).
    expect(h.utilities).toHaveLength(1)
    // The only live clone in the host is c1 (still running).
    expect(h.host.activeIds()).toEqual([c1.id])

    // The queue skips the cancelled clone: c3 runs after c1 completes.
    await completeClone(h, c1.id, 'completed', 1)
    await waitFor(() => h.store.get(c3.id)?.status === 'running', 'c3 running')
    await driveToStarted(h, c3.id, 2)
    await completeClone(h, c3.id, 'completed', 2)
    await waitFor(() => h.store.get(c3.id)?.status === 'completed', 'c3 completed')
    expect(h.store.get(c2.id)?.status).toBe('cancelled')
  })

  it('cancels an active clone through the Todo 27 protocol and re-pumps the queue', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await gap()
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    const fake = await driveToStarted(h, c1.id)
    expect(h.store.get(c1.id)?.status).toBe('running')

    const cancelPromise = h.manager.cancel(c1.id)
    await flush(2)
    // The cancel command reached the worker before any terminal.
    const cancelPosted = fake.posted.some(
      (m) => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cancel'
    )
    expect(cancelPosted).toBe(true)
    expect(h.store.get(c1.id)?.status).toBe('cancelling')

    fake.workerReply({ type: 'cancel-ack', assignmentId: c1.id })
    fake.workerReply({
      type: 'terminal',
      assignmentId: c1.id,
      outcome: 'cancelled',
      exitCode: null,
      signal: null
    })
    await cancelPromise

    expect(h.store.get(c1.id)?.status).toBe('cancelled')
    // The Job was terminated, proven empty, and closed.
    expect(h.job.terminate).toHaveBeenCalled()
    expect(h.job.waitForEmpty).toHaveBeenCalled()
    expect(h.job.close).toHaveBeenCalled()

    // Next queued clone starts automatically after the active cancel.
    await waitFor(() => h.store.get(c2.id)?.status === 'running', 'c2 running')
    await driveToStarted(h, c2.id, 2)
    await completeClone(h, c2.id, 'completed', 2)
    await waitFor(() => h.store.get(c2.id)?.status === 'completed', 'c2 completed')
  })
})

describe('CloneManager: progress persistence (throttled + final flush)', () => {
  it('persists at most once per throttle window and final-flushes on terminal', async () => {
    const h = makeHarness({ progressPersistMs: 250, broadcastMs: 100 })
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    const fake = await driveToStarted(h, c1.id)
    const spy = vi.spyOn(h.store, 'updateProgress')

    // The throttle window is controlled by the fake clock from here on.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))

    // 10 rapid progress events in the same instant: the first persists
    // immediately (last=0), the other nine defer into one window.
    for (let p = 5; p <= 50; p += 5) {
      fake.workerReply({ type: 'progress', assignmentId: c1.id, phase: 'Receiving', percent: p })
    }
    expect(spy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(250)
    expect(spy).toHaveBeenCalledTimes(2)
    const persisted = spy.mock.calls[1]?.[1] as { percent: number } | undefined
    expect(persisted?.percent).toBe(50)

    // One more progress inside the window: deferred, not yet written.
    fake.workerReply({ type: 'progress', assignmentId: c1.id, phase: 'Receiving', percent: 60 })
    expect(spy).toHaveBeenCalledTimes(2)

    // Terminal arrives WITHOUT advancing timers: the pending progress must be
    // final-flushed before the terminal transition.
    fake.workerReply({
      type: 'log',
      assignmentId: c1.id,
      line: 'unable to access https://huggingface.co/org/repo/'
    })
    fake.workerReply({
      type: 'terminal',
      assignmentId: c1.id,
      outcome: 'failed',
      exitCode: 128,
      signal: null
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(spy).toHaveBeenCalledTimes(3)
    const record = h.store.get(c1.id)
    expect(record?.status).toBe('failed')
    // Final flush persisted the latest progress BEFORE the terminal transition.
    expect(record?.progress).toEqual({ phase: 'receiving', percent: 60, done: 60, total: 100 })
    // The typed failure was classified from the captured stderr ring.
    expect(errorCodeOf(h, c1.id)).toBe('network')
    // 11 progress events -> 3 writes: throttled (<= one per 250ms window).
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('final-flushes a pending progress even when the terminal is immediate', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    const fake = await driveToStarted(h, c1.id)
    const spy = vi.spyOn(h.store, 'updateProgress')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:00:01.000Z'))

    fake.workerReply({ type: 'progress', assignmentId: c1.id, phase: 'Updating', percent: 10 })
    expect(spy).toHaveBeenCalledTimes(1)
    // The last progress arrives while the previous one is still pending.
    fake.workerReply({ type: 'progress', assignmentId: c1.id, phase: 'Updating', percent: 90 })
    // Terminal arrives before the throttle window elapses: the pending progress
    // must be final-flushed before the terminal transition.
    fake.workerReply({
      type: 'terminal',
      assignmentId: c1.id,
      outcome: 'failed',
      exitCode: 1,
      signal: null
    })
    await vi.advanceTimersByTimeAsync(0)

    const record = h.store.get(c1.id)
    expect(record?.status).toBe('failed')
    expect(record?.progress).toEqual({ phase: 'updating', percent: 90, done: 90, total: 100 })
  })
})

describe('CloneManager: crash / restart recovery', () => {
  it('classifies a runtime worker crash as interrupted and resumes the queue', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await gap()
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    const fake = await driveToStarted(h, c1.id)

    fake.crash(0)
    await waitFor(() => h.store.get(c1.id)?.status === 'interrupted', 'c1 interrupted')
    expect(h.store.get(c1.id)?.status).toBe('interrupted')
    // The Job was reaped through waitForEmpty even though the worker died.
    expect(h.job.waitForEmpty).toHaveBeenCalled()

    await waitFor(() => h.store.get(c2.id)?.status === 'running', 'c2 running after crash')
    await driveToStarted(h, c2.id, 2)
    await completeClone(h, c2.id, 'completed', 2)
    await waitFor(() => h.store.get(c2.id)?.status === 'completed', 'c2 completed')
  })

  it('recovers running rows as interrupted on restart and resumes FIFO', async () => {
    const dir = scratch('t32-restart-')
    const dbPath = join(dir, 'restart.db')

    // First "process": enqueue two clones, leave the first running mid-flight.
    const db1 = new DatabaseSync(dbPath)
    const h1 = makeHarness({ db: db1 })
    const c1 = h1.manager.create(makeInput(join(dir, 'dest-a')))
    await gap()
    const c2 = h1.manager.create(makeInput(join(dir, 'dest-b')))
    await driveToStarted(h1, c1.id)
    expect(h1.store.get(c1.id)?.status).toBe('running')
    expect(h1.store.get(c2.id)?.status).toBe('queued')
    // "Crash": abandon the first manager without terminalizing.
    db1.close()

    // Second "process": reopen the same DB and run startup recovery.
    const db2 = new DatabaseSync(dbPath)
    try {
      const h2 = makeHarness({ db: db2, migrate: false })
      const recovered = h2.manager.recover()
      expect(recovered.map((r) => r.id)).toEqual([c1.id])
      expect(recovered[0]?.status).toBe('interrupted')
      expect(h2.store.get(c1.id)?.status).toBe('interrupted')
      // Startup recovery pumps the oldest remaining queued clone automatically.
      await waitFor(() => h2.store.get(c2.id)?.status === 'running', 'c2 running after restart')
      await driveToStarted(h2, c2.id, 1)
      await completeClone(h2, c2.id, 'completed', 1)
      await waitFor(() => h2.store.get(c2.id)?.status === 'completed', 'c2 completed')
      // With nothing active, a second recovery changes nothing (idempotent).
      expect(h2.manager.recover()).toHaveLength(0)
    } finally {
      db2.close()
    }
  })
})

describe('CloneManager: retry', () => {
  it('retries a failed attempt as a linked fresh attempt with a new destination', async () => {
    const h = makeHarness({ gitStatus: 'missing' })
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    // Fail the first attempt before any worker (missing git gate).
    await waitFor(() => h.store.get(c1.id)?.status === 'failed', 'c1 failed')
    expect(errorCodeOf(h, c1.id)).toBe('dependency')
    expect(h.utilities).toHaveLength(0)

    // Git becomes available before the retry runs.
    h.diagnostics.check.mockImplementation(async () => installedReport())

    const freshDest = join(h.scratchDir, 'dest-retry')
    const retried = h.manager.retry(c1.id, makeInput(freshDest, { id: 'qa-author/model-a' }))
    expect(retried.id).not.toBe(c1.id)
    expect(retried.attempt).toBe(2)
    expect(retried.retryOf).toBe(c1.id)
    expect(retried.destination).toBe(freshDest)

    await waitFor(() => h.store.get(retried.id)?.status === 'running', 'retry running')
    await driveToStarted(h, retried.id, 1)
    await completeClone(h, retried.id, 'completed', 1)
    await waitFor(() => h.store.get(retried.id)?.status === 'completed', 'retry completed')
    // The terminal parent stays immutable.
    expect(h.store.get(c1.id)?.status).toBe('failed')
  })
})

describe('CloneManager: fail-before-spawn gates', () => {
  it('records a typed dependency failure when git diagnostics fail, never spawning a worker', async () => {
    const h = makeHarness({ gitStatus: 'missing' })
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await waitFor(() => h.store.get(c1.id)?.status === 'failed', 'c1 failed')
    expect(errorCodeOf(h, c1.id)).toBe('dependency')
    expect(h.utilities).toHaveLength(0)
    expect(h.host.activeIds()).toEqual([])
    expect(h.diagnostics.check).toHaveBeenCalled()
    expect(h.store.get(c1.id)?.error).toContain('git is not available')

    // A second clone under the same failing diagnostics also fails without spawn.
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    await waitFor(() => h.store.get(c2.id)?.status === 'failed', 'c2 failed')
    expect(h.utilities).toHaveLength(0)
  })

  it('records a typed destination failure for an unusable destination, never spawning a worker', async () => {
    const h = makeHarness()
    const occupied = join(h.scratchDir, 'occupied')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'leftover.txt'), 'partial clone data')

    const c1 = h.manager.create(makeInput(occupied))
    await waitFor(() => h.store.get(c1.id)?.status === 'failed', 'c1 failed')
    expect(errorCodeOf(h, c1.id)).toBe('destination')
    expect(h.utilities).toHaveLength(0)
    expect(h.store.get(c1.id)?.error).toContain('destination')
  })
})

describe('CloneManager: app shutdown', () => {
  it('cancels active clones, proves zero Job PIDs, and leaves queued rows queued', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await gap()
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    const fake = await driveToStarted(h, c1.id)

    const shutdownPromise = h.manager.shutdown()
    await flush(2)
    expect(h.store.get(c1.id)?.status).toBe('cancelling')
    fake.workerReply({ type: 'cancel-ack', assignmentId: c1.id })
    fake.workerReply({
      type: 'terminal',
      assignmentId: c1.id,
      outcome: 'cancelled',
      exitCode: null,
      signal: null
    })
    const result = await shutdownPromise

    expect(result.active).toEqual([c1.id])
    expect(result.remainingJobPids).toEqual([])
    expect(result.storeActive).toBe(0)
    expect(result.zeroProven).toBe(true)
    expect(h.store.get(c1.id)?.status).toBe('cancelled')
    // Queued work survives shutdown (resumed on next launch).
    expect(h.store.get(c2.id)?.status).toBe('queued')
    // The Job was terminated and proven empty before close.
    expect(h.job.terminate).toHaveBeenCalled()
    expect(h.job.waitForEmpty).toHaveBeenCalled()
    expect(h.job.close).toHaveBeenCalled()

    // A second shutdown is a no-op and still reports zero.
    const again = await h.manager.shutdown()
    expect(again.zeroProven).toBe(true)
  })

  it('shutdown during the start gate cancels before any worker spawns', async () => {
    const h = makeHarness()
    // Stall the diagnostics gate so the first attempt is mid-gate (no worker).
    let releaseGate = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    h.diagnostics.check.mockImplementation(() => gate.then(() => installedReport()))
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await waitFor(() => h.diagnostics.check.mock.calls.length > 0, 'diagnostics gate hit')
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    expect(h.utilities).toHaveLength(0)

    const shutdownPromise = h.manager.shutdown()
    await flush(2)
    expect(h.store.get(c1.id)?.status).toBe('cancelling')
    // The gate resolves after shutdown's cancel landed: the attempt aborts the
    // start BEFORE any worker spawns.
    releaseGate()
    const result = await shutdownPromise

    expect(result.zeroProven).toBe(true)
    expect(h.utilities).toHaveLength(0)
    expect(h.store.get(c1.id)?.status).toBe('cancelled')
    expect(h.store.get(c2.id)?.status).toBe('queued')
  })
})

describe('CloneManager: exactly one terminal event per attempt', () => {
  it('a cancel racing completion lands exactly one legal terminal state', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await gap()
    const c2 = h.manager.create(makeInput(join(h.scratchDir, 'dest-b')))
    const fake = await driveToStarted(h, c1.id)

    const cancelPromise = h.manager.cancel(c1.id)
    await flush(2)
    expect(h.store.get(c1.id)?.status).toBe('cancelling')
    // The worker finished BEFORE the cancel landed: terminal completed races
    // the cancel path. Exactly one terminal transition must win.
    fake.workerReply({
      type: 'terminal',
      assignmentId: c1.id,
      outcome: 'completed',
      exitCode: 0,
      signal: null
    })
    await cancelPromise

    const record = h.store.get(c1.id)
    // One legal terminal (interrupted is the legal sink from cancelling), and
    // no illegal transition / double terminal happened.
    expect(['cancelled', 'interrupted']).toContain(record?.status)

    // The queue still advances after the raced terminal.
    await waitFor(() => h.store.get(c2.id)?.status === 'running', 'c2 running after raced terminal')
    await driveToStarted(h, c2.id, 2)
    await completeClone(h, c2.id, 'completed', 2)
    await waitFor(() => h.store.get(c2.id)?.status === 'completed', 'c2 completed')
  })

  it('cancelling an already-terminal attempt is a no-op', async () => {
    const h = makeHarness()
    const c1 = h.manager.create(makeInput(join(h.scratchDir, 'dest-a')))
    await driveToStarted(h, c1.id)
    await completeClone(h, c1.id)
    await waitFor(() => h.store.get(c1.id)?.status === 'completed', 'c1 completed')

    const list = await h.manager.cancel(c1.id)
    expect(list.find((r) => r.id === c1.id)?.status).toBe('completed')
    expect(h.store.activeCount()).toBe(0)
  })
})

describe('CloneManager: remove', () => {
  it('publishes exactly once and never calls host cancel or start', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of MIGRATIONS) db.exec(sql)
    const store = new CloneStore(nodeStoreDb(db))
    const queued = store.createQueued(makeInput(join(tmpdir(), 't023-mgr-remove')))
    const completed = store.complete(store.start(queued.id).id)
    const waiting = store.createQueued(makeInput(join(tmpdir(), 't023-mgr-keep')))

    const host = {
      startClone: vi.fn(async () => ({
        assignmentId: completed.id,
        steps: [],
        outcome: 'completed' as const,
        exitCode: 0,
        signal: null,
        zeroProven: true,
        degradedTaskkill: false,
        error: null,
        gitPid: null,
        utilityPid: null,
        receivedProgress: 0,
        receivedLog: 0,
        refusedCode: null,
        appToken: false,
        askPassMerged: false,
        askPassPipeName: null
      })),
      cancelClone: vi.fn(),
      shutdown: vi.fn(),
      activeIds: vi.fn(() => [])
    }
    const published: CloneRecord[][] = []
    const manager = new CloneManager({
      store,
      host,
      diagnostics: makeDiagnostics(),
      publish: (records) => published.push(records)
    })

    const list = manager.remove(completed.id)

    expect(published).toEqual([list])
    expect(list.find((record) => record.id === completed.id)).toBeUndefined()
    expect(store.get(completed.id)).toBeUndefined()
    expect(store.get(waiting.id)?.status).toBe('queued')
    expect(host.startClone).toHaveBeenCalledTimes(0)
    expect(host.cancelClone).toHaveBeenCalledTimes(0)
    expect(host.shutdown).toHaveBeenCalledTimes(0)
    db.close()
  })
})
