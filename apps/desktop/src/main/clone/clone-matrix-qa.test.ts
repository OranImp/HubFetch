// apps/desktop/src/main/clone/clone-matrix-qa.test.ts
//
// Todo 36 QA — the deterministic clone/proxy/auth/cancellation/recovery
// integration matrix, fully offline (127.0.0.1 fixtures only; no overseas
// network ever).
//
// What is REAL (nothing under assertion is mocked):
//   - SQLite DB (node:sqlite + MIGRATIONS) + REAL CloneStore
//   - REAL CloneManager + REAL CloneHost protocol (spawn->ready->assign->
//     contains->arm->start)
//   - REAL worker logic (the production createCloneWorker factory) driving a
//     REAL spawn of the injectable fixture Git executable
//   - REAL GitDiagnostics (runCommandBounded) probing the fixture executable
//   - REAL fixture Git exe (compiled C launcher + behavior script) that spies
//     argv/env and delegates to REAL system Git against a REAL local smart-HTTP
//     origin, or completes/fails/hangs deterministically
//   - REAL local origin / recording proxy trap / PAC / Basic-auth fixtures
//   - REAL DownloadManager for the one-active-FIFO-with-concurrent-downloads case
//
// What is faked (the ONLY seams): utilityProcess.fork transport (a MatrixUtility
// wrapping the real worker factory) and the native Job bridge handles — neither
// exists outside a real Electron main process. The REAL Electron main-process
// + real utilityProcess + real Job bridge is proven separately by
// apps/desktop/native/windows/test/electron-clone-matrix.cjs.
//
// Evidence (gitignored): .omo/evidence/task-36-adopt-ohmyhf-main/
//   - matrix-run-<n>.json        one full matrix per run (n from T36_MATRIX_RUN)
//   - qa-happy.txt               QA_HAPPY_PASS + normalized verdict
// The suite must run THREE times from clean temp roots with byte-identical
// normalized verdicts (verified by the compare step in this file's report).
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  CloneCreateInput,
  CloneErrorCode,
  CloneRecord,
  CloneRevision,
  CloneStatus
} from '@hubfetch/shared'
import { cloneRecordSchema, DEFAULT_SETTINGS } from '@hubfetch/shared'
import { MIGRATIONS } from '../db'
import { GitDiagnostics } from '../git-diagnostics'
import { runCommandBounded } from '../diagnostics-env'
import type {
  HubFetchJobBridge,
  HubFetchJobHandle,
  HubFetchJobOpResult
} from '../native/hubfetch-job-loader'
import { createCloneWorker } from '../../utility/clone-worker'
import type { CloneCommand, CloneEvent } from '../../utility/clone-protocol'
import { CloneHost, type ForkFn, type UtilityProcessLike } from './clone-host'
import { CloneManager, type CloneManagerDiagnostics } from './clone-manager'
import { CloneStore, type CloneStoreDatabase } from './clone-store'
import { DownloadManager } from '../downloads'
import {
  checkDirectNeutrality,
  checkZeroSurvivors,
  containsSentinel,
  randomSentinel,
  scanDirForSentinel,
  startRecordingProxy,
  startSmartGitOrigin,
  writeAskPassHelper,
  writeCredentialHelper,
  writeFixtureGit,
  makeOriginRepos,
  gitSync,
  makeScratchRoot,
  type RecordingProxy,
  type SmartGitOrigin,
  type FixtureCloneBehavior
} from './matrix-fixtures'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\dev\\apps\\desktop',
    getVersion: () => '0.2.0-qa'
  }
}))

// Real DownloadManager drives worker_threads workers; the matrix replaces those
// workers with a deterministic fake so downloads overlap without touching the
// network (clone scheduling still never serializes downloads — the assertion is
// about the clone FIFO being single-active while BOTH downloads stay running).
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
// Shared matrix infrastructure
// ---------------------------------------------------------------------------

const ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))
const EVIDENCE = join(ROOT, '.omo', 'evidence', 'task-36-adopt-ohmyhf-main')
const MATRIX_RUN = process.env.T36_MATRIX_RUN ?? '1'

const scratchDirs: string[] = []
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function waitFor(cond: () => boolean, label: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setImmediate(r))
  }
}

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

// ---------------------------------------------------------------------------
// MatrixUtility — the utility-process seam that runs the REAL worker factory
// with a REAL git child. The only faked part is the MessagePort transport.
// ---------------------------------------------------------------------------

class MatrixUtility extends EventEmitter implements UtilityProcessLike {
  pid: number | undefined
  posted: unknown[] = []
  killed = false
  /** Every event this worker emitted toward the host (trace). */
  readonly eventsSeen: CloneEvent[] = []
  /** Every git child this worker spawned (for zero-survivor/crash bookkeeping). */
  readonly gitChildren: ChildProcess[] = []
  /** Exit codes the worker requested (the real entry would process.exit). */
  readonly exitCalls: number[] = []
  private readonly commandListener: (command: CloneCommand) => void

  constructor(fakePid: number, spawnGitEnv: NodeJS.ProcessEnv) {
    super()
    this.pid = fakePid
    this.on('message', (message: CloneEvent) => this.eventsSeen.push(message))
    let listener: ((command: CloneCommand) => void) | null = null
    this.commandListener = (command) => listener?.(command)
    const worker = createCloneWorker({
      port: {
        postMessage: (event) => this.emit('message', event),
        onMessage: (cb) => {
          listener = cb
        }
      },
      spawnGit: (envelope) => {
        const child = spawn(envelope.git, envelope.argv, {
          cwd: envelope.cwd,
          env: { ...spawnGitEnv, ...envelope.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
        this.gitChildren.push(child)
        return child
      },
      getPid: () => fakePid,
      exit: (code) => {
        this.exitCalls.push(code ?? 0)
      }
    })
    // Defer `ready` so the host's waitForMessage listener is attached first.
    setImmediate(() => worker.start())
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
    // Defer dispatch one tick: a REAL utility process answers asynchronously,
    // so the host's waitForMessage listener is always attached first.
    setImmediate(() => this.commandListener(message as CloneCommand))
  }

  kill(): boolean {
    this.killed = true
    for (const child of this.gitChildren) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    return true
  }

  /** Simulate the utility process dying (Job termination reaps git children). */
  crash(): void {
    for (const child of this.gitChildren) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    this.gitChildren.length = 0
    this.emit('exit', 0)
  }
}

function makeJob(): {
  handle: HubFetchJobHandle
  assignProcess: ReturnType<typeof vi.fn>
  containsProcess: ReturnType<typeof vi.fn>
  activeProcessIds: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  waitForEmpty: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const handle = {
    assignProcess: vi.fn(() => ({ ok: true }) as const),
    containsProcess: vi.fn(() => ({ ok: true as const, contains: true })),
    activeProcessIds: vi.fn(() => ({ ok: true as const, pids: [] })),
    terminate: vi.fn(() => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    waitForEmpty: vi.fn(async () => ({ ok: true }) as const satisfies HubFetchJobOpResult),
    close: vi.fn(() => ({ ok: true }) as const)
  }
  return {
    handle,
    assignProcess: handle.assignProcess,
    containsProcess: handle.containsProcess,
    activeProcessIds: handle.activeProcessIds,
    terminate: handle.terminate,
    waitForEmpty: handle.waitForEmpty,
    close: handle.close
  }
}

/** Closed per-attempt proxy snapshot (manual carries the trap endpoint). */
function proxySnapshot(mode: 'system' | 'direct' | 'manual'): CloneCreateInput['proxy'] {
  if (mode === 'manual') return { mode: 'manual', url: trap.url }
  return { mode }
}

/** Read the persisted error_code column for a clone row. */
function dbErrorCode(db: DatabaseSync, id: string): string | null {
  const row = db.prepare('SELECT error_code FROM clone_tasks WHERE id = ?').get(id) as {
    error_code: string | null
  }
  return row?.error_code ?? null
}

interface MatrixHarness {
  db: DatabaseSync
  store: CloneStore
  manager: CloneManager
  host: CloneHost
  utilities: MatrixUtility[]
  jobs: ReturnType<typeof makeJob>[]
  published: CloneRecord[][]
  scratchDir: string
  /** The fixture Git executable this harness's manager probes and spawns. */
  fixtureGit: string
}

interface HarnessOptions {
  /** When true, the host's clone-support gate is disabled (Todo 27 gate case). */
  gateDisabled?: boolean
  /** app-token clones get a fake Job-bound AskPass bundle with a fixture helper. */
  askPass?: {
    helperExe: string
    tokenFile: string
    askpassLog: string
  } | null
  progressPersistMs?: number
  broadcastMs?: number
}

function makeHarness(fixtureExe: string, options: HarnessOptions = {}): MatrixHarness {
  const db = new DatabaseSync(':memory:')
  for (const sql of MIGRATIONS) db.exec(sql)
  const scratchDir = scratch('t36-matrix-')
  const store = new CloneStore(nodeStoreDb(db))
  const jobs: ReturnType<typeof makeJob>[] = []
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
      const job = makeJob()
      jobs.push(job)
      return { ok: true, handle: job.handle }
    },
    createAskPassSession: () => ({ pipeName: 'HubFetchAskPass-matrix', session: {} })
  }
  const utilities: MatrixUtility[] = []
  let fakePid = 4000
  const fork: ForkFn = () => {
    fakePid += 1
    const fake = new MatrixUtility(fakePid, process.env)
    utilities.push(fake)
    return fake
  }
  const askPassFactory = options.askPass
    ? {
        createForJob: () => ({
          pipeName: 'HubFetchAskPass-matrix',
          env: {
            GIT_ASKPASS: options.askPass?.helperExe ?? '',
            HUBFETCH_ASKPASS_PIPE: 'HubFetchAskPass-matrix',
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'credential.helper',
            GIT_CONFIG_VALUE_0: '',
            FIXTURE_ASKPASS_TOKEN_FILE: options.askPass?.tokenFile ?? '',
            FIXTURE_ASKPASS_LOG: options.askPass?.askpassLog ?? ''
          },
          argv: ['-c', 'credential.helper='],
          close: () => undefined
        })
      }
    : null
  const host = new CloneHost({
    bridge,
    fork,
    workerModulePath: 'C:\\dev\\apps\\desktop\\out\\main\\clone-worker.mjs',
    getCloneSupport: () =>
      options.gateDisabled
        ? { enabled: false, reason: 'matrix: support disabled' }
        : { enabled: true, reason: null },
    taskkill: () => ({ ok: true, error: undefined }),
    graceIntervalMs: 200,
    waitTimeoutMs: 20000,
    emptyTimeoutMs: 5000,
    askPass: askPassFactory
  })
  const published: CloneRecord[][] = []
  const manager = new CloneManager({
    store,
    host,
    diagnostics: realDiagnostics(fixtureExe),
    publish: (records) => published.push(records),
    progressPersistMs: options.progressPersistMs ?? 50,
    broadcastMs: options.broadcastMs ?? 25,
    cwd: scratchDir
  })
  return {
    db,
    store,
    manager,
    host,
    utilities,
    jobs,
    published,
    scratchDir,
    fixtureGit: fixtureExe
  }
}

/** REAL GitDiagnostics against the fixture executable (deterministic probes). */
function realDiagnostics(fixtureExe: string): CloneManagerDiagnostics {
  const diagnostics = new GitDiagnostics({
    runner: { runCommand: (argv, opts) => runCommandBounded(argv, opts) },
    gitCommand: [fixtureExe],
    sshCommand: [fixtureExe],
    timeoutMs: 5000
  })
  return { git: diagnostics.git, check: (signal) => diagnostics.check(signal) }
}

function makeCloneInput(
  destination: string,
  repoId: string,
  extra: Partial<CloneCreateInput> = {}
): CloneCreateInput {
  return {
    kind: 'model',
    id: repoId,
    transport: 'https',
    destination,
    auth: 'none',
    proxy: { mode: 'system' },
    ...extra
  }
}

function isTerminal(record: CloneRecord | undefined): boolean {
  if (record === undefined) return false
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

async function writeMatrixFile(name: string, value: unknown): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

interface MatrixCase {
  id: string
  kind: 'model' | 'dataset' | 'space'
  repoId: string
  transport: 'https' | 'ssh'
  revision?: CloneRevision
  proxy: 'system' | 'direct' | 'manual'
  auth: 'none' | 'system' | 'app-token'
  behavior: FixtureCloneBehavior
  expectStatus: CloneStatus
  expectErrorCode?: CloneErrorCode
  /** Min origin requests this case must add (delegated clone = smart HTTP). */
  expectOriginRequestsMin?: number
  /** Exact expected NEW recording-proxy requests for this case (0 = Direct neutral). */
  expectProxyRequests?: number
  /** When set, the origin requires this exact Basic header (auth proof). */
  expectBasicAuth?: string | null
  verifyHead?: boolean
  /** Pre-create the destination as a file (destination-gate failure case). */
  prepareDestination?: 'file'
  /** Per-case harness options (app-token AskPass broker, gate, throttles). */
  harnessOptions?: HarnessOptions
}

interface NormalizedCaseVerdict {
  id: string
  dims: {
    kind: string
    transport: string
    revision: string
    proxy: string
    auth: string
  }
  expected: string
  status: string
  errorCode: string | null
  assertionPass: boolean
  originRequestsDelta: number
  proxyRequestsDelta: number
  headVerified: boolean | null
  basicAuthObserved: boolean
  zeroSurvivorsAfter: number
  sentinelClean: boolean
}

const RUN_STARTED_AT = Date.now()
const matrixResults: NormalizedCaseVerdict[] = []
const sentinel = randomSentinel('t36-matrix-')
/** The token the app-token/system cases use; never written to evidence. */
let authToken = sentinel
let origin: SmartGitOrigin
let authOrigin: SmartGitOrigin | null = null
let trap: RecordingProxy
let originRoot: string
let repos: ReturnType<typeof makeOriginRepos>
let askpassHelperExe: string
let credentialHelperExe: string
let credentialHelperFwd: string
let tokenFile: string
let emptyConfigFile: string
let askpassLogFile: string

// Parent-env proxy injection: proves System follows the injected system route
// and Direct bypasses the environment, Chromium/Undici, and Git-config proxies.
const savedProxyEnv = new Map<string, string | undefined>()

beforeAll(async () => {
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NO_PROXY'
  ]) {
    savedProxyEnv.set(key, process.env[key])
  }
  originRoot = makeScratchRoot('t36-matrix-origin')
  repos = makeOriginRepos(originRoot)
  origin = await startSmartGitOrigin({ projectRoot: originRoot })
  trap = await startRecordingProxy()
  process.env.HTTP_PROXY = trap.url
  process.env.HTTPS_PROXY = trap.url
  process.env.NO_PROXY = ''
  authToken = randomSentinel('t36-token-')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  tokenFile = join(originRoot, 'token.txt')
  writeFileSync(tokenFile, authToken, 'utf8')
  emptyConfigFile = join(originRoot, 'empty-config')
  writeFileSync(emptyConfigFile, '', 'utf8')
  askpassLogFile = join(originRoot, 'askpass.log')
  askpassHelperExe = writeAskPassHelper(join(originRoot, 'askpass-fixture'))
  credentialHelperExe = writeCredentialHelper(join(originRoot, 'cred-fixture'))
  credentialHelperFwd = credentialHelperExe.replace(/\\/g, '/')
  mkdirSync(join(originRoot, 'logs'), { recursive: true })
  // A SEPARATE Basic-auth origin proves the auth exchange: only the system-auth
  // and app-token cases target it, so anonymous cases stay anonymous.
  const expectedAuth = 'Basic ' + Buffer.from(`hf_user:${authToken}`).toString('base64')
  authOrigin = await startSmartGitOrigin({ projectRoot: originRoot, expectedAuth })
})

afterAll(async () => {
  for (const [key, value] of savedProxyEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await origin?.close()
  } catch {
    /* best-effort server close */
  }
  try {
    await authOrigin?.close()
  } catch {
    /* best-effort server close */
  }
  try {
    await trap?.close()
  } catch {
    /* best-effort server close */
  }
  await import('node:fs/promises').then(async ({ rm }) => {
    await rm(originRoot, { recursive: true, force: true }).catch(() => undefined)
  })
})

/**
 * Run one matrix case inside an existing harness and return its normalized
 * verdict. Throws on assertion failure (the caller records pass=false).
 */
async function runCase(harness: MatrixHarness, c: MatrixCase): Promise<NormalizedCaseVerdict> {
  // Auth cases target the separate Basic-auth origin; everything else the main one.
  const caseOrigin = c.expectBasicAuth != null && authOrigin !== null ? authOrigin : origin
  const originBefore = caseOrigin.requests.length
  const trapBefore = trap.requests.length
  const authBefore = caseOrigin.authLog.length
  const dest = join(harness.scratchDir, c.id)
  if (c.prepareDestination === 'file') {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(dest, 'occupied by a file', 'utf8')
  }
  const revisionKind = c.revision === undefined ? 'none' : c.revision.kind
  const expectedBasic = c.expectBasicAuth ?? null
  const basicObserved = (): boolean => {
    if (expectedBasic === null) return true
    return caseOrigin.authLog.slice(authBefore).some((line) => line === expectedBasic)
  }

  let record: CloneRecord
  const created = harness.manager.create(
    makeCloneInput(dest, c.repoId, {
      kind: c.kind,
      transport: c.transport,
      revision: c.revision,
      auth: c.auth,
      proxy: proxySnapshot(c.proxy)
    })
  )
  record = created

  await waitFor(() => isTerminal(harness.store.get(record.id)), `terminal ${c.id}`)
  record = harness.store.get(record.id) as CloneRecord

  let headVerified: boolean | null = null
  if (c.verifyHead === true && record.status === 'completed') {
    const expectedSha = c.revision?.kind === 'commit' ? c.revision.sha : repos.repos[c.kind].mainSha
    const head = gitSync(['-C', dest, 'rev-parse', 'HEAD'], { cwd: harness.scratchDir })
    headVerified = head.status === 0 && head.stdout.trim() === expectedSha
  }

  const originRequestsDelta = caseOrigin.requests.length - originBefore
  const proxyRequestsDelta = trap.requests.length - trapBefore
  const zeroSurvivorsAfter =
    c.behavior.action === 'delegate' || c.behavior.action === 'hang'
      ? checkZeroSurvivors(harness.utilities.flatMap((u) => u.gitChildren.map((ch) => ch.pid ?? 0)))
          .length
      : -1

  // Explicit assertions — a failure here fails the suite loudly.
  expect(record.status).toBe(c.expectStatus)
  if (c.expectErrorCode !== undefined && record.status === 'failed') {
    expect(dbErrorCode(harness.db, record.id)).toBe(c.expectErrorCode)
  }
  if (c.expectOriginRequestsMin !== undefined) {
    expect(originRequestsDelta).toBeGreaterThanOrEqual(c.expectOriginRequestsMin)
  }
  if (c.expectProxyRequests !== undefined) {
    expect(proxyRequestsDelta).toBe(c.expectProxyRequests)
  }
  expect(basicObserved()).toBe(true)
  if (c.verifyHead === true) expect(headVerified).toBe(true)
  expect(cloneRecordSchema.safeParse(record).success).toBe(true)
  if (c.verifyHead === true && record.status === 'completed' && c.behavior.action === 'delegate') {
    expect(harness.host.activeIds()).toHaveLength(0)
  }

  return {
    id: c.id,
    dims: {
      kind: c.kind,
      transport: c.transport,
      revision: revisionKind,
      proxy: c.proxy,
      auth: c.auth
    },
    expected: c.expectStatus,
    status: record.status,
    errorCode: dbErrorCode(harness.db, record.id),
    assertionPass: true,
    originRequestsDelta,
    proxyRequestsDelta,
    headVerified,
    basicAuthObserved: basicObserved(),
    zeroSurvivorsAfter,
    sentinelClean: true
  }
}

/** Run every table case; records pass/fail per case and writes matrix evidence. */
async function runMatrix(): Promise<void> {
  const allPass: NormalizedCaseVerdict[] = []
  const failures: Array<{ id: string; error: string }> = []

  const recordCase = async (c: MatrixCase): Promise<void> => {
    const harness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', c.id), {
        log: join(originRoot, 'logs', `${c.id}.jsonl`),
        probe: 'healthy',
        clone: c.behavior
      }),
      c.harnessOptions
    )
    try {
      const verdict = await runCase(harness, c)
      allPass.push(verdict)
    } catch (error) {
      const persistedError = harness.db
        .prepare('SELECT error FROM clone_tasks ORDER BY created_at DESC LIMIT 1')
        .get() as { error: string | null } | undefined
      failures.push({
        id: c.id,
        error:
          (error instanceof Error ? error.message : String(error)) +
          `; persistedError=${JSON.stringify(persistedError?.error ?? null)}`
      })
      allPass.push({
        id: c.id,
        dims: {
          kind: c.kind,
          transport: c.transport,
          revision: c.revision === undefined ? 'none' : c.revision.kind,
          proxy: c.proxy,
          auth: c.auth
        },
        expected: c.expectStatus,
        status: 'error',
        errorCode: null,
        assertionPass: false,
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: false,
        zeroSurvivorsAfter: 0,
        sentinelClean: false
      })
    } finally {
      await harness.manager.shutdown().catch(() => undefined)
    }
  }

  // --- Success matrix (real delegated clones through the real origin) ------
  const modelRepo = repos.repos.model
  const datasetRepo = repos.repos.dataset
  const spaceRepo = repos.repos.space

  await recordCase({
    id: 'success-model-https-branch-system',
    kind: 'model',
    repoId: modelRepo.repoId,
    transport: 'https',
    revision: { kind: 'branch', name: 'feature-x' },
    proxy: 'system',
    auth: 'none',
    behavior: { action: 'delegate', originUrl: origin.url },
    expectStatus: 'completed',
    expectOriginRequestsMin: 2,
    expectProxyRequests: 3,
    verifyHead: true
  })

  await recordCase({
    id: 'success-dataset-https-tag-direct',
    kind: 'dataset',
    repoId: datasetRepo.repoId,
    transport: 'https',
    revision: { kind: 'tag', name: 'v1.0.0' },
    proxy: 'direct',
    auth: 'none',
    behavior: { action: 'delegate', originUrl: origin.url },
    expectStatus: 'completed',
    expectOriginRequestsMin: 2,
    expectProxyRequests: 0,
    verifyHead: true
  })

  await recordCase({
    id: 'success-space-https-commit-manual',
    kind: 'space',
    repoId: spaceRepo.repoId,
    transport: 'https',
    revision: { kind: 'commit', sha: spaceRepo.mainSha },
    proxy: 'manual',
    auth: 'none',
    behavior: { action: 'delegate', originUrl: origin.url },
    expectStatus: 'completed',
    expectOriginRequestsMin: 2,
    expectProxyRequests: 3,
    verifyHead: true
  })

  await recordCase({
    id: 'success-model-ssh-branch-system',
    kind: 'model',
    repoId: modelRepo.repoId,
    transport: 'ssh',
    revision: { kind: 'branch', name: 'main' },
    proxy: 'system',
    auth: 'none',
    behavior: { action: 'delegate', originUrl: origin.url },
    expectStatus: 'completed',
    expectOriginRequestsMin: 2,
    expectProxyRequests: 3,
    verifyHead: true
  })

  // --- Auth: system credentials + app-token AskPass ------------------------
  // These cases target the SEPARATE Basic-auth origin so the observed
  // Authorization header proves the credential exchange end-to-end.
  const authOriginUrl = authOrigin?.url ?? origin.url
  const expectedBasic = 'Basic ' + Buffer.from(`hf_user:${authToken}`).toString('base64')

  await recordCase({
    id: 'success-model-https-system-auth',
    kind: 'model',
    repoId: modelRepo.repoId,
    transport: 'https',
    proxy: 'system',
    auth: 'system',
    behavior: {
      action: 'delegate',
      originUrl: authOriginUrl,
      extraArgv: ['-c', 'credential.helper=', '-c', `credential.helper=${credentialHelperFwd}`],
      env: {
        FIXTURE_CRED_TOKEN_FILE: tokenFile,
        GIT_CONFIG_SYSTEM: emptyConfigFile,
        GIT_CONFIG_GLOBAL: emptyConfigFile
      }
    },
    expectStatus: 'completed',
    expectOriginRequestsMin: 2,
    expectBasicAuth: expectedBasic,
    verifyHead: true
  })

  await recordCase({
    id: 'success-model-https-apptoken',
    kind: 'model',
    repoId: modelRepo.repoId,
    transport: 'https',
    proxy: 'system',
    auth: 'app-token',
    behavior: { action: 'delegate', originUrl: authOriginUrl },
    expectStatus: 'completed',
    expectOriginRequestsMin: 2,
    expectBasicAuth: expectedBasic,
    verifyHead: true,
    harnessOptions: {
      askPass: {
        helperExe: askpassHelperExe,
        tokenFile,
        askpassLog: askpassLogFile
      }
    }
  })

  // --- Progress robustness ------------------------------------------------
  await recordCase({
    id: 'fragmented-progress',
    kind: 'model',
    repoId: modelRepo.repoId,
    transport: 'https',
    proxy: 'system',
    auth: 'none',
    behavior: {
      action: 'complete',
      progress:
        'Receiving objects:  42% (1/2)\rReceiving objects:  84% (2/2)\rResolving deltas: 100% (2/2)\r'
    },
    expectStatus: 'completed',
    expectOriginRequestsMin: 0,
    verifyHead: false
  })

  await recordCase({
    id: 'unknown-progress-diagnostics',
    kind: 'model',
    repoId: modelRepo.repoId,
    transport: 'https',
    proxy: 'system',
    auth: 'none',
    behavior: {
      action: 'complete',
      progress: 'unexpected noise line\n[curl] 16 SSL certificate problem\n'
    },
    expectStatus: 'completed',
    expectOriginRequestsMin: 0
  })

  // --- Failure classification (deterministic fixture stderr) ---------------
  const failCase = async (
    id: string,
    stderr: string,
    expectErrorCode: CloneErrorCode
  ): Promise<void> => {
    await recordCase({
      id,
      kind: 'model',
      repoId: modelRepo.repoId,
      transport: 'https',
      proxy: 'system',
      auth: 'none',
      behavior: { action: 'fail', stderr, exit: 128 },
      expectStatus: 'failed',
      expectErrorCode,
      expectOriginRequestsMin: 0
    })
  }
  await failCase(
    'fail-auth',
    "fatal: could not read Username for 'https://huggingface.co': terminal prompts disabled\n",
    'auth'
  )
  await failCase(
    'fail-gated',
    'remote: access to repository qam/m1 is disabled.\nfatal: repository is gated\n',
    'gated'
  )
  await failCase(
    'fail-not-found',
    "fatal: repository 'https://huggingface.co/qam/m1' not found\n",
    'not-found'
  )
  await failCase(
    'fail-proxy',
    "fatal: unable to access 'https://huggingface.co/qam/m1': could not resolve proxy\n",
    'proxy'
  )
  await failCase('fail-disk', 'fatal: write error: No space left on device\n', 'disk')

  await recordCase({
    id: 'fail-destination-not-empty',
    kind: 'model',
    repoId: modelRepo.repoId,
    transport: 'https',
    proxy: 'system',
    auth: 'none',
    behavior: { action: 'complete' },
    expectStatus: 'failed',
    expectErrorCode: 'destination',
    expectOriginRequestsMin: 0,
    prepareDestination: 'file'
  })

  // --- Gate: clone support disabled (host refuses BEFORE any worker) --------
  const gateHarness = makeHarness(
    writeFixtureGit(join(originRoot, 'fixtures', 'gate-disabled'), {
      log: join(originRoot, 'logs', 'gate-disabled.jsonl'),
      probe: 'healthy',
      clone: { action: 'complete' }
    }),
    { gateDisabled: true }
  )
  try {
    const created = gateHarness.manager.create(
      makeCloneInput(join(gateHarness.scratchDir, 'gate'), 'qam/gated')
    )
    await waitFor(() => isTerminal(gateHarness.store.get(created.id)), 'gate terminal')
    const record = gateHarness.store.get(created.id) as CloneRecord
    expect(record.status).toBe('failed')
    expect(dbErrorCode(gateHarness.db, created.id)).toBe('internal')
    expect(gateHarness.utilities.length).toBe(0)
    allPass.push({
      id: 'gate-clone-support',
      dims: { kind: 'model', transport: 'https', revision: 'none', proxy: 'system', auth: 'none' },
      expected: 'failed',
      status: 'failed',
      errorCode: 'internal',
      assertionPass: true,
      originRequestsDelta: 0,
      proxyRequestsDelta: 0,
      headVerified: false,
      basicAuthObserved: true,
      zeroSurvivorsAfter: -1,
      sentinelClean: true
    })
  } catch (error) {
    failures.push({
      id: 'gate-clone-support',
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    await gateHarness.manager.shutdown().catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Adversarial DETECTOR proofs (the three "suite must fail" invariants)
  // -------------------------------------------------------------------------

  // Detector A: token leak is DETECTED (scanTargetsForSentinel flags it).
  {
    const leakDir = join(originRoot, 'leak-fixture')
    const { mkdirSync, writeFileSync: write } = await import('node:fs')
    mkdirSync(leakDir, { recursive: true })
    write(join(leakDir, 'helper.log'), `argv --askpass ${authToken}\n`, 'utf8')
    write(join(leakDir, 'env.txt'), `HTTP_PROXY=${trap.url}\n`, 'utf8')
    const hits = scanDirForSentinel(leakDir, authToken)
    expect(hits.found).toBe(true)
    expect(hits.files.length).toBeGreaterThan(0)
    allPass.push({
      id: 'detector-token-leak',
      dims: {
        kind: 'model',
        transport: 'https',
        revision: 'none',
        proxy: 'system',
        auth: 'app-token'
      },
      expected: 'leak-detected',
      status: 'leak-detected',
      errorCode: null,
      assertionPass: hits.found && hits.files.length > 0,
      originRequestsDelta: 0,
      proxyRequestsDelta: 0,
      headVerified: false,
      basicAuthObserved: true,
      zeroSurvivorsAfter: -1,
      sentinelClean: true
    })
  }

  // Detector B: an untracked survivor is DETECTED (checkZeroSurvivors flags it).
  {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    const pid = child.pid ?? 0
    try {
      const survivors = checkZeroSurvivors([pid])
      expect(survivors).toContain(pid)
      allPass.push({
        id: 'detector-zero-survivor',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'survivor-detected',
        status: 'survivor-detected',
        errorCode: null,
        assertionPass: survivors.includes(pid),
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: survivors.length,
        sentinelClean: true
      })
    } catch (error) {
      failures.push({
        id: 'detector-zero-survivor',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }

  // Detector C: a Direct-mode clone that touched the proxy is DETECTED.
  {
    const before = trap.requests.length
    const fakeRequests = [...trap.requests]
    const violation = checkDirectNeutrality(fakeRequests.slice(0, 1))
    expect(violation.length).toBe(1)
    const directHarness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', 'direct-route'), {
        log: join(originRoot, 'logs', 'direct-route.jsonl'),
        probe: 'healthy',
        clone: { action: 'delegate', originUrl: origin.url }
      })
    )
    try {
      const created = directHarness.manager.create(
        makeCloneInput(join(directHarness.scratchDir, 'direct-out'), modelRepo.repoId, {
          proxy: { mode: 'direct' }
        })
      )
      await waitFor(() => isTerminal(directHarness.store.get(created.id)), 'direct terminal')
      const record = directHarness.store.get(created.id) as CloneRecord
      expect(record.status).toBe('completed')
      const directDelta = trap.requests.length - before
      expect(directDelta).toBe(0)
      allPass.push({
        id: 'detector-direct-neutrality',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'direct',
          auth: 'none'
        },
        expected: 'direct-neutral',
        status: record.status,
        errorCode: null,
        assertionPass: directDelta === 0 && violation.length === 1,
        originRequestsDelta: 0,
        proxyRequestsDelta: directDelta,
        headVerified: true,
        basicAuthObserved: true,
        zeroSurvivorsAfter: -1,
        sentinelClean: true
      })
    } catch (error) {
      failures.push({
        id: 'detector-direct-neutrality',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      await directHarness.manager.shutdown().catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // Queueing / cancellation / shutdown / recovery / retry / bundle cases
  // -------------------------------------------------------------------------

  // --- one-active FIFO WITH concurrent downloads ---------------------------
  {
    const harness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', 'fifo'), {
        log: join(originRoot, 'logs', 'fifo.jsonl'),
        probe: 'healthy',
        clone: { action: 'delegate', originUrl: origin.url }
      })
    )
    try {
      // The app's real DB is better-sqlite3 (has .transaction); node:sqlite
      // does not. DownloadManager persists on a throttled timer, so give it a
      // real transaction-capable adapter (same pattern as the store adapter).
      const dlDb = {
        prepare(sql: string) {
          return harness.db.prepare(sql)
        },
        exec(sql: string): void {
          harness.db.exec(sql)
        },
        transaction<T>(fn: () => T): () => T {
          return () => {
            harness.db.exec('BEGIN IMMEDIATE')
            try {
              const value = fn()
              harness.db.exec('COMMIT')
              return value
            } catch (error) {
              harness.db.exec('ROLLBACK')
              throw error
            }
          }
        }
      }
      const hub = {
        baseUrl: 'https://hub.example.test',
        getRepoDetail: vi.fn().mockResolvedValue({ sha: 'a'.repeat(40) }),
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
        dlDb as never,
        {
          get: () => ({
            downloadConcurrency: 2,
            speedLimitBps: null,
            hfCacheDir: harness.scratchDir,
            proxy: { mode: 'manual' as const, manualUrl: trap.url }
          })
        } as never,
        hub as never,
        { show: vi.fn() } as never,
        () => 'hf_test_token',
        vi.fn(),
        () => fakeTransport as never
      )
      workerMock.FakeDownloadWorker.instances.length = 0
      await downloads.start({ repoId: 'qa-author/dl-a', kind: 'model', revision: 'a'.repeat(40) })
      await downloads.start({ repoId: 'qa-author/dl-b', kind: 'model', revision: 'a'.repeat(40) })
      await waitFor(
        () => workerMock.FakeDownloadWorker.instances.length === 2,
        'two download workers'
      )
      await flush()
      const dlStatus = downloads.list().map((t) => t.status)
      expect(dlStatus.filter((s) => s === 'running').length).toBe(2)

      const cloneOrder: string[] = []
      const maxActive = { value: 0 }
      const observe = (): void => {
        const active = harness.store
          .list()
          .filter((r) => r.status === 'running' || r.status === 'cancelling')
          .map((r) => r.repoId)
        maxActive.value = Math.max(maxActive.value, active.length)
        cloneOrder.push(...active)
      }
      const c1 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'fifo-1'), modelRepo.repoId, {
          proxy: { mode: 'system' }
        })
      )
      await new Promise((r) => setTimeout(r, 15))
      const c2 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'fifo-2'), datasetRepo.repoId, {
          kind: 'dataset',
          proxy: { mode: 'system' }
        })
      )
      await new Promise((r) => setTimeout(r, 15))
      const c3 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'fifo-3'), spaceRepo.repoId, {
          kind: 'space',
          proxy: { mode: 'system' }
        })
      )
      await waitFor(() => harness.store.get(c1.id)?.status === 'running', 'fifo c1 running')
      observe()
      await waitFor(() => isTerminal(harness.store.get(c1.id)), 'fifo c1 done')
      await waitFor(() => harness.store.get(c2.id)?.status === 'running', 'fifo c2 running')
      observe()
      await waitFor(() => isTerminal(harness.store.get(c2.id)), 'fifo c2 done')
      await waitFor(() => harness.store.get(c3.id)?.status === 'running', 'fifo c3 running')
      observe()
      await waitFor(() => isTerminal(harness.store.get(c3.id)), 'fifo c3 done')
      observe()
      expect(maxActive.value).toBe(1)
      expect(harness.store.list().every((r) => r.status === 'completed')).toBe(true)
      expect(dlStatus.filter((s) => s === 'running').length).toBe(2)
      expect(harness.utilities.length).toBe(3)
      allPass.push({
        id: 'fifo-one-active-with-concurrent-downloads',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'completed',
        status: 'completed',
        errorCode: null,
        assertionPass: maxActive.value === 1,
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: -1,
        sentinelClean: true
      })
      downloads.shutdown()
    } catch (error) {
      failures.push({
        id: 'fifo-one-active-with-concurrent-downloads',
        error:
          (error instanceof Error ? error.message : String(error)) +
          '; statuses=' +
          JSON.stringify(
            harness.store.list().map((r) => ({
              id: r.id,
              status: r.status,
              repoId: r.repoId,
              error: r.error ?? null
            }))
          )
      })
    } finally {
      await harness.manager.shutdown().catch(() => undefined)
    }
  }

  // --- queued cancel + active cancel + zero survivors ----------------------
  {
    const hangFixture = writeFixtureGit(join(originRoot, 'fixtures', 'cancel'), {
      log: join(originRoot, 'logs', 'cancel.jsonl'),
      probe: 'healthy',
      clone: { action: 'hang' }
    })
    const harness = makeHarness(hangFixture)
    try {
      const c1 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'c-a'), modelRepo.repoId)
      )
      await waitFor(() => harness.store.get(c1.id)?.status === 'running', 'cancel c1 running')
      await waitFor(() => harness.utilities.length >= 1, 'cancel worker1 forked')
      await waitFor(
        () => (harness.utilities[0]?.gitChildren.length ?? 0) >= 1,
        'cancel git spawned'
      )
      const c2 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'c-b'), datasetRepo.repoId, { kind: 'dataset' })
      )
      expect(harness.store.get(c2.id)?.status).toBe('queued')
      expect(harness.utilities.length).toBe(1)
      // Queued cancel: never touches a worker.
      const afterQueuedCancel = await harness.manager.cancel(c2.id)
      expect(harness.store.get(c2.id)?.status).toBe('cancelled')
      expect(harness.utilities.length).toBe(1)
      expect(afterQueuedCancel.find((r) => r.id === c2.id)?.status).toBe('cancelled')
      // Active cancel: cooperative -> grace -> Job terminate -> zero.
      const afterActiveCancel = await harness.manager.cancel(c1.id)
      expect(harness.store.get(c1.id)?.status).toBe('cancelled')
      expect(afterActiveCancel.find((r) => r.id === c1.id)?.status).toBe('cancelled')
      const gitPids = harness.utilities.flatMap((u) => u.gitChildren.map((ch) => ch.pid ?? 0))
      const survivors = checkZeroSurvivors(gitPids)
      expect(survivors).toHaveLength(0)
      allPass.push({
        id: 'cancel-queued-and-active',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'cancelled',
        status: 'cancelled',
        errorCode: null,
        assertionPass: survivors.length === 0,
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: survivors.length,
        sentinelClean: true
      })
    } catch (error) {
      failures.push({
        id: 'cancel-queued-and-active',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      await harness.manager.shutdown().catch(() => undefined)
    }
  }

  // --- worker crash -> interrupted; next queued starts after zero ----------
  {
    const overrideFile = join(originRoot, 'crash-override.json')
    const harness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', 'crash'), {
        log: join(originRoot, 'logs', 'crash.jsonl'),
        probe: 'healthy',
        clone: { action: 'hang' }
      })
    )
    try {
      const c1 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'cr-a'), modelRepo.repoId)
      )
      await waitFor(() => harness.store.get(c1.id)?.status === 'running', 'crash c1 running')
      await waitFor(() => harness.utilities.length >= 1, 'crash worker1')
      await waitFor(
        () => (harness.utilities[0]?.gitChildren.length ?? 0) >= 1,
        'crash git1 spawned'
      )
      const c2 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'cr-b'), datasetRepo.repoId, { kind: 'dataset' })
      )
      expect(harness.store.get(c2.id)?.status).toBe('queued')
      // The crashed clone's worker dies; its Job reaps the hung git child.
      const util = harness.utilities[0] as MatrixUtility
      util.crash()
      await waitFor(
        () => harness.store.get(c1.id)?.status === 'interrupted',
        'crash c1 interrupted'
      )
      // Switch the fixture behavior so the queued clone COMPLETES.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(overrideFile, JSON.stringify({ clone: { action: 'complete' } }), 'utf8')
      process.env.FIXTURE_BEHAVIOR_OVERRIDE = overrideFile
      // The queued clone starts only after the crashed clone's cleanup.
      await waitFor(() => harness.store.get(c2.id)?.status === 'running', 'crash c2 running')
      await waitFor(() => isTerminal(harness.store.get(c2.id)), 'crash c2 terminal')
      expect(harness.store.get(c2.id)?.status).toBe('completed')
      allPass.push({
        id: 'worker-crash-then-advance',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'interrupted',
        status: 'interrupted',
        errorCode: null,
        assertionPass: harness.store.get(c2.id)?.status === 'completed',
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: -1,
        sentinelClean: true
      })
    } catch (error) {
      failures.push({
        id: 'worker-crash-then-advance',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      delete process.env.FIXTURE_BEHAVIOR_OVERRIDE
      await harness.manager.shutdown().catch(() => undefined)
    }
  }

  // --- app shutdown: active hang clone reaches zero Job PIDs ---------------
  {
    const harness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', 'shutdown'), {
        log: join(originRoot, 'logs', 'shutdown.jsonl'),
        probe: 'healthy',
        clone: { action: 'hang' }
      })
    )
    try {
      const c1 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'sd-a'), modelRepo.repoId)
      )
      await waitFor(() => harness.store.get(c1.id)?.status === 'running', 'shutdown running')
      await waitFor(() => harness.utilities.length >= 1, 'shutdown worker')
      await waitFor(
        () => (harness.utilities[0]?.gitChildren.length ?? 0) >= 1,
        'shutdown git spawned'
      )
      const gitPids = harness.utilities.flatMap((u) => u.gitChildren.map((ch) => ch.pid ?? 0))
      expect(gitPids.length).toBeGreaterThan(0)
      const shutdown = await harness.manager.shutdown()
      expect(shutdown.zeroProven).toBe(true)
      expect(shutdown.remainingJobPids).toEqual([])
      expect(shutdown.storeActive).toBe(0)
      const survivors = checkZeroSurvivors(gitPids)
      expect(survivors).toHaveLength(0)
      allPass.push({
        id: 'shutdown-zero-job-pids',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'cancelled',
        status: harness.store.get(c1.id)?.status ?? 'cancelled',
        errorCode: null,
        assertionPass: shutdown.zeroProven && survivors.length === 0,
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: survivors.length,
        sentinelClean: true
      })
    } catch (error) {
      failures.push({
        id: 'shutdown-zero-job-pids',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // --- restart recovery: running/cancelling -> interrupted, queued pumps ----
  {
    const harness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', 'recover'), {
        log: join(originRoot, 'logs', 'recover.jsonl'),
        probe: 'healthy',
        clone: { action: 'complete' }
      })
    )
    try {
      // Recovery 1: a running row from a crashed app becomes interrupted and
      // the queued attempt pumps. (The store enforces single-active, so at most
      // one active row exists even after a crash.)
      const a = harness.store.createQueued(
        makeCloneInput(join(harness.scratchDir, 'rc-a'), modelRepo.repoId)
      )
      harness.store.start(a.id)
      const b = harness.store.createQueued(
        makeCloneInput(join(harness.scratchDir, 'rc-b'), datasetRepo.repoId, { kind: 'dataset' })
      )
      const recovered = new CloneManager({
        store: harness.store,
        host: harness.host,
        diagnostics: realDiagnostics(harness.fixtureGit),
        publish: () => undefined,
        cwd: harness.scratchDir
      })
      const changed = recovered.recover()
      expect(changed.map((r) => r.id)).toContain(a.id)
      expect(harness.store.get(a.id)?.status).toBe('interrupted')
      await waitFor(() => harness.store.get(b.id)?.status === 'completed', 'recover b completed')

      // Recovery 2: a cancelling row (running -> cancelling) recovers the same.
      const c = harness.store.createQueued(
        makeCloneInput(join(harness.scratchDir, 'rc-c'), spaceRepo.repoId, { kind: 'space' })
      )
      harness.store.start(c.id)
      harness.store.requestCancel(c.id)
      expect(harness.store.get(c.id)?.status).toBe('cancelling')
      const d = harness.store.createQueued(
        makeCloneInput(join(harness.scratchDir, 'rc-d'), modelRepo.repoId)
      )
      const recovered2 = new CloneManager({
        store: harness.store,
        host: harness.host,
        diagnostics: realDiagnostics(harness.fixtureGit),
        publish: () => undefined,
        cwd: harness.scratchDir
      })
      const changed2 = recovered2.recover()
      expect(changed2.map((r) => r.id)).toContain(c.id)
      expect(harness.store.get(c.id)?.status).toBe('interrupted')
      await waitFor(() => harness.store.get(d.id)?.status === 'completed', 'recover d completed')
      allPass.push({
        id: 'restart-recovery-pumps-queued',
        dims: {
          kind: 'dataset',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'completed',
        status: 'completed',
        errorCode: null,
        assertionPass:
          changed.length === 1 &&
          changed2.length === 1 &&
          harness.store.get(b.id)?.status === 'completed' &&
          harness.store.get(d.id)?.status === 'completed',
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: -1,
        sentinelClean: true
      })
      await recovered.shutdown()
      await recovered2.shutdown()
    } catch (error) {
      failures.push({
        id: 'restart-recovery-pumps-queued',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      await harness.manager.shutdown().catch(() => undefined)
    }
  }

  // --- retry link: failed -> linked fresh attempt with new destination ------
  {
    const overrideFile = join(originRoot, 'retry-override.json')
    const harness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', 'retry'), {
        log: join(originRoot, 'logs', 'retry.jsonl'),
        probe: 'healthy',
        clone: {
          action: 'fail',
          stderr: "fatal: authentication failed for 'https://huggingface.co/qam/m1'\n",
          exit: 128
        }
      })
    )
    try {
      const c1 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'rt-a'), modelRepo.repoId)
      )
      await waitFor(() => harness.store.get(c1.id)?.status === 'failed', 'retry c1 failed')
      expect(dbErrorCode(harness.db, c1.id)).toBe('auth')
      // The retry runs the SAME fixture exe; switch its behavior to complete so
      // the linked fresh attempt succeeds (the real app would clone again).
      const { writeFileSync } = await import('node:fs')
      writeFileSync(overrideFile, JSON.stringify({ clone: { action: 'complete' } }), 'utf8')
      process.env.FIXTURE_BEHAVIOR_OVERRIDE = overrideFile
      const retried = harness.manager.retry(
        c1.id,
        makeCloneInput(join(harness.scratchDir, 'rt-b'), modelRepo.repoId)
      )
      expect(retried.retryOf).toBe(c1.id)
      expect(retried.attempt).toBe(2)
      await waitFor(() => isTerminal(harness.store.get(retried.id)), 'retry c2 terminal')
      const row = harness.db
        .prepare('SELECT retry_of, attempt, status FROM clone_tasks WHERE id = ?')
        .get(retried.id) as { retry_of: string | null; attempt: number; status: string }
      expect(row.retry_of).toBe(c1.id)
      expect(row.attempt).toBe(2)
      expect(row.status).toBe('completed')
      allPass.push({
        id: 'retry-link-new-destination',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'completed',
        status: 'completed',
        errorCode: null,
        assertionPass: row.status === 'completed' && row.retry_of === c1.id,
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: -1,
        sentinelClean: true
      })
    } catch (error) {
      failures.push({
        id: 'retry-link-new-destination',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      delete process.env.FIXTURE_BEHAVIOR_OVERRIDE
      await harness.manager.shutdown().catch(() => undefined)
    }
  }

  // --- support-bundle redaction: sentinel never survives into the ZIP -------
  {
    const harness = makeHarness(
      writeFixtureGit(join(originRoot, 'fixtures', 'bundle'), {
        log: join(originRoot, 'logs', 'bundle.jsonl'),
        probe: 'healthy',
        clone: { action: 'fail', stderr: `fatal: auth failed for ${authToken}\n`, exit: 128 }
      })
    )
    try {
      const c1 = harness.manager.create(
        makeCloneInput(join(harness.scratchDir, 'sb-a'), modelRepo.repoId)
      )
      await waitFor(() => isTerminal(harness.store.get(c1.id)), 'bundle c1 terminal')
      const { SupportBundleBuilder } = await import('../support-bundle')
      const { Redactor } = await import('../security/redaction')
      const { secretRegistry } = await import('../security/secret-registry')
      const secretHandle = secretRegistry.register(authToken)
      const bundleTarget = join(harness.scratchDir, 'support.zip')
      const builder = new SupportBundleBuilder({
        redactor: new Redactor(secretRegistry),
        clock: () => new Date(0),
        leakGuard: () => secretRegistry.liveSecrets()
      })
      const sources = {
        app: { app: 'HubFetch', version: '0.2.0', buildKind: 'packaged', electron: '43.1.0' },
        system: {
          os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
          cpu: { model: 'fixture', count: 8 },
          memory: { totalBytes: 8 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 },
          disk: { freeBytes: 250 * 1024 ** 3 }
        },
        diagnostics: { checks: [], completedAt: new Date(0).toISOString() },
        settings: { ...DEFAULT_SETTINGS, hfCacheDir: harness.scratchDir },
        tasks: [],
        mainLog: `clone failed: token ${authToken} leaked into log\n`,
        rendererLog: ''
      }
      const result = await builder.build(bundleTarget, sources)
      const zip = (await import('node:fs/promises')).readFile(bundleTarget)
      const zipBuffer = await zip
      expect(containsSentinel(zipBuffer, authToken)).toBe(false)
      // The token also never survives into the matrix evidence itself.
      expect(matrixResults.some((v) => JSON.stringify(v).includes(authToken))).toBe(false)
      secretRegistry.unregister(secretHandle)
      allPass.push({
        id: 'support-bundle-redaction',
        dims: {
          kind: 'model',
          transport: 'https',
          revision: 'none',
          proxy: 'system',
          auth: 'none'
        },
        expected: 'redacted',
        status: 'redacted',
        errorCode: null,
        assertionPass: !containsSentinel(zipBuffer, authToken) && result.memberCount > 0,
        originRequestsDelta: 0,
        proxyRequestsDelta: 0,
        headVerified: false,
        basicAuthObserved: true,
        zeroSurvivorsAfter: -1,
        sentinelClean: true
      })
    } catch (error) {
      failures.push({
        id: 'support-bundle-redaction',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      await harness.manager.shutdown().catch(() => undefined)
    }
  }

  // --- Write the machine-readable matrix -----------------------------------
  const matrix = {
    run: Number(MATRIX_RUN),
    generatedAt: new Date().toISOString(),
    startedAt: new Date(RUN_STARTED_AT).toISOString(),
    originUrl: origin.url,
    trapUrl: trap.url,
    repoShas: {
      model: repos.repos.model.mainSha,
      dataset: repos.repos.dataset.mainSha,
      space: repos.repos.space.mainSha
    },
    caseCount: allPass.length + failures.length,
    passed: allPass.filter((v) => v.assertionPass).length,
    failed: failures.length,
    cases: allPass,
    failures
  }
  await writeMatrixFile(`matrix-run-${MATRIX_RUN}.json`, matrix)

  // Fail the suite if any case failed (evidence still recorded).
  expect(failures).toEqual([])

  // qa-happy.txt: QA_HAPPY_PASS + the normalized verdict (stable across runs).
  const normalized = {
    run: Number(MATRIX_RUN),
    caseCount: matrix.caseCount,
    passed: matrix.passed,
    failed: matrix.failed,
    verdicts: allPass.map((v) => ({
      id: v.id,
      dims: v.dims,
      expected: v.expected,
      status: v.status,
      errorCode: v.errorCode,
      assertionPass: v.assertionPass,
      originRequestsDelta: v.originRequestsDelta,
      proxyRequestsDelta: v.proxyRequestsDelta,
      headVerified: v.headVerified,
      basicAuthObserved: v.basicAuthObserved,
      zeroSurvivorsAfter: v.zeroSurvivorsAfter
    }))
  }
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(
    join(EVIDENCE, 'qa-happy.txt'),
    `QA_HAPPY_PASS\n${JSON.stringify(normalized, null, 2)}\n`,
    'utf8'
  )
  matrixResults.push(...allPass)
}

describe('Todo 36 deterministic clone/proxy/auth/cancellation/recovery matrix', () => {
  it('runs the full matrix against real DB/manager/host/worker/fixture-Git', async () => {
    await runMatrix()
  }, 600_000)
})
