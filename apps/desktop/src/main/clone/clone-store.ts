// apps/desktop/src/main/clone/clone-store.ts
//
// Todo 31: persist clone attempts, legal transitions, startup recovery, and
// FIFO order.
//
//   - clone_tasks: one row = ONE immutable attempt. A retry never mutates a
//     terminal row — it inserts a NEW linked row (attempt+1, retry_of) whose
//     destination must be absent or empty.
//   - transition matrix: create queued; queued cancel -> cancelled; running
//     cancel -> cancelling -> cancelled/interrupted; terminal immutable;
//     startup running/cancelling -> interrupted; retry only from
//     failed/cancelled/interrupted.
//   - FIFO order is (created_at, id) and at most one active clone (running or
//     cancelling) exists at any moment.
//   - every write is validated against the shared zod schemas FIRST and the
//     DB CHECK constraints backstop the engine; a token, pipe name, credential
//     URL, or raw stderr can never satisfy a column.
//
// The store talks only to the duck-typed `CloneStoreDatabase` (better-sqlite3
// in the app, node:sqlite in tests) — no Electron, no network, sync mutations
// wrapped in transactions so an illegal transition never persists partial
// state.
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import {
  cloneCreateInputSchema,
  cloneFailureInputSchema,
  cloneProgressSchema,
  cloneRecordSchema,
  cloneRevisionSchema,
  type CloneCreateInput,
  type CloneErrorCode,
  type CloneFailureInput,
  type CloneProgress,
  type CloneRecord,
  type CloneRevision,
  type CloneStatus
} from '@hubfetch/shared'
import type { ProxySnapshot } from '@hubfetch/shared'

// ---------------------------------------------------------------------------
// Duck-typed database (better-sqlite3 in app, node:sqlite in tests)
// ---------------------------------------------------------------------------

export interface CloneStoreStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface CloneStoreDatabase {
  prepare(sql: string): CloneStoreStatement
  transaction<T>(fn: () => T): () => T
}

// ---------------------------------------------------------------------------
// Persisted row shape
// ---------------------------------------------------------------------------

export interface CloneRow {
  id: string
  attempt: number
  repo_kind: string
  repo_id: string
  revision_json: string | null
  transport: string
  destination: string
  auth: string
  account_id: string | null
  account_label: string | null
  proxy_mode: string
  proxy_url: string | null
  status: string
  error_code: string | null
  error: string | null
  progress_phase: string | null
  progress_percent: number
  progress_done: number
  progress_total: number
  created_at: string
  started_at: string | null
  updated_at: string
  completed_at: string | null
  retry_of: string | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CloneStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloneStoreError'
  }
}

/** The row does not exist. */
export class CloneNotFoundError extends CloneStoreError {
  constructor(id: string) {
    super(`clone attempt ${id} not found`)
    this.name = 'CloneNotFoundError'
  }
}

/** The requested status transition is not in the legal matrix. */
export class IllegalCloneTransitionError extends CloneStoreError {
  readonly from: CloneStatus
  readonly to: CloneStatus

  constructor(id: string, from: CloneStatus, to: CloneStatus) {
    super(`illegal clone transition ${from} -> ${to} for ${id}`)
    this.name = 'IllegalCloneTransitionError'
    this.from = from
    this.to = to
  }
}

/** Another clone is already active (running or cancelling). */
export class ActiveCloneExistsError extends CloneStoreError {
  constructor() {
    super('another clone is already active (at most one active clone at a time)')
    this.name = 'ActiveCloneExistsError'
  }
}

/** A retry destination exists and is not an empty directory. */
export class CloneDestinationError extends CloneStoreError {
  constructor(reason: string) {
    super(`clone retry destination unavailable: ${reason}`)
    this.name = 'CloneDestinationError'
  }
}

/** Progress recorded while the row is not running/cancelling. */
export class CloneProgressError extends CloneStoreError {
  constructor(message: string) {
    super(message)
    this.name = 'CloneProgressError'
  }
}

/** A persisted row fails the strict record schema (cannot be mapped safely). */
export class CorruptCloneRecordError extends CloneStoreError {
  constructor(id: string, detail: string) {
    super(`corrupt clone record ${id}: ${detail}`)
    this.name = 'CorruptCloneRecordError'
  }
}

/** An input failed the shared zod schema (raw/secret/oversized values). */
export class CloneValidationError extends CloneStoreError {
  constructor(context: string, detail: string) {
    super(`${context}: ${detail}`)
    this.name = 'CloneValidationError'
  }
}

// ---------------------------------------------------------------------------
// Transition matrix (the legal pairs; everything else is rejected)
// ---------------------------------------------------------------------------

export const CLONE_TRANSITION_MATRIX: Readonly<Record<CloneStatus, readonly CloneStatus[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['cancelling', 'completed', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

/** Rows that hold a live worker: running (in-flight) or cancelling (cancelling). */
export const CLONE_ACTIVE_STATUSES: readonly CloneStatus[] = ['running', 'cancelling']

/** Terminal rows are immutable; only these are retryable. */
export const CLONE_TERMINAL_STATUSES: readonly CloneStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]

export const CLONE_RETRYABLE_STATUSES: readonly CloneStatus[] = [
  'failed',
  'cancelled',
  'interrupted'
]

/** Extra column bookkeeping carried on a transition. */
export interface CloneTransitionExtra {
  errorCode?: CloneErrorCode | null
  error?: string | null
  /** Clear the progress columns (used by completion). */
  clearProgress?: boolean
}

// ---------------------------------------------------------------------------
// Destination availability (retry requires an absent or empty destination)
// ---------------------------------------------------------------------------

/**
 * Default check: a destination is available when it is absent, or an existing
 * EMPTY directory. A file or any non-empty directory (a partial clone, a
 * prior attempt's leftovers) is rejected — a retry never reuses a nonempty or
 * partial destination. Synchronous on purpose: it runs inside the store's
 * transaction so a rejection persists nothing.
 */
function defaultDestinationAvailable(destination: string): void {
  let info
  try {
    info = statSync(destination)
  } catch {
    return // absent = available
  }
  if (!info.isDirectory()) {
    throw new CloneDestinationError('path exists and is not a directory')
  }
  if (readdirSync(destination).length > 0) {
    throw new CloneDestinationError('path exists and is not empty')
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class CloneStore {
  constructor(private readonly db: CloneStoreDatabase) {}

  private row(id: string): CloneRow | undefined {
    return this.db.prepare('SELECT * FROM clone_tasks WHERE id = ?').get(id) as CloneRow | undefined
  }

  /** Parse input against a shared schema; wrap zod rejects as a typed error. */
  private parseOrThrow(
    schema: {
      safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: unknown }
    },
    data: unknown,
    context: string
  ): unknown {
    const result = schema.safeParse(data)
    if (result.success === false) {
      const detail =
        result.error instanceof Error ? result.error.message : JSON.stringify(result.error)
      throw new CloneValidationError(context, detail)
    }
    return result.data
  }

  /** Insert one queued attempt (attempt 1, no retry link). Validates FIRST. */
  createQueued(input: CloneCreateInput, now = new Date()): CloneRecord {
    const parsed = this.parseOrThrow(
      cloneCreateInputSchema,
      input,
      'invalid clone create input'
    ) as CloneCreateInput
    const id = randomUUID()
    const createdAt = now.toISOString()
    const proxy = parsed.proxy as ProxySnapshot
    this.db
      .prepare(
        `INSERT INTO clone_tasks (
           id, attempt, repo_kind, repo_id, revision_json, transport, destination,
           auth, account_id, account_label, proxy_mode, proxy_url, status, error_code, error,
           progress_phase, progress_percent, progress_done, progress_total,
           created_at, started_at, updated_at, completed_at, retry_of
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`
      )
      .run(
        id,
        1,
        parsed.kind,
        parsed.id,
        parsed.revision === undefined ? null : JSON.stringify(parsed.revision),
        parsed.transport,
        parsed.destination,
        parsed.auth,
        parsed.accountId ?? null,
        parsed.accountLabel ?? null,
        proxy.mode,
        proxy.mode === 'manual' ? proxy.url : null,
        'queued',
        null,
        null,
        null,
        0,
        0,
        0,
        createdAt,
        null,
        createdAt,
        null,
        null
      )
    return {
      id,
      attempt: 1,
      repoKind: parsed.kind,
      repoId: parsed.id,
      revision: parsed.revision,
      transport: parsed.transport,
      destination: parsed.destination,
      auth: parsed.auth,
      ...(parsed.accountId === undefined ? {} : { accountId: parsed.accountId }),
      ...(parsed.accountLabel === undefined ? {} : { accountLabel: parsed.accountLabel }),
      proxy,
      status: 'queued',
      createdAt,
      updatedAt: createdAt
    }
  }

  /**
   * Apply ONE transition from the legal matrix. This is the single enforcement
   * point for the state machine: the pair must be legal AND the row's actual
   * status must equal the pair's source. Entering `running`/`cancelling` is
   * additionally gated on at most one active clone. A reject rolls the whole
   * transaction back — nothing is ever partially persisted.
   */
  transition(
    id: string,
    to: CloneStatus,
    now = new Date(),
    extra: CloneTransitionExtra = {}
  ): CloneRecord {
    const updatedAt = now.toISOString()
    const row = this.db.transaction(() => {
      const current = this.row(id)
      if (current === undefined) {
        throw new CloneNotFoundError(id)
      }
      const from = current.status as CloneStatus
      const allowed = CLONE_TRANSITION_MATRIX[from]
      if (allowed.includes(to) === false) {
        throw new IllegalCloneTransitionError(id, from, to)
      }
      if (to === 'running' || to === 'cancelling') {
        const otherActive = this.db
          .prepare(
            "SELECT id FROM clone_tasks WHERE status IN ('running', 'cancelling') AND id != ? LIMIT 1"
          )
          .get(id)
        if (otherActive !== undefined && otherActive !== null) {
          throw new ActiveCloneExistsError()
        }
      }
      const startedAt = to === 'running' ? updatedAt : (current.started_at ?? null)
      const completedAt = CLONE_TERMINAL_STATUSES.includes(to)
        ? updatedAt
        : (current.completed_at ?? null)
      const errorCode =
        extra.errorCode === undefined ? (current.error_code ?? null) : extra.errorCode
      const error = extra.error === undefined ? (current.error ?? null) : extra.error
      const progressPhase = extra.clearProgress ? null : (current.progress_phase ?? null)
      const progressPercent = extra.clearProgress ? 0 : current.progress_percent
      const progressDone = extra.clearProgress ? 0 : current.progress_done
      const progressTotal = extra.clearProgress ? 0 : current.progress_total
      this.db
        .prepare(
          `UPDATE clone_tasks SET
             status = ?, started_at = ?, updated_at = ?, completed_at = ?,
             error_code = ?, error = ?,
             progress_phase = ?, progress_percent = ?, progress_done = ?, progress_total = ?
           WHERE id = ?`
        )
        .run(
          to,
          startedAt,
          updatedAt,
          completedAt,
          errorCode,
          error,
          progressPhase,
          progressPercent,
          progressDone,
          progressTotal,
          id
        )
      return this.row(id)
    })()
    return this.mapRow(row)
  }

  /** queued -> running. Enforces the single-active invariant. */
  start(id: string, now = new Date()): CloneRecord {
    return this.transition(id, 'running', now)
  }

  /** queued -> cancelled (cancel before any worker). */
  cancelQueued(id: string, now = new Date()): CloneRecord {
    return this.transition(id, 'cancelled', now)
  }

  /** running -> cancelling (cooperative cancel of a live worker). */
  requestCancel(id: string, now = new Date()): CloneRecord {
    return this.transition(id, 'cancelling', now)
  }

  /** cancelling -> cancelled (worker confirmed the cancel). */
  finishCancelled(id: string, now = new Date()): CloneRecord {
    return this.transition(id, 'cancelled', now)
  }

  /** running -> completed; clears error and progress. */
  complete(id: string, now = new Date()): CloneRecord {
    return this.transition(id, 'completed', now, {
      errorCode: null,
      error: null,
      clearProgress: true
    })
  }

  /** running -> failed with a validated, bounded, sanitized failure detail. */
  fail(id: string, input: CloneFailureInput, now = new Date()): CloneRecord {
    const parsed = this.parseOrThrow(
      cloneFailureInputSchema,
      input,
      'invalid clone failure input'
    ) as CloneFailureInput
    return this.transition(id, 'failed', now, {
      errorCode: parsed.errorCode ?? null,
      error: parsed.error ?? null
    })
  }

  /**
   * Startup recovery: every row still running or cancelling — the app was
   * killed mid-flight — becomes `interrupted`. Queued, terminal, and newly
   * created rows are untouched. Idempotent: a second call finds no active
   * rows and changes nothing.
   */
  recoverInterrupted(now = new Date()): CloneRecord[] {
    const updatedAt = now.toISOString()
    const rows = this.db.transaction(() => {
      const active = this.db
        .prepare(
          "SELECT * FROM clone_tasks WHERE status IN ('running', 'cancelling') ORDER BY created_at, id"
        )
        .all() as CloneRow[]
      const changed: CloneRow[] = []
      for (const row of active) {
        this.db
          .prepare(
            "UPDATE clone_tasks SET status = 'interrupted', updated_at = ?, completed_at = ? WHERE id = ?"
          )
          .run(updatedAt, updatedAt, row.id)
        const updated = this.row(row.id)
        if (updated !== undefined) changed.push(updated)
      }
      return changed
    })()
    return rows.map((row) => this.mapRow(row))
  }

  /**
   * Retry ONLY from failed/cancelled/interrupted: inserts a fresh queued row
   * (new UUID, attempt = parent + 1, retry_of = parent id, same repo/revision/
   * transport/auth plus a NEW destination) inside one transaction. The
   * destination must be absent or an empty directory — a nonempty or partial
   * path rejects transactionally and persists nothing. The parent row stays
   * terminal and immutable.
   */
  retry(
    id: string,
    input: CloneCreateInput,
    now = new Date(),
    options: { destinationAvailable?: (destination: string) => void } = {}
  ): CloneRecord {
    const parentBeforeValidation = this.row(id)
    if (parentBeforeValidation === undefined) throw new CloneNotFoundError(id)
    const parsed = this.parseOrThrow(
      cloneCreateInputSchema,
      {
        ...input,
        ...(input.accountId === undefined && parentBeforeValidation.account_id !== null
          ? { accountId: parentBeforeValidation.account_id }
          : {}),
        ...(input.accountLabel === undefined && parentBeforeValidation.account_label !== null
          ? { accountLabel: parentBeforeValidation.account_label }
          : {})
      },
      'invalid clone retry input'
    ) as CloneCreateInput
    const createdAt = now.toISOString()
    const check = options.destinationAvailable ?? defaultDestinationAvailable
    const row = this.db.transaction(() => {
      const parent = this.row(id)
      if (parent === undefined) {
        throw new CloneNotFoundError(id)
      }
      if (CLONE_RETRYABLE_STATUSES.includes(parent.status as CloneStatus) === false) {
        throw new IllegalCloneTransitionError(id, parent.status as CloneStatus, 'queued')
      }
      check(parsed.destination)
      const newId = randomUUID()
      const proxy = parsed.proxy as ProxySnapshot
      this.db
        .prepare(
          `INSERT INTO clone_tasks (
             id, attempt, repo_kind, repo_id, revision_json, transport, destination,
             auth, account_id, account_label, proxy_mode, proxy_url, status, error_code, error,
             progress_phase, progress_percent, progress_done, progress_total,
             created_at, started_at, updated_at, completed_at, retry_of
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`
        )
        .run(
          newId,
          Number(parent.attempt) + 1,
          parsed.kind,
          parsed.id,
          parsed.revision === undefined ? null : JSON.stringify(parsed.revision),
          parsed.transport,
          parsed.destination,
          parsed.auth,
          parsed.accountId ?? null,
          parsed.accountLabel ?? null,
          proxy.mode,
          proxy.mode === 'manual' ? proxy.url : null,
          'queued',
          null,
          null,
          null,
          0,
          0,
          0,
          createdAt,
          null,
          createdAt,
          null,
          id
        )
      const created = this.row(newId)
      if (created === undefined) throw new CloneNotFoundError(newId)
      return created
    })()
    return this.mapRow(row)
  }

  /**
   * Delete one terminal queue record. Detaches direct retry children so the
   * self-referencing `retry_of` FK (no ON DELETE) cannot fail, then deletes
   * the selected row. Never touches destination files. Active/queued rows
   * are rejected — removal is not a status transition.
   */
  removeTerminal(id: string): CloneRecord[] {
    return this.db.transaction(() => {
      const current = this.row(id)
      if (current === undefined) {
        throw new CloneNotFoundError(id)
      }
      if (CLONE_TERMINAL_STATUSES.includes(current.status as CloneStatus) === false) {
        throw new CloneStoreError(`cannot remove clone ${id} in status ${current.status}`)
      }
      this.db.prepare('UPDATE clone_tasks SET retry_of = NULL WHERE retry_of = ?').run(id)
      this.db.prepare('DELETE FROM clone_tasks WHERE id = ?').run(id)
      return this.list()
    })()
  }

  /** Persist frozen progress for a running/cancelling attempt. */
  updateProgress(id: string, progress: CloneProgress, now = new Date()): CloneRecord {
    const parsed = this.parseOrThrow(
      cloneProgressSchema,
      progress,
      'invalid clone progress'
    ) as CloneProgress
    const updatedAt = now.toISOString()
    const row = this.db.transaction(() => {
      const current = this.db.prepare('SELECT status FROM clone_tasks WHERE id = ?').get(id) as
        | {
            status: string
          }
        | undefined
      if (current === undefined) {
        throw new CloneNotFoundError(id)
      }
      const status = current.status as CloneStatus
      if (status !== 'running' && status !== 'cancelling') {
        throw new CloneProgressError(`cannot record progress for clone ${id} in status ${status}`)
      }
      this.db
        .prepare(
          `UPDATE clone_tasks SET
             progress_phase = ?, progress_percent = ?, progress_done = ?, progress_total = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(parsed.phase, parsed.percent, parsed.done, parsed.total, updatedAt, id)
      return this.db.prepare('SELECT * FROM clone_tasks WHERE id = ?').get(id)
    })()
    return this.mapRow(row)
  }

  /** Oldest queued attempt in FIFO order (created_at, id); null when none. */
  nextQueued(): CloneRecord | null {
    const row = this.db
      .prepare("SELECT * FROM clone_tasks WHERE status = 'queued' ORDER BY created_at, id LIMIT 1")
      .get()
    return row === undefined || row === null ? null : this.mapRow(row)
  }

  /** True when a clone is running or cancelling (at most one, by invariant). */
  hasActive(): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM clone_tasks WHERE status IN ('running', 'cancelling') LIMIT 1")
        .get()
    )
  }

  /** Number of rows currently running or cancelling (invariant cap: 1). */
  activeCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM clone_tasks WHERE status IN ('running', 'cancelling')")
      .get() as { n: number }
    return Number(row.n)
  }

  accountUsage(accountId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM clone_tasks WHERE account_id = ? AND auth = 'app-token' AND status IN ('queued', 'running', 'cancelling', 'failed', 'cancelled', 'interrupted')"
      )
      .get(accountId) as { n: number }
    return Number(row.n)
  }

  /** Every attempt in deterministic FIFO order (created_at, id). */
  list(): CloneRecord[] {
    const rows = this.db.prepare('SELECT * FROM clone_tasks ORDER BY created_at, id').all()
    return rows.map((row) => this.mapRow(row))
  }

  get(id: string): CloneRecord | undefined {
    const row = this.db.prepare('SELECT * FROM clone_tasks WHERE id = ?').get(id)
    return row === undefined || row === null ? undefined : this.mapRow(row)
  }

  /** Map a raw row to a strict CloneRecord; refuse anything schema-invalid. */
  private mapRow(row: unknown): CloneRecord {
    const raw = row as CloneRow
    let revision: CloneRevision | undefined
    if (raw.revision_json !== null && raw.revision_json !== undefined) {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(raw.revision_json) as unknown
      } catch {
        throw new CorruptCloneRecordError(raw.id, 'revision_json is not valid JSON')
      }
      const parsedRevision = cloneRevisionSchema.safeParse(parsedJson)
      if (parsedRevision.success === false) {
        throw new CorruptCloneRecordError(raw.id, 'revision_json is not a valid clone revision')
      }
      revision = parsedRevision.data
    }
    const proxy: ProxySnapshot =
      raw.proxy_mode === 'manual'
        ? { mode: 'manual', url: raw.proxy_url ?? '' }
        : raw.proxy_mode === 'system'
          ? { mode: 'system' }
          : { mode: 'direct' }
    const record: CloneRecord = {
      id: raw.id,
      attempt: Number(raw.attempt),
      repoKind: raw.repo_kind as CloneRecord['repoKind'],
      repoId: raw.repo_id,
      revision,
      transport: raw.transport as CloneRecord['transport'],
      destination: raw.destination,
      auth: raw.auth as CloneRecord['auth'],
      ...(raw.account_id == null ? {} : { accountId: raw.account_id }),
      ...(raw.account_label == null ? {} : { accountLabel: raw.account_label }),
      proxy,
      status: raw.status as CloneStatus,
      progress:
        raw.progress_phase !== null && raw.progress_phase !== undefined
          ? {
              phase: raw.progress_phase as CloneProgress['phase'],
              percent: Number(raw.progress_percent),
              done: Number(raw.progress_done),
              total: Number(raw.progress_total)
            }
          : undefined,
      error: (raw.error ?? undefined) as string | undefined,
      createdAt: raw.created_at,
      startedAt: (raw.started_at ?? undefined) as string | undefined,
      updatedAt: raw.updated_at,
      completedAt: (raw.completed_at ?? undefined) as string | undefined,
      retryOf: (raw.retry_of ?? undefined) as string | undefined
    }
    const validated = cloneRecordSchema.safeParse(record)
    if (validated.success === false) {
      throw new CorruptCloneRecordError(raw.id, 'row does not satisfy the clone record schema')
    }
    return validated.data
  }
}
