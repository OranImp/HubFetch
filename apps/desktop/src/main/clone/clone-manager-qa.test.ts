// apps/desktop/src/main/clone/clone-manager-qa.test.ts
//
// Todo 32 QA (evidence) — REAL DownloadManager + REAL CloneManager composed
// against one real SQLite DB (node:sqlite + MIGRATIONS), fully offline:
// download workers are mocked (worker_threads) and clone workers are fake
// utility processes; Git never spawns anywhere.
//
// Happy:   two downloads + three clones run together. Downloads overlap (two
//          active at the same instant) while clones are strictly single-active
//          FIFO; the queue advances automatically; downloads are unaffected by
//          clone scheduling.
// Failure: the first clone's native Job assignment fails (no Git starts), the
//          second clone's active worker crashes (interrupted), and the third
//          clone starts only after the crashed clone's Job reached zero.
//
// Evidence is written to .omo/evidence/task-32-adopt-ohmyhf-main/ (gitignored).
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS } from '../db'
import type { CloneCreateInput, CloneRecord } from '@hubfetch/shared'
import type { CloneEvent } from '../../utility/clone-protocol'
import type {
  HubFetchJobBridge,
  HubFetchJobHandle,
  HubFetchJobOpResult
} from '../native/hubfetch-job-loader'
import { CloneHost, type ForkFn, type UtilityProcessLike } from './clone-host'
import { CloneManager, type CloneManagerDiagnostics } from './clone-manager'
import { CloneStore, type CloneStoreDatabase } from './clone-store'
import { DownloadManager } from '../downloads'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\dev\\apps\\desktop',
    getVersion: () => '0.0.0-qa'
  }
}))

// ---------------------------------------------------------------------------
// Mocked download workers (offline, deterministic; DownloadManager drives them
// through the WorkerMessage protocol)
// ---------------------------------------------------------------------------

const workerMock = vi.hoisted(() => {
  type Listener = (msg?: unknown) => void
  class FakeDownloadWorker {
    static instances: FakeDownloadWorker[] = []
    workerData: unknown
    postMessage: (msg: unknown) => void = () => undefined
    terminate: () => Promise<number> = async () => 0
    private listeners: Record<string, Listener[]> = {}

    constructor(_filename: string, options: { workerData: unknown }) {
      this.workerData = options.workerData
      FakeDownloadWorker.instances.push(this)
    }

    on(event: string, cb: Listener): void {
      this.listeners[event] = [...(this.listeners[event] ?? []), cb]
    }

    removeAllListeners(): void {
      this.listeners = {}
    }

    emit(event: string, msg?: unknown): void {
      for (const cb of this.listeners[event] ?? []) cb(msg)
    }
  }
  return { FakeDownloadWorker }
})

vi.mock('node:worker_threads', () => ({ Worker: workerMock.FakeDownloadWorker }))

// ---------------------------------------------------------------------------
// Clone fakes (real CloneHost + fake utility worker / Job / bridge)
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

  crash(code: number): void {
    this.emit('exit', code)
  }
}

function makeJob(assignOk = true): HubFetchJobHandle & {
  assignProcess: ReturnType<typeof vi.fn>
  containsProcess: ReturnType<typeof vi.fn>
  activeProcessIds: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  waitForEmpty: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    assignProcess: vi.fn(() =>
      assignOk
        ? ({ ok: true } as const)
        : ({
            ok: false,
            code: 'HUBFETCH_JOB_ASSIGN_FAILED',
            errorCode: 'access-denied',
            message: 'assign refused (qa)'
          } as const)
    ),
    containsProcess: vi.fn(() => ({ ok: true as const, contains: true })),
    activeProcessIds: vi.fn(() => ({ ok: true as const, pids: [] })),
    terminate: vi.fn(() => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    waitForEmpty: vi.fn(async () => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    close: vi.fn(() => ({ ok: true }) as const)
  }
}

// ---------------------------------------------------------------------------
// Real SQLite store adapter
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

function makeDiagnostics(): CloneManagerDiagnostics & { check: ReturnType<typeof vi.fn> } {
  return { git: ['git'], check: vi.fn(async () => installedReport()) }
}

function makeCloneInput(destination: string, repoId: string): CloneCreateInput {
  return {
    kind: 'model',
    id: repoId,
    transport: 'https',
    destination,
    auth: 'none',
    proxy: { mode: 'system' }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))
const EVIDENCE = join(ROOT, '.omo', 'evidence', 'task-32-adopt-ohmyhf-main')

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

function flush(turns = 6): Promise<void> {
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

async function waitFor(cond: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setImmediate(r))
  }
}

function gap(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface QaHarness {
  db: DatabaseSync
  downloads: DownloadManager
  clones: CloneManager
  host: CloneHost
  utilities: FakeUtility[]
  store: CloneStore
  publishedClones: CloneRecord[][]
  scratchDir: string
  jobs: Array<ReturnType<typeof makeJob>>
}

function makeHarness(options: { firstAssignFails?: boolean } = {}): QaHarness {
  const db = new DatabaseSync(':memory:')
  for (const sql of MIGRATIONS) db.exec(sql)
  const scratchDir = scratch('t32-qa-')

  // --- DownloadManager (real, offline: fake hub + mocked workers) ---
  const settings = {
    get: () => ({
      downloadConcurrency: 2,
      speedLimitBps: null,
      hfCacheDir: scratchDir,
      proxy: { mode: 'manual' as const, manualUrl: 'http://127.0.0.1:7897' }
    })
  }
  const hub = {
    baseUrl: 'https://hub.example.test',
    getRepoDetail: vi.fn().mockResolvedValue({ sha: COMMIT_A }),
    getFileTree: vi.fn().mockResolvedValue([
      {
        type: 'file' as const,
        path: 'weights.bin',
        size: 42,
        lfs: { oid: 'f'.repeat(64), size: 42 }
      }
    ])
  }
  const fakeTransport = {
    resolveProxyFor: vi.fn(),
    close: vi.fn(async () => undefined)
  }
  const downloads = new DownloadManager(
    db as never,
    settings as never,
    hub as never,
    { show: vi.fn() } as never,
    () => 'hf_test_token',
    vi.fn(),
    () => fakeTransport as never
  )

  // --- CloneManager (real CloneHost + fake utility workers) ---
  const store = new CloneStore(nodeStoreDb(db))
  const jobs: Array<ReturnType<typeof makeJob>> = []
  const bridge: HubFetchJobBridge = {
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
    createJob: () => {
      // Only the FIRST clone's Job fails assignment (qa-failure scenario);
      // every later Job is healthy.
      const failAssignment = options.firstAssignFails === true && jobs.length === 0
      const job = makeJob(!failAssignment)
      jobs.push(job)
      return { ok: true, handle: job }
    },
    createAskPassSession: () => ({ pipeName: 'HubFetchAskPass-qa', session: {} })
  }
  const utilities: FakeUtility[] = []
  const fork: ForkFn = () => {
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
  const publishedClones: CloneRecord[][] = []
  const clones = new CloneManager({
    store,
    host,
    diagnostics: makeDiagnostics(),
    publish: (records) => publishedClones.push(records),
    progressPersistMs: 250,
    broadcastMs: 100
  })
  return { db, downloads, clones, host, utilities, store, publishedClones, scratchDir, jobs }
}

const COMMIT_A = '0123456789abcdef0123456789abcdef01234567'

async function driveCloneToTerminal(h: QaHarness, id: string, index: number): Promise<void> {
  await waitFor(() => h.utilities.length >= index, `worker ${index} fork`)
  const fake = h.utilities[index - 1] as FakeUtility
  fake.workerReply({ type: 'ready', pid: 4242 })
  await flush(2)
  fake.workerReply({ type: 'armed', assignmentId: id })
  await flush(2)
  fake.workerReply({ type: 'started', assignmentId: id, gitPid: 5151 })
  await flush(2)
  fake.workerReply({
    type: 'terminal',
    assignmentId: id,
    outcome: 'completed',
    exitCode: 0,
    signal: null
  })
  await waitFor(() => {
    const record = h.store.get(id)
    return record !== undefined && record.status !== 'running' && record.status !== 'cancelling'
  }, `terminal for ${id}`)
}

// ---------------------------------------------------------------------------
// QA scenarios
// ---------------------------------------------------------------------------

describe('Todo 32 QA', () => {
  it('qa-happy: two downloads overlap while three clones serialize FIFO and auto-advance', async () => {
    const h = makeHarness()
    const lines: string[] = ['QA_HAPPY_PASS']

    // Start two downloads; both spawn workers -> both running at the same
    // instant (downloads overlap; clone scheduling never touches them).
    workerMock.FakeDownloadWorker.instances.length = 0
    await h.downloads.start({ repoId: 'qa-author/dl-a', kind: 'model', revision: COMMIT_A })
    await h.downloads.start({ repoId: 'qa-author/dl-b', kind: 'model', revision: COMMIT_A })
    await waitFor(
      () => workerMock.FakeDownloadWorker.instances.length === 2,
      'two download workers'
    )
    await flush()
    const d1 = h.downloads.list().find((t) => t.repoId === 'qa-author/dl-a')
    const d2 = h.downloads.list().find((t) => t.repoId === 'qa-author/dl-b')
    expect(d1?.status).toBe('running')
    expect(d2?.status).toBe('running')
    expect(d1?.id).not.toBe(d2?.id)

    // Three clones enqueue; exactly one runs at a time; queue advances itself.
    const c1 = h.clones.create(makeCloneInput(join(h.scratchDir, 'clone-a'), 'qa-author/clone-a'))
    await gap()
    const c2 = h.clones.create(makeCloneInput(join(h.scratchDir, 'clone-b'), 'qa-author/clone-b'))
    await gap()
    const c3 = h.clones.create(makeCloneInput(join(h.scratchDir, 'clone-c'), 'qa-author/clone-c'))
    expect(h.store.get(c1.id)?.status).toBe('running')
    expect(h.store.get(c2.id)?.status).toBe('queued')
    expect(h.store.get(c3.id)?.status).toBe('queued')

    const runOrder: string[] = []
    const maxConcurrentClones = { value: 0 }
    const observe = (): void => {
      const active = h.store
        .list()
        .filter((r) => r.status === 'running' || r.status === 'cancelling')
        .map((r) => r.repoId)
      maxConcurrentClones.value = Math.max(maxConcurrentClones.value, active.length)
      runOrder.push(...active)
    }

    // Clone 1 runs alone, then completes; the queue advances to clone 2, etc.
    await waitFor(() => h.store.get(c1.id)?.status === 'running', 'c1 running')
    observe()
    await driveCloneToTerminal(h, c1.id, 1)
    await waitFor(() => h.store.get(c1.id)?.status === 'completed', 'c1 completed')
    // Downloads are untouched by clone completions.
    expect(h.downloads.list().find((t) => t.repoId === 'qa-author/dl-a')?.status).toBe('running')

    await waitFor(() => h.store.get(c2.id)?.status === 'running', 'c2 running')
    observe()
    await driveCloneToTerminal(h, c2.id, 2)
    await waitFor(() => h.store.get(c2.id)?.status === 'completed', 'c2 completed')

    await waitFor(() => h.store.get(c3.id)?.status === 'running', 'c3 running')
    observe()
    await driveCloneToTerminal(h, c3.id, 3)
    await waitFor(() => h.store.get(c3.id)?.status === 'completed', 'c3 completed')
    observe()

    expect(maxConcurrentClones.value).toBe(1)
    expect(runOrder).toEqual(['qa-author/clone-a', 'qa-author/clone-b', 'qa-author/clone-c'])
    expect(h.store.list().every((r) => r.status === 'completed')).toBe(true)

    // Finish the downloads: both complete independently of clone scheduling.
    workerMock.FakeDownloadWorker.instances.forEach((worker) =>
      worker.emit('message', { type: 'done', verified: true })
    )
    await waitFor(
      () => h.downloads.list().every((t) => t.status === 'completed'),
      'both downloads completed'
    )
    const downloadsFinal = h.downloads.list().map((t) => ({ repoId: t.repoId, status: t.status }))

    lines.push(
      JSON.stringify({
        scenario: 'happy-two-downloads-three-clones',
        clonesRunOrder: runOrder,
        maxConcurrentClones: maxConcurrentClones.value,
        downloadsOverlapped: true,
        downloadsFinal,
        queueAdvancedAutomatically: true,
        cloneFinalStatuses: h.store.list().map((r) => ({ repoId: r.repoId, status: r.status })),
        publishedCloneSnapshots: h.publishedClones.length,
        note: 'downloads overlap (both running simultaneously); clones strictly single-active FIFO; downloads unaffected by clone scheduling'
      })
    )
    h.downloads.shutdown()
    await h.clones.shutdown()
    await writeQaHappy(lines)
  }, 30_000)

  it('qa-failure: native assignment fails (no Git) then active worker crashes; next clone starts after zero cleanup', async () => {
    const h = makeHarness({ firstAssignFails: true })
    const lines: string[] = ['QA_FAILURE_PASS']

    // Clone A: native Job assignment fails. The host reaches `assign` (after
    // the worker reports ready) but never sends `start`, so Git never spawns;
    // the attempt is terminalized as a typed failure.
    const ca = h.clones.create(makeCloneInput(join(h.scratchDir, 'fail-a'), 'qa-author/fail-a'))
    await waitFor(() => h.utilities.length >= 1, 'A worker fork')
    const fakeA = h.utilities[0] as FakeUtility
    fakeA.workerReply({ type: 'ready', pid: 4242 })
    await waitFor(() => h.store.get(ca.id)?.status === 'failed', 'A failed')
    const rowA = h.db
      .prepare('SELECT error_code, status FROM clone_tasks WHERE id = ?')
      .get(ca.id) as {
      error_code: string | null
      status: string
    }
    expect(rowA.status).toBe('failed')
    expect(rowA.error_code).toBe('internal')
    // A's host attempt never reached `start` — Git never spawned.
    const jobA = h.jobs[0]
    expect(jobA?.assignProcess).toHaveBeenCalled()
    expect(fakeA.posted.some((m) => (m as { type?: string }).type === 'start')).toBe(false)
    expect(fakeA.posted.some((m) => (m as { type?: string }).type === 'arm')).toBe(false)

    // Clone B: the worker starts, then crashes mid-flight -> interrupted.
    await gap()
    const cb = h.clones.create(makeCloneInput(join(h.scratchDir, 'fail-b'), 'qa-author/fail-b'))
    await waitFor(() => h.store.get(cb.id)?.status === 'running', 'B running')
    await waitFor(() => h.utilities.length >= 2, 'B worker fork')
    const fakeB = h.utilities[1] as FakeUtility
    fakeB.workerReply({ type: 'ready', pid: 4243 })
    await flush(2)
    fakeB.workerReply({ type: 'armed', assignmentId: cb.id })
    await flush(2)
    fakeB.workerReply({ type: 'started', assignmentId: cb.id, gitPid: 5152 })
    await flush(2)
    fakeB.crash(0)
    await waitFor(() => h.store.get(cb.id)?.status === 'interrupted', 'B interrupted')
    expect(h.jobs[1]?.waitForEmpty).toHaveBeenCalled()

    // Clone C: starts only after B's Job reached zero (cleanup complete).
    await gap()
    const cc = h.clones.create(makeCloneInput(join(h.scratchDir, 'fail-c'), 'qa-author/fail-c'))
    await waitFor(() => h.store.get(cc.id)?.status === 'running', 'C running after zero cleanup')
    await driveCloneToTerminal(h, cc.id, 3)
    await waitFor(() => h.store.get(cc.id)?.status === 'completed', 'C completed')

    lines.push(
      JSON.stringify({
        scenario: 'failure-assignment-then-crash',
        cloneA: {
          repoId: 'qa-author/fail-a',
          status: rowA.status,
          errorCode: rowA.error_code,
          gitStarted: false
        },
        cloneB: { repoId: 'qa-author/fail-b', status: 'interrupted', zeroProven: true },
        cloneC: { repoId: 'qa-author/fail-c', status: 'completed', startedAfterZeroCleanup: true },
        hostActiveAfterAll: h.host.activeIds().length,
        storeActiveAfterAll: h.store.activeCount(),
        note: 'A: native assignment failed BEFORE start (no Git); B: active worker crashed -> interrupted with Job zero proof; C: only started after B reached zero'
      })
    )
    await h.clones.shutdown()
    await writeQaFailure(lines)
  }, 30_000)
})

async function writeQaHappy(lines: string[]): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-happy.txt'), lines.join('\n') + '\n')
}

async function writeQaFailure(lines: string[]): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-failure.txt'), lines.join('\n') + '\n')
}
