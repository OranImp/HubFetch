// apps/desktop/src/main/clone/clone-host.ts
//
// Todo 27: assign-before-start utility-process clone host + shutdown protocol.
//
// Message-order contract (proven by tests):
//   spawn -> ready -> assign -> contains -> arm -> start
//
//   spawn    fork the idle utility worker
//   ready    worker reports its PID (idle, no envelope yet)
//   assign   assignProcess(pid) — the Job now owns the worker
//   contains containsProcess(pid) must be true BEFORE any envelope is sent
//   arm      freeze + validate the immutable start envelope (SHA-256)
//   start    the ONLY thing that makes the worker spawn Git
//
// Cancellation is cooperative first (worker kills its Git child and acknacks),
// then the Job is terminated within a bounded grace interval and waitForEmpty
// proves zero descendants. App shutdown runs the same path. Utility exit/crash
// is captured and classified as `interrupted` for every descendant — the
// worker's exit is NEVER trusted as descendant exit: only Job zero proves it.
//
// `taskkill /T /F` is a LAST resort used ONLY after a native-operation error; it
// is recorded as `degradedTaskkill` and never satisfies success by itself — the
// Job must still reach zero.
import type { HubFetchJobBridge, HubFetchJobHandle } from '../native/hubfetch-job-loader'
import { getCloneSupport } from '../native/hubfetch-job-loader'
import type {
  CloneCommand,
  CloneEnvelope,
  CloneEvent,
  CloneRefusalCode
} from '../../utility/clone-protocol'
import { hashEnvelope } from '../../utility/clone-protocol'
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process'

/** The subset of Electron's UtilityProcess the host drives. */
export interface UtilityProcessLike {
  pid: number | undefined
  postMessage(message: CloneCommand): void
  kill(): boolean
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'message', listener: (message: CloneEvent) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  removeListener(event: 'spawn', listener: () => void): unknown
  removeListener(event: 'message', listener: (message: CloneEvent) => void): unknown
  removeListener(event: 'exit', listener: (code: number) => void): unknown
  removeListener(event: 'error', listener: (error: unknown) => void): unknown
}

export type ForkFn = (
  modulePath: string,
  args?: string[],
  options?: { stdio?: string }
) => UtilityProcessLike

export interface CloneHostOptions {
  bridge: HubFetchJobBridge
  /** Electron utilityProcess.fork (injectable for tests). */
  fork?: ForkFn
  /** Path to the bundled clone-worker entry (out/main/clone-worker.mjs). */
  workerModulePath: string
  /** Defaults to the loader's real gate. */
  getCloneSupport?: (bridge: HubFetchJobBridge) => { enabled: boolean; reason: string | null }
  /** taskkill fallback; injectable for tests. */
  taskkill?: (pid: number) => { ok: boolean; error?: string }
  now?: () => number
  /** Bounded grace before terminating the Job on cancel/shutdown. */
  graceIntervalMs?: number
  /** Bounded wait for worker messages (ready/armed/started/terminal). */
  waitTimeoutMs?: number
  /** Bounded wait for Job emptiness. */
  emptyTimeoutMs?: number
}

export type CloneStep = 'spawn' | 'ready' | 'assign' | 'contains' | 'arm' | 'start'

export type CloneOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface CloneRunRecord {
  assignmentId: string
  /** The deterministic message-order proof. */
  steps: CloneStep[]
  outcome: CloneOutcome
  exitCode: number | null
  signal: string | null
  /** Job zero proof: waitForEmpty ok AND zero-active query. */
  zeroProven: boolean
  /** taskkill /T /F was used after a native-operation error (degraded). */
  degradedTaskkill: boolean
  error: string | null
  gitPid: number | null
  utilityPid: number | null
  receivedProgress: number
  receivedLog: number
  refusedCode: CloneRefusalCode | null
}

export interface StartCloneOptions {
  assignmentId: string
  envelope: CloneEnvelope
  /** Called for every progress/log event before terminal. */
  onEvent?: (event: CloneEvent) => void
}

interface ActiveClone {
  assignmentId: string
  record: CloneRunRecord
  child: UtilityProcessLike
  job: HubFetchJobHandle
  onEvent?: (event: CloneEvent) => void
  settled: boolean
  exitHandled: boolean
  cancelRequested: boolean
  /** Aborts every pending waitForMessage when the clone settles. */
  abort: AbortController
}

function isMessage(event: unknown): event is CloneEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as { type?: unknown }).type === 'string'
  )
}

export class CloneHost {
  private readonly bridge: HubFetchJobBridge
  private readonly fork: ForkFn
  private readonly workerModulePath: string
  private readonly getSupport: (bridge: HubFetchJobBridge) => {
    enabled: boolean
    reason: string | null
  }
  private readonly taskkill: (pid: number) => { ok: boolean; error?: string }
  private readonly now: () => number
  private readonly graceIntervalMs: number
  private readonly waitTimeoutMs: number
  private readonly emptyTimeoutMs: number
  private readonly active = new Map<string, ActiveClone>()

  constructor(options: CloneHostOptions) {
    this.bridge = options.bridge
    this.fork =
      options.fork ??
      ((modulePath, args, opts) => {
        // Lazy import: electron's utilityProcess is only meaningful in main and
        // keeps this module importable under plain Node for tests.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { utilityProcess } = require('electron') as { utilityProcess: { fork: ForkFn } }
        return utilityProcess.fork(modulePath, args, opts)
      })
    this.workerModulePath = options.workerModulePath
    this.getSupport = options.getCloneSupport ?? getCloneSupport
    this.taskkill = options.taskkill ?? defaultTaskkill
    this.now = options.now ?? (() => Date.now())
    this.graceIntervalMs = options.graceIntervalMs ?? 3000
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30000
    this.emptyTimeoutMs = options.emptyTimeoutMs ?? 15000
  }

  /**
   * Run the full assign-before-start protocol for one clone. Returns the typed
   * record; the caller decides what to do with the result. Never throws: every
   * failure is a typed record.
   */
  async startClone(options: StartCloneOptions): Promise<CloneRunRecord> {
    const { assignmentId, envelope, onEvent } = options
    const support = this.getSupport(this.bridge)
    if (!support.enabled) {
      return {
        assignmentId,
        steps: [],
        outcome: 'failed',
        exitCode: null,
        signal: null,
        zeroProven: false,
        degradedTaskkill: false,
        error: `clone gated: ${support.reason ?? 'unknown reason'}`,
        gitPid: null,
        utilityPid: null,
        receivedProgress: 0,
        receivedLog: 0,
        refusedCode: null
      }
    }

    const created = this.bridge.status === 'ready' ? this.bridge.createJob() : null
    if (!created || !created.ok) {
      const detail = created
        ? `${created.code}: ${created.message}`
        : 'hubfetch_job bridge unavailable'
      return {
        assignmentId,
        steps: [],
        outcome: 'failed',
        exitCode: null,
        signal: null,
        zeroProven: false,
        degradedTaskkill: false,
        error: `createJob failed: ${detail}`,
        gitPid: null,
        utilityPid: null,
        receivedProgress: 0,
        receivedLog: 0,
        refusedCode: null
      }
    }

    const record: CloneRunRecord = {
      assignmentId,
      steps: [],
      outcome: 'failed',
      exitCode: null,
      signal: null,
      zeroProven: false,
      degradedTaskkill: false,
      error: null,
      gitPid: null,
      utilityPid: null,
      receivedProgress: 0,
      receivedLog: 0,
      refusedCode: null
    }

    const child = this.fork(this.workerModulePath, [assignmentId])
    record.steps.push('spawn')
    record.utilityPid = child.pid ?? null

    const active: ActiveClone = {
      assignmentId,
      record,
      child,
      job: created.handle,
      onEvent,
      settled: false,
      exitHandled: false,
      cancelRequested: false,
      abort: new AbortController()
    }
    this.active.set(assignmentId, active)

    try {
      // 1. wait for the worker to be idle-ready with its PID.
      const ready = await this.waitForMessage(
        child,
        (m): m is Extract<CloneEvent, { type: 'ready' }> => m.type === 'ready',
        'ready',
        this.waitTimeoutMs,
        active.abort.signal
      )
      record.steps.push('ready')
      record.utilityPid = ready.pid
      const workerPid = ready.pid
      if (!Number.isInteger(workerPid) || workerPid <= 0) {
        record.error = `worker reported invalid pid ${workerPid}`
        await this.settle(active, 'failed')
        return record
      }

      // 2. assign BEFORE any envelope can be honored.
      const assignResult = created.handle.assignProcess(workerPid)
      if (!assignResult.ok) {
        record.steps.push('assign')
        record.error = `assignProcess(${workerPid}) failed: ${assignResult.code} (${assignResult.errorCode})`
        await this.settle(active, 'failed')
        return record
      }
      record.steps.push('assign')

      // 3. confirm membership.
      const containsResult = created.handle.containsProcess(workerPid)
      if (!containsResult.ok || !containsResult.contains) {
        record.steps.push('contains')
        record.error = `containsProcess(${workerPid}) failed: ${JSON.stringify(containsResult)}`
        await this.settle(active, 'failed')
        return record
      }
      record.steps.push('contains')

      // 4. arm with the immutable envelope.
      const envelopeHash = hashEnvelope(envelope)
      child.postMessage({
        type: 'arm',
        assignmentId,
        envelope,
        envelopeHash
      })
      const armed = await this.waitForMessage(
        child,
        (m): m is Extract<CloneEvent, { type: 'armed' | 'refused' }> =>
          m.type === 'armed' || m.type === 'refused',
        'arm-response',
        this.waitTimeoutMs,
        active.abort.signal
      )
      if (armed.type === 'refused') {
        record.steps.push('arm')
        record.refusedCode = armed.code
        record.error = `worker refused arm: ${armed.code}: ${armed.message}`
        await this.settle(active, 'failed')
        return record
      }
      record.steps.push('arm')

      // 5. start — the only trigger for Git.
      child.postMessage({ type: 'start', assignmentId })
      const started = await this.waitForMessage(
        child,
        (m): m is Extract<CloneEvent, { type: 'started' | 'refused' | 'terminal' }> =>
          m.type === 'started' || m.type === 'refused' || m.type === 'terminal',
        'start-response',
        this.waitTimeoutMs,
        active.abort.signal
      )
      if (started.type === 'refused') {
        record.steps.push('start')
        record.refusedCode = started.code
        record.error = `worker refused start: ${started.code}: ${started.message}`
        await this.settle(active, 'failed')
        return record
      }
      record.steps.push('start')
      if (started.type === 'started') record.gitPid = started.gitPid

      if (started.type === 'terminal') {
        // Worker refused by exiting before start completed — treat as interrupted.
        record.exitCode = started.exitCode
        record.signal = started.signal
        record.outcome = 'interrupted'
        record.error = 'worker terminal before start acknowledged'
      } else {
        // 6. run until terminal, forwarding progress/log to the caller. Only a
        // real terminal ends the run; cancel-ack alone is a cooperative signal
        // handled by cancelClone, not a run end (the worker emits terminal
        // right after cancel-ack anyway).
        const terminal = await this.waitForMessage(
          child,
          (m): m is Extract<CloneEvent, { type: 'terminal' }> => m.type === 'terminal',
          'terminal',
          this.waitTimeoutMs,
          active.abort.signal,
          (m) => {
            if ((m.type === 'progress' || m.type === 'log') && onEvent) {
              onEvent(m)
            }
          }
        )
        record.outcome = terminal.outcome
        record.exitCode = terminal.exitCode
        record.signal = terminal.signal
      }

      // 7. Job zero proof. During an active cancel, cancelClone owns the
      // teardown (terminate -> waitForEmpty -> settle); hand off so we never
      // run a second waitForEmpty on the same Job.
      if (!active.cancelRequested) {
        const zero = await this.proveZero(active)
        if (!zero) {
          record.error = 'Job did not reach zero after terminal'
        }
        await this.settle(active, record.outcome)
      }
      return record
    } catch (error) {
      // If a cancel/shutdown already settled this clone, its record is final.
      if (active.settled) return record
      record.error = error instanceof Error ? error.message : String(error)
      record.outcome = this.exitHandled(active) ? 'interrupted' : 'failed'
      // A crashed worker must still be reaped through the Job: prove zero before
      // settling (worker exit is never trusted as descendant exit).
      await this.proveZero(active)
      await this.settle(active, record.outcome)
      return record
    }
  }

  /**
   * Cooperative cancel → bounded grace → terminate Job → wait for empty.
   * App shutdown uses this exact path for every active clone.
   */
  async cancelClone(assignmentId: string): Promise<CloneRunRecord> {
    const active = this.active.get(assignmentId)
    if (!active || active.settled) {
      return (
        active?.record ?? {
          assignmentId,
          steps: [],
          outcome: 'cancelled',
          exitCode: null,
          signal: null,
          zeroProven: false,
          degradedTaskkill: false,
          error: 'no active clone with that id',
          gitPid: null,
          utilityPid: null,
          receivedProgress: 0,
          receivedLog: 0,
          refusedCode: null
        }
      )
    }
    active.cancelRequested = true
    const record = active.record
    record.outcome = 'cancelled'
    try {
      active.child.postMessage({ type: 'cancel', assignmentId, reason: 'user' })

      // Bounded grace for the cooperative cancel-ack / terminal.
      try {
        await this.waitForMessage(
          active.child,
          (m): m is Extract<CloneEvent, { type: 'cancel-ack' | 'terminal' }> =>
            m.type === 'cancel-ack' || m.type === 'terminal',
          'cancel-ack-or-terminal',
          this.graceIntervalMs,
          active.abort.signal
        )
      } catch {
        /* grace elapsed or clone settled — the Job terminate below is the guarantee */
      }

      // If startClone already settled (worker emitted terminal after the ack),
      // the Job is closed and proven empty by that path. Nothing left to do.
      if (active.settled) return record

      // Terminate the Job within the grace bound.
      const terminateResult = active.job.terminate(1)
      if (!terminateResult.ok) {
        // Native-operation error → degraded taskkill fallback.
        record.degradedTaskkill = true
        record.error = `terminate failed (${terminateResult.code}), degraded taskkill used`
        await this.degradedTaskkillFallback(active)
      }
      await this.proveZero(active)
      await this.settle(active, 'cancelled')
      return record
    } catch (error) {
      if (active.settled) return record
      record.error = error instanceof Error ? error.message : String(error)
      record.outcome = 'interrupted'
      await this.settle(active, record.outcome)
      return record
    }
  }

  /** Shutdown: cancel every active clone through the same path, bounded. */
  async shutdown(): Promise<CloneRunRecord[]> {
    const ids = [...this.active.keys()]
    const results: CloneRunRecord[] = []
    for (const id of ids) {
      results.push(await this.cancelClone(id))
    }
    return results
  }

  /** Active (not yet settled) assignment ids — used to prove no leftovers. */
  activeIds(): string[] {
    return [...this.active.values()].filter((a) => !a.settled).map((a) => a.assignmentId)
  }

  private exitHandled(active: ActiveClone): boolean {
    return active.exitHandled
  }

  private async settle(active: ActiveClone, outcome: CloneOutcome): Promise<void> {
    if (active.settled) return
    active.settled = true
    active.record.outcome = outcome
    // Release every pending wait so no promise waits out the full timeout after
    // a cancel/shutdown settles the clone.
    active.abort.abort()
    try {
      active.job.close()
    } catch {
      /* idempotent close; finalizer also safe */
    }
    // Keep the settled record in the map so cancelClone/shutdown can return it;
    // activeIds() filters settled entries out.
  }

  private async proveZero(active: ActiveClone): Promise<boolean> {
    const wait = await active.job.waitForEmpty(this.emptyTimeoutMs)
    if (!wait.ok) {
      active.record.error = `waitForEmpty failed: ${wait.code}`
      return false
    }
    const query = active.job.activeProcessIds()
    if (!query.ok || query.pids.length !== 0) {
      active.record.error = `activeProcessIds after empty: ${JSON.stringify(query)}`
      return false
    }
    active.record.zeroProven = true
    return true
  }

  /**
   * taskkill /T /F may run only after a native-operation error. Recorded as
   * degraded and never sufficient by itself — proveZero still gates success.
   */
  private async degradedTaskkillFallback(active: ActiveClone): Promise<void> {
    const pid = active.record.utilityPid
    if (!pid) return
    const result = this.taskkill(pid)
    if (!result.ok) {
      active.record.error = `taskkill degraded fallback also failed: ${result.error ?? 'unknown'}`
    }
  }

  private waitForMessage<T extends CloneEvent>(
    child: UtilityProcessLike,
    predicate: (message: CloneEvent) => message is T,
    label: string,
    timeoutMs: number = this.waitTimeoutMs,
    signal?: AbortSignal,
    /** Optional sink for every message seen while waiting (progress/log). */
    onMessageSeen?: (message: CloneEvent) => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onMessage = (message: CloneEvent): void => {
        if (!isMessage(message)) return
        if (predicate(message)) {
          cleanup()
          resolve(message)
          return
        }
        onMessageSeen?.(message)
      }
      const onExit = (code: number): void => {
        // Mark the owning clone's exitHandled so the caller classifies
        // interrupted; reject so the catch path runs.
        const owner = [...this.active.values()].find((a) => a.child === child)
        if (owner) owner.exitHandled = true
        void code
        cleanup()
        reject(new Error(`utility exited before ${label}`))
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error(`clone settled while waiting for ${label}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out waiting for ${label} (${timeoutMs}ms)`))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.removeListener('message', onMessage)
        child.removeListener('exit', onExit)
      }
      if (signal?.aborted) {
        cleanup()
        reject(new Error(`clone settled while waiting for ${label}`))
        return
      }
      signal?.addEventListener('abort', onAbort)
      child.on('message', onMessage)
      child.on('exit', onExit)
    })
  }
}

/** Default taskkill fallback — last resort after a native-operation error. */
function defaultTaskkill(pid: number): { ok: boolean; error?: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process') as {
    spawnSync: (
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptionsWithStringEncoding
    ) => { status: number | null }
  }
  const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
    stdio: 'ignore',
    windowsHide: true,
    encoding: 'utf8'
  })
  return {
    ok: result.status === 0,
    error: result.status === 0 ? undefined : `exit ${result.status}`
  }
}
