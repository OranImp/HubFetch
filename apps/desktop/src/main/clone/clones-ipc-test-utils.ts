// apps/desktop/src/main/clone/clones-ipc-test-utils.ts
//
// Shared harness for the Todo 33 clone-IPC tests. NOT a test file itself
// (vitest only collects `*.test.ts`). Builds a REAL CloneManager + CloneStore
// over an in-memory SQLite DB, a fake clone host, and a fake diagnostics
// probe, then registers the REAL central IPC surface (`registerIpcHandlers`)
// against a mocked `electron` so tests can drive the actual preload bridge ->
// ipcRenderer.invoke -> main handler -> Zod + sender-trust -> manager path.
//
// The `electron` mock itself lives in each test file (vi.mock is hoisted per
// file); this module only consumes the shared mock container it fills.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import type { IpcInvokeChannel, RendererApi } from '@hubfetch/shared'
import { ipcRequestSchemas } from '@hubfetch/shared'
import { MIGRATIONS } from '../db'
import { registerIpcHandlers, type AppContext } from '../ipc'
import { checkSenderTrust } from '../ipc-guard'
import type { CloneEnvelope, CloneEvent } from '../../utility/clone-protocol'
import type { CloneManagerHost } from './clone-manager'
import { CloneManager } from './clone-manager'
import type { CloneOutcome, CloneRunRecord } from './clone-host'
import { CloneStore, type CloneStoreDatabase } from './clone-store'

/** Trusted packaged renderer entry the sender check accepts (Todo 18). */
export const PACKAGED_ENTRY = 'file:///E:/Apps/HubFetch/resources/app.asar/out/renderer/index.html'

/** Shared state filled by each test file's `vi.mock('electron')`. */
export interface ClonesIpcMock {
  handlers: Map<string, (event: unknown, payload: unknown) => unknown>
  /** Electron invokes `ipcRenderer.on` listeners as (event, ...args). */
  rendererListeners: Map<string, Array<(event: unknown, payload: unknown) => void>>
  exposed: { key: string | null; api: RendererApi | null }
  trustedUrl: string
  openPathCalls: string[]
}

export function makeMockContainer(): ClonesIpcMock {
  return {
    handlers: new Map(),
    rendererListeners: new Map(),
    exposed: { key: null, api: null },
    trustedUrl: PACKAGED_ENTRY,
    openPathCalls: []
  }
}

/** A sender frame at the app's own trusted packaged entry. */
export function makeTrustedEvent(mock: ClonesIpcMock): unknown {
  const frame = {}
  return {
    sender: { id: 7, getURL: () => mock.trustedUrl, mainFrame: frame },
    senderFrame: frame
  }
}

/** A hostile sender (rogue frame / untrusted URL); never passes sender trust. */
export function makeRogueEvent(url = 'https://evil.example/'): unknown {
  const frame = {}
  return {
    sender: { id: 7, getURL: () => url, mainFrame: frame },
    senderFrame: frame
  }
}

// ---------------------------------------------------------------------------
// Store / diagnostics / host fakes (mirrors the Todo 32 QA harness)
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

function runRecord(assignmentId: string, outcome: CloneOutcome): CloneRunRecord {
  return {
    assignmentId,
    steps: [],
    outcome,
    exitCode: null,
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
  }
}

/**
 * Deterministic clone host: completes instantly, or hangs on start when
 * `hangNext` is set (so a test can observe an active clone and cancel it).
 */
export class FakeCloneHost implements CloneManagerHost {
  startCalls = 0
  hangNext = false
  private readonly pending = new Map<string, { resolve: (record: CloneRunRecord) => void }>()

  readonly startClone = vi.fn(
    async (options: {
      assignmentId: string
      envelope: CloneEnvelope
      onEvent?: (event: CloneEvent) => void
      auth?: 'system' | 'app-token'
    }) => {
      this.startCalls += 1
      if (this.hangNext) {
        return new Promise<CloneRunRecord>((resolve) => {
          this.pending.set(options.assignmentId, { resolve })
        })
      }
      return runRecord(options.assignmentId, 'completed')
    }
  )

  readonly cancelClone = vi.fn(async (assignmentId: string) => {
    const pending = this.pending.get(assignmentId)
    if (pending) {
      pending.resolve(runRecord(assignmentId, 'cancelled'))
      this.pending.delete(assignmentId)
    }
    return runRecord(assignmentId, 'cancelled')
  })

  readonly shutdown = vi.fn(async () => [])
  readonly activeIds = vi.fn(() => [])
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface ClonesIpcHarness {
  db: DatabaseSync
  store: CloneStore
  manager: CloneManager
  host: FakeCloneHost
  api: RendererApi
  /** Every `evt:clones` payload the manager published (schema-validated). */
  published: Array<Array<{ id: string }>>
  scratchDir: string
  /** Clean up the scratch directory. */
  cleanup(): void
}

export function makeClonesIpcHarness(mock: ClonesIpcMock): ClonesIpcHarness {
  const db = new DatabaseSync(':memory:')
  for (const sql of MIGRATIONS) db.exec(sql)
  const scratchDir = mkdtempSync(join(tmpdir(), 't33-ipc-'))
  const store = new CloneStore(nodeStoreDb(db))
  const host = new FakeCloneHost()
  const published: Array<Array<{ id: string }>> = []
  const diagnostics = {
    git: ['git'],
    check: vi.fn(async () => installedReport())
  }
  const manager = new CloneManager({
    store,
    host,
    diagnostics,
    publish: (records) => {
      published.push(records)
      // Electron calls `ipcRenderer.on` listeners as (event, ...args); the
      // preload's wrapped listener forwards the second argument to the app.
      for (const listener of mock.rendererListeners.get('evt:clones') ?? []) listener(null, records)
    },
    cwd: scratchDir
  })
  manager.recover()

  const settings = { get: () => ({ proxy: { mode: 'system' as const, manualUrl: null } }) }
  const ctx = {
    clones: manager,
    settings,
    db: {} as never,
    hub: {} as never,
    auth: {} as never,
    library: {} as never,
    downloads: {} as never,
    cache: {} as never,
    follows: {} as never,
    integrationTasks: {} as never,
    i18n: {} as never,
    rebuildMenu: () => undefined,
    notificationRegistration: {} as never,
    removeNotificationShortcut: () => false,
    broadcast: (() => undefined) as never,
    applyNetworkSettings: (async () => undefined) as never,
    applyDesktopSettings: (() => undefined) as never,
    diagnostics: {} as never
  } as unknown as AppContext
  registerIpcHandlers(ctx, { packagedEntry: PACKAGED_ENTRY, devOrigin: null })
  // Todo 2 contract-only: product handlers land in Todo 3. Until then, bind
  // the same Zod + sender-trust wrapper so contract tests can prove
  // rejection happens before any manager/dialog call. Skip when already
  // registered so later QA tests keep the real handlers.
  registerMissingCloneContractChannels(mock)

  return {
    db,
    store,
    manager,
    host,
    api: mock.exposed.api as RendererApi,
    published,
    scratchDir,
    cleanup: () => {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  }
}

/**
 * Contract-only stubs for clone channels whose product handlers are not yet
 * registered. Mirrors the central `handle()` wrapper: schema-present
 * channels parse with Zod; schema-absent (void-request) channels reject any
 * payload; sender trust is checked before the stub body. The stub body never
 * calls CloneManager or `dialog.showOpenDialog`.
 */
function registerMissingCloneContractChannels(mock: ClonesIpcMock): void {
  registerCloneContractChannel(mock, 'clones:remove', () => [])
  registerCloneContractChannel(mock, 'clones:selectDestination', () => null)
}

function registerCloneContractChannel(
  mock: ClonesIpcMock,
  channel: Extract<IpcInvokeChannel, 'clones:remove' | 'clones:selectDestination'>,
  onTrusted: () => unknown
): void {
  if (mock.handlers.has(channel)) return
  // Async to match the real `handle()` wrapper: throws become rejected
  // promises so `Promise.resolve(handler())` can assert `.rejects`.
  mock.handlers.set(channel, async (event, payload) => {
    const schema = ipcRequestSchemas[channel]
    if (schema) {
      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        throw new Error(`Invalid payload for ${channel}: ${parsed.error.message}`)
      }
    } else if (payload !== undefined && payload !== null) {
      throw new Error(`Channel ${channel} accepts no payload`)
    }
    const senderEvent = event as {
      sender?: { id?: number; getURL?: () => string; mainFrame?: unknown }
      senderFrame?: unknown
    }
    const sender = senderEvent.sender
    const getURL = sender?.getURL
    const check = checkSenderTrust(
      { packagedEntry: PACKAGED_ENTRY, devOrigin: null },
      {
        webContentsId: sender?.id ?? 0,
        isMainFrame: senderEvent.senderFrame === sender?.mainFrame,
        url: getURL === undefined ? '' : getURL()
      }
    )
    if (!check.ok) {
      throw new Error(`IPC sender rejected: ${check.reason}`)
    }
    return onTrusted()
  })
}
