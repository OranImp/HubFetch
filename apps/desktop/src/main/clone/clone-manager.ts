// apps/desktop/src/main/clone/clone-manager.ts
//
// Todo 32: orchestrate a separate single-active clone FIFO alongside parallel
// downloads.
//
//   - Composition: CloneManager owns the durable queue (Todo 31 CloneStore),
//     the Git readiness probes (Todo 28), the Todo 20 proxy contract folded
//     into the clone envelope, the assign-before-start worker host (Todo 27,
//     with the Todo 30 AskPass broker reachable through its `askPass` factory),
//     and a typed event publisher (main -> renderer, `evt:clones`).
//   - Startup: recover active rows (running/cancelling -> interrupted via the
//     store), then pump the oldest queued attempt.
//   - Start gate: destination validation/reserve (Todo 29) AND Git diagnostics
//     must pass BEFORE any worker is spawned; a gate failure records a typed
//     failure and never calls the host. Job/worker readiness is additionally
//     enforced inside the host (assign-before-start), which never spawns Git on
//     failure — the manager terminalizes those attempts from the host record.
//   - Exactly one clone at a time: the pump is sequential, the store enforces
//     at most one active row transactionally, and the host runs one worker.
//   - Progress persistence is throttled (at most one write per
//     `progressPersistMs` per attempt) with a bounded deferred flush; the
//     latest progress is flushed on terminal BEFORE the terminal transition.
//   - Terminalization is transactional through the Todo 31 legal transitions
//     and guarded so exactly ONE terminal event is emitted per attempt; the
//     next queued clone pumps immediately after.
//   - Cancellation: queued cancel never touches a worker (store queued ->
//     cancelled); an active cancel goes through the Todo 27 protocol
//     (cooperative -> grace -> Job terminate -> waitForEmpty) via
//     host.cancelClone; retry delegates to the store (linked fresh attempt,
//     new empty destination).
//   - Shutdown: stop accepting work, cancel/wait bounded through the host,
//     verify zero Job PIDs and zero active store rows.
//   - Downloads are untouched: CloneManager never serializes or shares
//     download concurrency settings; both managers coexist independently.
import type {
  CloneCreateInput,
  CloneFailureInput,
  CloneProgress,
  CloneRecord
} from '@hubfetch/shared'
import { deriveCloneUrl } from '@hubfetch/shared'
import type { CloneEnvelope, CloneEvent } from '../../utility/clone-protocol'
import { CLONE_ENVELOPE_VERSION } from '../../utility/clone-protocol'
import { gitProxyContract } from '../git-proxy'
import { Redactor } from '../security/redaction'
import type { GitDiagnosticsReport } from '../git-diagnostics'
import {
  buildCloneArgv,
  cloneEnvironment,
  makeCloneFailure,
  reserveCloneDestination,
  DestinationError,
  type CloneDestinationReservation
} from './clone-contract'
import type { CloneOutcome, CloneRunRecord } from './clone-host'
import type { CloneStore } from './clone-store'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Worker progress-phase display names mapped to the persisted closed union. */
const PROGRESS_PHASE_FROM_WORKER: Readonly<Record<string, CloneProgress['phase']>> = {
  Receiving: 'receiving',
  Resolving: 'resolving',
  Updating: 'updating',
  'Checking out': 'checkout'
}

/** Bounded stderr ring kept per attempt for typed failure classification. */
const MAX_LOG_RING = 32

/** Upper bound for a persisted failure detail (the store schema caps at 2000). */
const MAX_FAILURE_DETAIL = 2000

/** How often one attempt's progress may be persisted (throttle window). */
const DEFAULT_PROGRESS_PERSIST_MS = 250

/** How often the manager broadcasts the clone list during progress. */
const DEFAULT_BROADCAST_MS = 100

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The CloneHost surface the manager drives (structural; CloneHost satisfies it). */
export interface CloneManagerHost {
  startClone(options: {
    assignmentId: string
    envelope: CloneEnvelope
    onEvent?: (event: CloneEvent) => void
    auth?: 'system' | 'app-token'
  }): Promise<CloneRunRecord>
  cancelClone(assignmentId: string): Promise<CloneRunRecord>
  shutdown(): Promise<CloneRunRecord[]>
  activeIds(): string[]
}

/** The GitDiagnostics surface the manager needs (structural). */
export interface CloneManagerDiagnostics {
  /** The git executable prefix the probes used (first element = envelope git). */
  git: readonly string[]
  check(signal?: AbortSignal): Promise<GitDiagnosticsReport>
}

export interface CloneManagerOptions {
  store: CloneStore
  host: CloneManagerHost
  diagnostics: CloneManagerDiagnostics
  /** Main -> renderer event publisher (typed channel, e.g. `evt:clones`). */
  publish: (records: CloneRecord[]) => void
  /** Progress persist throttle in milliseconds (default 250). */
  progressPersistMs?: number
  /** Broadcast throttle in milliseconds during progress (default 100). */
  broadcastMs?: number
  /** Injectable clock for deterministic throttling tests (default Date.now). */
  now?: () => number
  /** Working directory for the Git child (default process.cwd()). */
  cwd?: string
}

/** Typed shutdown result proving zero surviving work. */
export interface CloneShutdownResult {
  /** Attempts active (running/cancelling) when shutdown started. */
  active: string[]
  /** Job PIDs still alive after the bounded cancel/wait (must be empty). */
  remainingJobPids: string[]
  /** Store rows still active after shutdown (must be 0). */
  storeActive: number
  zeroProven: boolean
}

/** Redact and bound a failure detail to the store schema limit. */
function sanitizeDetail(text: string): string {
  const redacted = new Redactor().redactText(text)
  return redacted.length > MAX_FAILURE_DETAIL ? redacted.slice(0, MAX_FAILURE_DETAIL) : redacted
}

/** NodeJS.ProcessEnv -> strict Record<string, string> (drops undefined values). */
function toEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export class CloneManager {
  private readonly store: CloneStore
  private readonly host: CloneManagerHost
  private readonly diagnostics: CloneManagerDiagnostics
  private readonly publish: (records: CloneRecord[]) => void
  private readonly progressPersistMs: number
  private readonly broadcastMs: number
  private readonly now: () => number
  private readonly cwd: string

  /** Latest unpersisted progress per attempt (throttled write queue). */
  private readonly latestProgress = new Map<string, CloneProgress>()
  /** Last successful persist timestamp per attempt (bounded write rate). */
  private readonly lastPersistAt = new Map<string, number>()
  /** Pending one-shot flush timers for attempts inside the throttle window. */
  private readonly deferredFlush = new Map<string, NodeJS.Timeout>()
  /** Bounded stderr ring per attempt (typed failure classification). */
  private readonly logRing = new Map<string, string[]>()
  /** Attempts already terminalized — exactly one terminal event per attempt. */
  private readonly terminalized = new Set<string>()
  /** Promise of the in-flight startAttempt, awaited by cancel/shutdown. */
  private readonly attemptPromises = new Map<string, Promise<void>>()

  private broadcastTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private inFlight: string | null = null

  constructor(options: CloneManagerOptions) {
    this.store = options.store
    this.host = options.host
    this.diagnostics = options.diagnostics
    this.publish = options.publish
    this.progressPersistMs = options.progressPersistMs ?? DEFAULT_PROGRESS_PERSIST_MS
    this.broadcastMs = options.broadcastMs ?? DEFAULT_BROADCAST_MS
    this.now = options.now ?? (() => Date.now())
    this.cwd = options.cwd ?? process.cwd()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Every attempt in deterministic FIFO order. */
  list(): CloneRecord[] {
    return this.store.list()
  }

  /** Enqueue one new attempt and pump the FIFO. */
  create(input: CloneCreateInput): CloneRecord {
    const record = this.store.createQueued(input)
    this.publishNow()
    this.pump()
    return record
  }

  /** Retry a terminal attempt (delegates to the Todo 31 linked fresh row). */
  retry(parentId: string, input: CloneCreateInput): CloneRecord {
    const record = this.store.retry(parentId, input)
    this.publishNow()
    this.pump()
    return record
  }

  /**
   * Remove one terminal queue record. Delegates to the store, publishes once,
   * and returns the updated list. Never cancels workers, never deletes
   * destination files, never pumps the scheduler.
   */
  remove(id: string): CloneRecord[] {
    const records = this.store.removeTerminal(id)
    this.publishNow()
    return records
  }

  /**
   * Startup recovery: every running/cancelling row becomes interrupted, then
   * the oldest queued attempt is pumped. Idempotent.
   */
  recover(): CloneRecord[] {
    const changed = this.store.recoverInterrupted()
    if (changed.length > 0) this.publishNow()
    this.pump()
    return changed
  }

  /**
   * Cancel one attempt. Queued cancels never touch a worker; an active cancel
   * runs the Todo 27 protocol and waits for the in-flight terminalization.
   */
  async cancel(id: string): Promise<CloneRecord[]> {
    const record = this.store.get(id)
    if (record === undefined) return this.list()
    if (record.status === 'queued') {
      this.store.cancelQueued(id)
      this.publishNow()
      return this.list()
    }
    if (record.status === 'running' || record.status === 'cancelling') {
      if (record.status === 'running') {
        try {
          this.store.requestCancel(id)
        } catch {
          /* already cancelling — the in-flight terminalization owns the row */
        }
        this.publishNow()
      }
      await this.host.cancelClone(id)
      const attempt = this.attemptPromises.get(id)
      if (attempt !== undefined) await attempt
      return this.list()
    }
    return this.list()
  }

  /**
   * Shutdown: stop accepting work, cancel/wait bounded through the host, then
   * verify zero Job PIDs and zero active store rows.
   */
  async shutdown(): Promise<CloneShutdownResult> {
    if (this.shuttingDown) {
      const remainingJobPids = this.host.activeIds()
      const storeActive = this.store.activeCount()
      return {
        active: [],
        remainingJobPids,
        storeActive,
        zeroProven: remainingJobPids.length === 0 && storeActive === 0
      }
    }
    this.shuttingDown = true
    this.clearTimers()
    const active = this.store
      .list()
      .filter((r) => r.status === 'running' || r.status === 'cancelling')
    for (const record of active) {
      if (record.status === 'running') {
        try {
          this.store.requestCancel(record.id)
        } catch {
          /* already cancelling */
        }
      }
    }
    this.publishNow()
    await this.host.shutdown()
    if (this.inFlight !== null) {
      const attempt = this.attemptPromises.get(this.inFlight)
      if (attempt !== undefined) await attempt
    }
    const remainingJobPids = this.host.activeIds()
    const storeActive = this.store.activeCount()
    return {
      active: active.map((r) => r.id),
      remainingJobPids,
      storeActive,
      zeroProven: remainingJobPids.length === 0 && storeActive === 0
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** Pump the oldest queued attempt; never runs while one is in flight. */
  private pump(): void {
    if (this.shuttingDown) return
    if (this.inFlight !== null) return
    const queued = this.store.nextQueued()
    if (queued === null) return
    if (this.store.hasActive()) return
    this.inFlight = queued.id
    const promise = this.startAttempt(queued.id)
    this.attemptPromises.set(queued.id, promise)
    void promise.finally(() => {
      this.inFlight = null
      this.attemptPromises.delete(queued.id)
      this.pump()
    })
  }

  /**
   * Run ONE attempt end-to-end: transition to running, gate destination and
   * diagnostics (fail-before-spawn), build the immutable envelope, drive the
   * assign-before-start host, then terminalize transactionally. Never throws.
   */
  private async startAttempt(id: string): Promise<void> {
    try {
      const running = this.store.start(id)
      this.publishNow()

      // Gate 1: destination validation + atomic reservation (Todo 29).
      let reservation: CloneDestinationReservation | null = null
      try {
        reservation = await reserveCloneDestination(running.destination)
      } catch (error) {
        const reason =
          error instanceof DestinationError
            ? error.reason
            : error instanceof Error
              ? error.message
              : String(error)
        this.terminalize(id, 'failed', {
          errorCode: 'destination',
          error: sanitizeDetail(`clone destination unavailable: ${reason}`)
        })
        return
      }

      // Gate 2: required diagnostics (Git present). A missing Git NEVER spawns.
      let report: GitDiagnosticsReport
      try {
        report = await this.diagnostics.check()
      } catch (error) {
        await reservation.release()
        this.terminalize(id, 'failed', {
          errorCode: 'internal',
          error: sanitizeDetail(
            `diagnostics probe failed: ${error instanceof Error ? error.message : String(error)}`
          )
        })
        return
      }
      if (report.git.status !== 'installed') {
        await reservation.release()
        this.terminalize(id, 'failed', {
          errorCode: 'dependency',
          error: `git is not available (readiness: ${report.git.status})`
        })
        return
      }
      // The reservation serialized this start; git's empty check is the final
      // referee, so the marker is released BEFORE the worker runs.
      await reservation.release()

      // A cancel/shutdown during the gate aborts the start BEFORE any worker.
      if (this.store.get(id)?.status !== 'running') {
        this.terminalize(id, 'cancelled')
        return
      }

      const envelope = this.buildEnvelope(running)
      const hostRecord = await this.host.startClone({
        assignmentId: id,
        envelope,
        auth: running.auth === 'app-token' ? 'app-token' : 'system',
        onEvent: (event) => this.onWorkerEvent(id, event)
      })

      if (hostRecord.outcome === 'failed') {
        this.terminalize(id, 'failed', this.failureOf(id, hostRecord))
      } else {
        this.terminalize(id, hostRecord.outcome)
      }
    } catch (error) {
      // The host never throws; this is a defensive bound for manager misuse.
      this.terminalize(id, 'interrupted', {
        errorCode: 'internal',
        error: sanitizeDetail(error instanceof Error ? error.message : String(error))
      })
    }
  }

  // -------------------------------------------------------------------------
  // Envelope construction
  // -------------------------------------------------------------------------

  private buildEnvelope(record: CloneRecord): CloneEnvelope {
    const url = deriveCloneUrl(record.repoKind, record.repoId, record.transport)
    const proxy = gitProxyContract(record.proxy)
    const argv = buildCloneArgv({
      url,
      destination: record.destination,
      revision: record.revision,
      proxy
    })
    return {
      version: CLONE_ENVELOPE_VERSION,
      assignmentId: record.id,
      git: this.diagnostics.git[0] ?? 'git',
      argv,
      cwd: this.cwd,
      env: cloneEnvironment(toEnvRecord(proxy.env))
    }
  }

  // -------------------------------------------------------------------------
  // Worker events: logs + throttled progress
  // -------------------------------------------------------------------------

  private onWorkerEvent(id: string, event: CloneEvent): void {
    if (event.type === 'log') {
      let ring = this.logRing.get(id)
      if (ring === undefined) {
        ring = []
        this.logRing.set(id, ring)
      }
      ring.push(event.line)
      if (ring.length > MAX_LOG_RING) {
        ring.splice(0, ring.length - MAX_LOG_RING)
      }
      return
    }
    if (event.type === 'progress') {
      this.handleProgress(id, event)
    }
  }

  private handleProgress(id: string, event: Extract<CloneEvent, { type: 'progress' }>): void {
    const phase = PROGRESS_PHASE_FROM_WORKER[event.phase]
    if (phase === undefined) return // unknown worker phase: never persisted
    const progress: CloneProgress = {
      phase,
      percent: event.percent,
      done: event.percent,
      total: 100
    }
    this.latestProgress.set(id, progress)
    this.maybePersistProgress(id)
  }

  /** Persist immediately when the throttle window is open; else defer. */
  private maybePersistProgress(id: string): void {
    if (this.shuttingDown) return
    const progress = this.latestProgress.get(id)
    if (progress === undefined) return
    const now = this.now()
    const last = this.lastPersistAt.get(id) ?? 0
    if (now - last >= this.progressPersistMs) {
      this.persistProgress(id, progress, now)
      return
    }
    if (this.deferredFlush.has(id)) return
    const delay = Math.max(1, this.progressPersistMs - (now - last))
    const timer = setTimeout(() => {
      this.deferredFlush.delete(id)
      this.maybePersistProgress(id)
    }, delay)
    this.deferredFlush.set(id, timer)
  }

  private persistProgress(id: string, progress: CloneProgress, at: number): void {
    try {
      this.store.updateProgress(id, progress)
      this.lastPersistAt.set(id, at)
      this.latestProgress.delete(id)
      this.scheduleBroadcast()
    } catch {
      // The row became terminal mid-flush; the terminal transition owns it now.
      this.latestProgress.delete(id)
    }
  }

  /** Final progress flush BEFORE the terminal transition (never throttled). */
  private finalFlushProgress(id: string): void {
    const progress = this.latestProgress.get(id)
    this.latestProgress.delete(id)
    const timer = this.deferredFlush.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.deferredFlush.delete(id)
    }
    if (progress === undefined) return
    try {
      this.store.updateProgress(id, progress)
    } catch {
      /* row already terminal by a racing path; the terminal transition stands */
    }
  }

  // -------------------------------------------------------------------------
  // Terminalization (exactly one terminal event per attempt)
  // -------------------------------------------------------------------------

  private terminalize(id: string, outcome: CloneOutcome, failure?: CloneFailureInput): void {
    if (this.terminalized.has(id)) return
    this.terminalized.add(id)
    this.finalFlushProgress(id)
    const current = this.store.get(id)
    if (current === undefined) return
    switch (current.status) {
      case 'running':
        switch (outcome) {
          case 'completed':
            this.store.complete(id)
            break
          case 'failed':
            this.store.fail(id, failure ?? { errorCode: 'internal', error: 'clone failed' })
            break
          case 'interrupted':
            this.store.transition(id, 'interrupted')
            break
          case 'cancelled':
            // running->cancelled is illegal; a cancel always moves through
            // cancelling first. This defensive path uses the legal sink.
            this.store.transition(id, 'interrupted')
            break
        }
        break
      case 'cancelling':
        switch (outcome) {
          case 'cancelled':
            this.store.finishCancelled(id)
            break
          case 'interrupted':
            this.store.transition(id, 'interrupted')
            break
          default:
            // completed/failed while a cancel was in flight: the outcome is
            // unverifiable, so cancelling -> interrupted is the legal terminal.
            this.store.transition(id, 'interrupted')
            break
        }
        break
      default:
        break // queued rows cancel directly; terminal rows are immutable
    }
    this.publishNow()
    this.logRing.delete(id)
    this.lastPersistAt.delete(id)
  }

  /** Classify a failed host record into the persisted typed failure. */
  private failureOf(id: string, hostRecord: CloneRunRecord): CloneFailureInput {
    const ring = this.logRing.get(id) ?? []
    const errorText = hostRecord.error ?? ''
    if (hostRecord.refusedCode !== null) {
      return { errorCode: 'internal', error: sanitizeDetail(errorText) }
    }
    if (/askpass/i.test(errorText)) {
      return { errorCode: 'auth', error: sanitizeDetail(errorText) }
    }
    if (
      /clone gated|createJob failed|assignProcess|containsProcess|invalid pid|worker refused|utility exited|timed out waiting/.test(
        errorText
      )
    ) {
      return { errorCode: 'internal', error: sanitizeDetail(errorText) }
    }
    if (ring.length > 0 || hostRecord.exitCode !== null) {
      const failure = makeCloneFailure(
        hostRecord.exitCode,
        ring.join('\n') || errorText,
        new Redactor()
      )
      return { errorCode: failure.code, error: failure.detail }
    }
    return {
      errorCode: 'internal',
      error: sanitizeDetail(errorText || `clone failed (${hostRecord.outcome})`)
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast (throttled during progress, immediate on state changes)
  // -------------------------------------------------------------------------

  private scheduleBroadcast(): void {
    if (this.shuttingDown) return
    if (this.broadcastTimer !== null) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.publish(this.store.list())
    }, this.broadcastMs)
  }

  private publishNow(): void {
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    this.publish(this.store.list())
  }

  private clearTimers(): void {
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    for (const timer of this.deferredFlush.values()) clearTimeout(timer)
    this.deferredFlush.clear()
  }
}
