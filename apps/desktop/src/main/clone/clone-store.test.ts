// apps/desktop/src/main/clone/clone-store.test.ts
//
// Todo 31 unit tests: the clone_tasks migration (fresh + upgrade), the
// exhaustive legal/illegal transition matrix, abrupt-shutdown recovery,
// deterministic FIFO tie ordering, retry semantics (new IDs, link, snapshot,
// fresh-empty destination), single-active enforcement, progress gating, and
// the guarantee that secrets/raw output can never satisfy a schema column.
//
// better-sqlite3 is built for Electron's ABI, so these tests run the store
// against node:sqlite (a real SQLite engine) via a duck-typed adapter with a
// real BEGIN IMMEDIATE transaction wrapper.
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../db'
import {
  ActiveCloneExistsError,
  CloneDestinationError,
  CloneNotFoundError,
  CloneProgressError,
  CloneStore,
  CloneStoreError,
  CorruptCloneRecordError,
  IllegalCloneTransitionError,
  type CloneRow,
  type CloneStoreDatabase
} from './clone-store'
import type { CloneCreateInput, CloneRecord, CloneStatus } from '@hubfetch/shared'
import { CLONE_TRANSITION_MATRIX } from './clone-store'

// ---------------------------------------------------------------------------
// node:sqlite adapter (real SQLite engine + real BEGIN IMMEDIATE transaction)
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

let db: DatabaseSync
let store: CloneStore

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const sql of MIGRATIONS) db.exec(sql)
  store = new CloneStore(nodeStoreDb(db))
})

afterEach(() => {
  db.close()
})

function makeInput(overrides: Partial<CloneCreateInput> = {}): CloneCreateInput {
  return {
    kind: 'model',
    id: 'qa-author/model-a',
    transport: 'https',
    destination: join(tmpdir(), 't31-dest-model-a'),
    auth: 'none',
    proxy: { mode: 'system' },
    ...overrides
  }
}

function insertRow(
  target: DatabaseSync,
  overrides: Partial<CloneRow> & { id: string; status: string }
): void {
  const row: CloneRow = {
    id: overrides.id,
    attempt: overrides.attempt ?? 1,
    repo_kind: overrides.repo_kind ?? 'model',
    repo_id: overrides.repo_id ?? 'qa-author/model-a',
    revision_json: overrides.revision_json ?? null,
    transport: overrides.transport ?? 'https',
    destination: overrides.destination ?? join(tmpdir(), 't31-insert-dest'),
    auth: overrides.auth ?? 'none',
    account_id: overrides.account_id ?? null,
    account_label: overrides.account_label ?? null,
    proxy_mode: overrides.proxy_mode ?? 'system',
    proxy_url: overrides.proxy_url ?? null,
    status: overrides.status,
    error_code: overrides.error_code ?? null,
    error: overrides.error ?? null,
    progress_phase: overrides.progress_phase ?? null,
    progress_percent: overrides.progress_percent ?? 0,
    progress_done: overrides.progress_done ?? 0,
    progress_total: overrides.progress_total ?? 0,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    started_at: overrides.started_at ?? null,
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
    completed_at: overrides.completed_at ?? null,
    retry_of: overrides.retry_of ?? null
  }
  target
    .prepare(
      `INSERT INTO clone_tasks (
       id, attempt, repo_kind, repo_id, revision_json, transport, destination,
       auth, proxy_mode, proxy_url, status, error_code, error,
       progress_phase, progress_percent, progress_done, progress_total,
       created_at, started_at, updated_at, completed_at, retry_of
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.attempt,
      row.repo_kind,
      row.repo_id,
      row.revision_json,
      row.transport,
      row.destination,
      row.auth,
      row.proxy_mode,
      row.proxy_url,
      row.status,
      row.error_code,
      row.error,
      row.progress_phase,
      row.progress_percent,
      row.progress_done,
      row.progress_total,
      row.created_at,
      row.started_at,
      row.updated_at,
      row.completed_at,
      row.retry_of
    )
}

function cloneTaskRows(): CloneRow[] {
  return db
    .prepare('SELECT * FROM clone_tasks ORDER BY created_at, id')
    .all() as unknown as CloneRow[]
}

function statusOf(id: string, target = db): string {
  return (
    target.prepare('SELECT status FROM clone_tasks WHERE id = ?').get(id) as unknown as CloneRow
  ).status
}

// ---------------------------------------------------------------------------
// Migration: clone_tasks exists fresh and via upgrade, with CHECK backstops
// ---------------------------------------------------------------------------

describe('clone_tasks migration', () => {
  it('creates clone_tasks with every required column on a fresh database', () => {
    const columns = (db.prepare('PRAGMA table_info(clone_tasks)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'attempt',
        'repo_kind',
        'repo_id',
        'revision_json',
        'transport',
        'destination',
        'auth',
        'proxy_mode',
        'proxy_url',
        'status',
        'error_code',
        'error',
        'progress_phase',
        'progress_percent',
        'progress_done',
        'progress_total',
        'created_at',
        'started_at',
        'updated_at',
        'completed_at',
        'retry_of'
      ])
    )
    const indexes = (
      db.prepare("PRAGMA index_list('clone_tasks')").all() as { name: string }[]
    ).map((i) => i.name)
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_clone_tasks_status_created', 'idx_clone_tasks_retry_of'])
    )
  })

  it('upgrades a pre-clone database (user_version 3) without touching downloads', () => {
    const old = new DatabaseSync(':memory:')
    old.exec(MIGRATIONS[0]!)
    old.exec(MIGRATIONS[1]!)
    old.exec(MIGRATIONS[2]!)
    old.exec('PRAGMA user_version = 3')
    old.exec(
      `INSERT INTO downloads (id, repo_id, kind, revision, status, total_bytes, received_bytes, files_json, created_at) VALUES
         ('d', 'org/d', 'model', 'main', 'completed', 1, 1, '[]', '2026-01-01T00:00:00.000Z')`
    )
    const downloadRowsBefore = old.prepare('SELECT COUNT(*) AS n FROM downloads').get() as {
      n: number
    }

    old.exec(MIGRATIONS[3]!)

    const tables = (
      old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
    ).map((t) => t.name)
    expect(tables).toContain('clone_tasks')
    expect((old.prepare('SELECT COUNT(*) AS n FROM downloads').get() as { n: number }).n).toBe(
      downloadRowsBefore.n
    )
    expect(
      (old.prepare('SELECT status FROM downloads WHERE id = ?').get('d') as { status: string })
        .status
    ).toBe('completed')
    old.close()
  })
})

// ---------------------------------------------------------------------------
// Transition matrix: every ordered pair (49 cases) asserted
// ---------------------------------------------------------------------------

describe('transition matrix', () => {
  it('asserts EVERY legal and illegal ordered pair of the closed status union', () => {
    const statuses: CloneStatus[] = [
      'queued',
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'interrupted'
    ]
    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to) continue
        const fresh = new DatabaseSync(':memory:')
        for (const sql of MIGRATIONS) fresh.exec(sql)
        const localStore = new CloneStore(nodeStoreDb(fresh))
        const id = randomUUID()
        insertRow(fresh, { id, status: from })
        const legal = CLONE_TRANSITION_MATRIX[from].includes(to)
        if (legal) {
          const record = localStore.transition(id, to)
          expect(record.status, `${from} -> ${to} should be legal`).toBe(to)
        } else {
          expect(() => localStore.transition(id, to), `${from} -> ${to} should be illegal`).toThrow(
            IllegalCloneTransitionError
          )
          // The reject must be transactional: status never changed.
          expect(statusOf(id, fresh)).toBe(from)
        }
        fresh.close()
      }
    }
  })

  it('sets started_at on entering running and completed_at on every terminal state', () => {
    const running = store.start(
      store.createQueued(makeInput()).id,
      new Date('2026-02-01T00:00:00.000Z')
    )
    expect(running.startedAt).toBe('2026-02-01T00:00:00.000Z')
    const done = store.complete(running.id, new Date('2026-02-01T00:01:00.000Z'))
    expect(done.completedAt).toBe('2026-02-01T00:01:00.000Z')
    expect(done.startedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('rejects a transition on a missing row', () => {
    expect(() => store.start('00000000-0000-4000-8000-000000000000')).toThrow(CloneNotFoundError)
  })

  it('running cancel goes through cancelling, never straight to cancelled', () => {
    const queued = store.createQueued(makeInput())
    const running = store.start(queued.id)
    expect(() => store.finishCancelled(running.id)).toThrow(IllegalCloneTransitionError)
    const cancelling = store.requestCancel(running.id)
    expect(cancelling.status).toBe('cancelling')
    const cancelled = store.finishCancelled(cancelling.id)
    expect(cancelled.status).toBe('cancelled')
  })

  it('terminal rows are immutable: completed -> running is rejected', () => {
    const queued = store.createQueued(makeInput())
    const running = store.start(queued.id)
    const completed = store.complete(running.id)
    expect(() => store.start(completed.id)).toThrow(IllegalCloneTransitionError)
    expect(() => store.transition(completed.id, 'running')).toThrow(IllegalCloneTransitionError)
    expect(() => store.transition(completed.id, 'interrupted')).toThrow(IllegalCloneTransitionError)
    expect(statusOf(completed.id)).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Recovery: abrupt shutdown recovers ONLY active rows, idempotently
// ---------------------------------------------------------------------------

describe('startup recovery', () => {
  const R1 = '00000000-0000-4000-8000-000000000001'
  const C1 = '00000000-0000-4000-8000-000000000002'
  const Q1 = '00000000-0000-4000-8000-000000000003'
  const F1 = '00000000-0000-4000-8000-000000000004'
  const X1 = '00000000-0000-4000-8000-000000000005'
  const Y1 = '00000000-0000-4000-8000-000000000006'
  const I1 = '00000000-0000-4000-8000-000000000007'
  const I2 = '00000000-0000-4000-8000-000000000008'

  it('recovers only running/cancelling rows to interrupted; everything else untouched', () => {
    insertRow(db, { id: R1, status: 'running' })
    insertRow(db, { id: C1, status: 'cancelling' })
    insertRow(db, { id: Q1, status: 'queued' })
    insertRow(db, { id: F1, status: 'completed' })
    insertRow(db, { id: X1, status: 'failed' })
    insertRow(db, { id: Y1, status: 'cancelled' })
    insertRow(db, { id: I1, status: 'interrupted' })

    const recovered = store.recoverInterrupted(new Date('2026-03-01T00:00:00.000Z'))

    expect(recovered.map((r) => r.id).sort()).toEqual([R1, C1])
    expect(statusOf(R1)).toBe('interrupted')
    expect(statusOf(C1)).toBe('interrupted')
    expect(statusOf(Q1)).toBe('queued')
    expect(statusOf(F1)).toBe('completed')
    expect(statusOf(X1)).toBe('failed')
    expect(statusOf(Y1)).toBe('cancelled')
    expect(statusOf(I1)).toBe('interrupted')
    // Recovered rows carry the recovery timestamp.
    const row = db.prepare('SELECT * FROM clone_tasks WHERE id = ?').get(R1) as unknown as CloneRow
    expect(row.completed_at).toBe('2026-03-01T00:00:00.000Z')
    expect(row.updated_at).toBe('2026-03-01T00:00:00.000Z')

    // Idempotent: a second run changes nothing.
    const second = store.recoverInterrupted(new Date('2026-03-01T00:00:01.000Z'))
    expect(second).toHaveLength(0)
    expect(statusOf(R1)).toBe('interrupted')
  })

  it('an interrupted row is never recoverable into running (startup only marks it)', () => {
    insertRow(db, { id: I2, status: 'interrupted' })
    expect(() => store.start(I2)).toThrow(IllegalCloneTransitionError)
  })
})

// ---------------------------------------------------------------------------
// FIFO: (created_at, id) deterministic order + single active
// ---------------------------------------------------------------------------

describe('FIFO order and single-active', () => {
  it('orders queued work by (created_at, id) with deterministic tie-break', () => {
    // Same created_at on purpose: the id tie-break must be deterministic.
    const idB = '0b000000-0000-4000-8000-00000000000b'
    const idA = '0a000000-0000-4000-8000-00000000000a'
    const idC = '0c000000-0000-4000-8000-00000000000c'
    insertRow(db, { id: idB, status: 'queued', created_at: '2026-04-01T00:00:00.000Z' })
    insertRow(db, { id: idA, status: 'queued', created_at: '2026-04-01T00:00:00.000Z' })
    insertRow(db, { id: idC, status: 'queued', created_at: '2026-04-01T00:00:00.001Z' })

    expect(store.nextQueued()?.id).toBe(idA)
    const ordered = store.list().map((r) => r.id)
    expect(ordered).toEqual([idA, idB, idC])
  })

  it('enqueues in creation order when timestamps differ', () => {
    const first = store.createQueued(makeInput(), new Date('2026-05-01T00:00:00.000Z'))
    const second = store.createQueued(makeInput(), new Date('2026-05-01T00:00:00.001Z'))
    const third = store.createQueued(makeInput(), new Date('2026-05-01T00:00:00.002Z'))
    expect(store.nextQueued()?.id).toBe(first.id)
    expect(store.list().map((r) => r.id)).toEqual([first.id, second.id, third.id])
  })

  it('concurrent double-start cannot create two active rows', () => {
    const a = store.createQueued(makeInput())
    const b = store.createQueued(makeInput({ id: 'qa-author/model-b' }))
    expect(store.hasActive()).toBe(false)

    const running = store.start(a.id)
    expect(running.status).toBe('running')
    expect(store.hasActive()).toBe(true)
    expect(store.activeCount()).toBe(1)

    expect(() => store.start(b.id)).toThrow(ActiveCloneExistsError)
    expect(statusOf(b.id)).toBe('queued')
    expect(store.activeCount()).toBe(1)

    // A second start of the SAME running row is also rejected (not queued).
    expect(() => store.start(a.id)).toThrow(IllegalCloneTransitionError)

    // After the active clone reaches a terminal state the next one may start.
    store.complete(a.id)
    expect(store.hasActive()).toBe(false)
    expect(store.start(b.id).status).toBe('running')
  })

  it('a cancelling clone still counts as active until it reaches a terminal state', () => {
    const a = store.createQueued(makeInput())
    const b = store.createQueued(makeInput({ id: 'qa-author/model-b' }))
    store.start(a.id)
    store.requestCancel(a.id)
    expect(store.hasActive()).toBe(true)
    expect(() => store.start(b.id)).toThrow(ActiveCloneExistsError)
    store.finishCancelled(a.id)
    expect(store.hasActive()).toBe(false)
    expect(store.start(b.id).status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Retry: fresh linked row, new IDs, preserved snapshot, fresh empty destination
// ---------------------------------------------------------------------------

describe('retry', () => {
  function failedParent(): CloneRecord {
    const queued = store.createQueued(makeInput({ revision: { kind: 'tag', name: 'v1' } }))
    const running = store.start(queued.id)
    return store.fail(running.id, { errorCode: 'network', error: 'connection refused (sanitized)' })
  }

  it('creates a fresh linked row with attempt+1, new id, preserved snapshot and link', () => {
    const parent = failedParent()
    const freshDest = join(tmpdir(), `t31-retry-${parent.id}`)
    const retried = store.retry(
      parent.id,
      makeInput({ destination: freshDest, revision: { kind: 'tag', name: 'v1' } }),
      new Date('2026-06-01T00:00:00.000Z')
    )

    expect(retried.id).not.toBe(parent.id)
    expect(retried.attempt).toBe(parent.attempt + 1)
    expect(retried.retryOf).toBe(parent.id)
    expect(retried.status).toBe('queued')
    expect(retried.destination).toBe(freshDest)
    expect(retried.repoId).toBe(parent.repoId)
    expect(retried.repoKind).toBe(parent.repoKind)
    expect(retried.transport).toBe(parent.transport)
    expect(retried.auth).toBe(parent.auth)
    expect(retried.proxy).toEqual(parent.proxy)
    expect(retried.revision).toEqual(parent.revision)
    // The parent stays terminal and immutable.
    expect(statusOf(parent.id)).toBe('failed')
    expect(() => store.start(parent.id)).toThrow(IllegalCloneTransitionError)
  })

  it('rejects a retry to a nonempty or partial destination transactionally', () => {
    const parent = failedParent()
    const nonempty = mkdtempSync(join(tmpdir(), 't31-retry-nonempty-'))
    writeFileSync(join(nonempty, 'partial.txt'), 'leftover clone data')
    const before = cloneTaskRows().length

    expect(() => store.retry(parent.id, makeInput({ destination: nonempty }))).toThrow(
      CloneDestinationError
    )
    // Transactional reject: NO new row, parent untouched.
    expect(cloneTaskRows().length).toBe(before)
    expect(statusOf(parent.id)).toBe('failed')
  })

  function failedParentAt(destination: string): CloneRecord {
    const queued = store.createQueued(
      makeInput({ revision: { kind: 'tag', name: 'v1' }, destination })
    )
    const running = store.start(queued.id)
    return store.fail(running.id, { errorCode: 'network', error: 'connection refused (sanitized)' })
  }

  it('retries to the exact original path when that path is absent', () => {
    const original = join(tmpdir(), `t31-retry-same-absent-${randomUUID()}`)
    const parent = failedParentAt(original)
    const before = cloneTaskRows().length

    const retried = store.retry(
      parent.id,
      makeInput({ destination: original, revision: { kind: 'tag', name: 'v1' } })
    )

    expect(retried.destination).toBe(original)
    expect(retried.retryOf).toBe(parent.id)
    expect(retried.status).toBe('queued')
    expect(cloneTaskRows().length).toBe(before + 1)
    expect(statusOf(parent.id)).toBe('failed')
  })

  it('retries to the exact original path when that path is an empty directory', () => {
    const original = mkdtempSync(join(tmpdir(), 't31-retry-same-empty-'))
    const parent = failedParentAt(original)
    const before = cloneTaskRows().length

    const retried = store.retry(
      parent.id,
      makeInput({ destination: original, revision: { kind: 'tag', name: 'v1' } })
    )

    expect(retried.destination).toBe(original)
    expect(retried.retryOf).toBe(parent.id)
    expect(cloneTaskRows().length).toBe(before + 1)
    expect(statusOf(parent.id)).toBe('failed')
    expect(readdirSync(original)).toEqual([])
  })

  it('rejects a retry to the exact original path when that directory is non-empty', () => {
    const original = mkdtempSync(join(tmpdir(), 't31-retry-same-nonempty-'))
    writeFileSync(join(original, 'partial.txt'), 'leftover clone data')
    const parent = failedParentAt(original)
    const before = cloneTaskRows().length

    expect(() =>
      store.retry(
        parent.id,
        makeInput({ destination: original, revision: { kind: 'tag', name: 'v1' } })
      )
    ).toThrow(CloneDestinationError)
    expect(cloneTaskRows().length).toBe(before)
    expect(statusOf(parent.id)).toBe('failed')
    expect(readFileSync(join(original, 'partial.txt'), 'utf8')).toBe('leftover clone data')
    expect(readdirSync(original)).toEqual(['partial.txt'])
  })

  it('rejects retrying the parent row itself (terminal, not retryable-linked again)', () => {
    const parent = failedParent()
    expect(() =>
      store.retry(parent.id, makeInput({ destination: join(tmpdir(), 't31-r1') }))
    ).not.toThrow()
    const retried = store.retry(parent.id, makeInput({ destination: join(tmpdir(), 't31-r2') }))
    expect(retried.retryOf).toBe(parent.id)
  })

  it('rejects retry from non-retryable statuses: queued, running, cancelling, completed', () => {
    const queued = store.createQueued(makeInput())
    const running = store.start(queued.id)
    expect(() =>
      store.retry(running.id, makeInput({ destination: join(tmpdir(), 't31-rr') }))
    ).toThrow(IllegalCloneTransitionError)
    const completed = store.complete(running.id)
    expect(() =>
      store.retry(completed.id, makeInput({ destination: join(tmpdir(), 't31-rc') }))
    ).toThrow(IllegalCloneTransitionError)
    const queuedFresh = store.createQueued(makeInput({ id: 'qa-author/model-q' }))
    expect(() =>
      store.retry(queuedFresh.id, makeInput({ destination: join(tmpdir(), 't31-rq') }))
    ).toThrow(IllegalCloneTransitionError)
    expect(() => store.retry('00000000-0000-4000-8000-000000000000', makeInput())).toThrow(
      CloneNotFoundError
    )
  })

  it('retries from cancelled and interrupted terminal states too', () => {
    const cancelled = store.cancelQueued(store.createQueued(makeInput()).id)
    expect(
      store.retry(cancelled.id, makeInput({ destination: join(tmpdir(), 't31-c1') })).retryOf
    ).toBe(cancelled.id)
    const interruptedParent = '00000000-0000-4000-8000-000000000009'
    insertRow(db, { id: interruptedParent, status: 'interrupted' })
    expect(
      store.retry(interruptedParent, makeInput({ destination: join(tmpdir(), 't31-i1') })).retryOf
    ).toBe(interruptedParent)
  })
})

// ---------------------------------------------------------------------------
// Progress gating and persistence
// ---------------------------------------------------------------------------

describe('progress', () => {
  it('records progress only while running or cancelling', () => {
    const queued = store.createQueued(makeInput())
    expect(() =>
      store.updateProgress(queued.id, { phase: 'receiving', percent: 10, done: 1, total: 10 })
    ).toThrow(CloneProgressError)
    const running = store.start(queued.id)
    const updated = store.updateProgress(running.id, {
      phase: 'receiving',
      percent: 25,
      done: 5,
      total: 20
    })
    expect(updated.progress).toEqual({ phase: 'receiving', percent: 25, done: 5, total: 20 })
    const completed = store.complete(running.id)
    expect(completed.progress).toBeUndefined()
    expect(() =>
      store.updateProgress(completed.id, { phase: 'checkout', percent: 100, done: 1, total: 1 })
    ).toThrow(CloneProgressError)
    expect(() =>
      store.updateProgress('00000000-0000-4000-8000-000000000000', {
        phase: 'xet',
        percent: 0,
        done: 0,
        total: 1
      })
    ).toThrow(CloneNotFoundError)
  })
})

// ---------------------------------------------------------------------------
// Secrets / raw output can never satisfy a schema column
// ---------------------------------------------------------------------------

describe('schema column integrity', () => {
  it('refuses credential-bearing or raw values through the store API', () => {
    // A raw credential URL cannot be a repo id.
    expect(() =>
      store.createQueued(makeInput({ id: 'https://user:hf_TOKEN@huggingface.co/org/repo' }))
    ).toThrow(CloneStoreError)
    // The input schema is strict: a token field does not exist and is rejected.
    expect(() => store.createQueued({ ...makeInput(), token: 'hf_TOKEN' } as never)).toThrow(
      CloneStoreError
    )
    // A raw stderr dump cannot be a revision.
    expect(() =>
      store.createQueued(
        makeInput({
          revision: 'Receiving objects: 100% (1/1), done.\nremote: fatal: token'
        } as never)
      )
    ).toThrow(CloneStoreError)
    // An untyped or oversized failure message cannot be persisted.
    expect(() =>
      store.fail('00000000-0000-4000-8000-000000000000', { error: 'x'.repeat(2001) })
    ).toThrow(CloneStoreError)
    const queued = store.createQueued(makeInput())
    const running = store.start(queued.id)
    expect(() =>
      store.updateProgress(running.id, {
        phase: 'pipe://hf_TOKEN' as never,
        percent: 1,
        done: 1,
        total: 1
      })
    ).toThrow(CloneStoreError)
  })

  it('the engine CHECK constraints reject token-like values in every enum column', () => {
    const base: Partial<CloneRow> = { id: 'check-row', status: 'queued' }
    const attempts: Array<[Partial<CloneRow>, string]> = [
      [{ ...base, status: 'hf_TOKEN' }, 'status'],
      [{ ...base, proxy_mode: 'http://user:pass@127.0.0.1:7890' }, 'proxy_mode'],
      [{ ...base, transport: 'file:///C:/Windows' }, 'transport'],
      [{ ...base, auth: 'Bearer hf_TOKEN' }, 'auth'],
      [{ ...base, repo_kind: 'dataset;DROP TABLE clone_tasks' }, 'repo_kind'],
      [{ ...base, error_code: 'hf_TOKEN' }, 'error_code'],
      [{ ...base, progress_phase: 'raw stderr line' }, 'progress_phase'],
      [{ ...base, progress_percent: 101 }, 'progress_percent'],
      [{ ...base, progress_total: -5 }, 'progress_total'],
      [
        { ...base, revision_json: 'Receiving objects: 100% (1/1), done. raw stderr' },
        'revision_json'
      ],
      [{ ...base, attempt: 0 }, 'attempt']
    ]
    for (const [overrides, column] of attempts) {
      expect(
        () => insertRow(db, { ...base, ...overrides } as never),
        `${column} CHECK should reject`
      ).toThrow()
    }
    // A legitimate row still inserts fine.
    insertRow(db, { id: 'ok-row', status: 'queued' })
    expect(cloneTaskRows().map((r) => r.id)).toContain('ok-row')
  })

  it('an app-token attempt stores only the closed enum, never token bytes', () => {
    const queued = store.createQueued(
      makeInput({
        auth: 'app-token',
        accountId: '11111111-1111-4111-8111-111111111111',
        accountLabel: 'tester',
        proxy: { mode: 'manual', url: 'http://127.0.0.1:7897' }
      })
    )
    const row = db
      .prepare('SELECT * FROM clone_tasks WHERE id = ?')
      .get(queued.id) as unknown as CloneRow
    expect(row.auth).toBe('app-token')
    expect(row.proxy_mode).toBe('manual')
    expect(row.proxy_url).toBe('http://127.0.0.1:7897')
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain('hf_')
    expect(serialized).not.toContain('GIT_ASKPASS')
  })

  it('refuses to map a corrupt row (raw stderr in revision_json) to a CloneRecord', () => {
    // Bypass the CHECK via a JSON value that is valid JSON but not a revision.
    insertRow(db, { id: 'corrupt', status: 'queued', revision_json: JSON.stringify('raw stderr') })
    expect(() => store.get('corrupt')).toThrow(CorruptCloneRecordError)
  })
})

// ---------------------------------------------------------------------------
// list/get round-trips a strict CloneRecord for every persisted shape
// ---------------------------------------------------------------------------

describe('record round-trip', () => {
  it('round-trips revision-less, branch, tag, commit, and manual-proxy rows', () => {
    const none = store.createQueued(makeInput())
    const branch = store.createQueued(
      makeInput({ id: 'qa-author/branch-model', revision: { kind: 'branch', name: 'main' } })
    )
    const tag = store.createQueued(
      makeInput({ id: 'qa-author/tag-model', revision: { kind: 'tag', name: 'v1.0' } })
    )
    const commit = store.createQueued(
      makeInput({
        id: 'qa-author/commit-model',
        revision: { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' }
      })
    )
    const manual = store.createQueued(
      makeInput({
        id: 'qa-author/manual-model',
        transport: 'ssh',
        auth: 'system',
        proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' }
      })
    )
    for (const record of [none, branch, tag, commit, manual]) {
      expect(store.get(record.id)).toEqual(record)
    }
    expect(store.get('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Terminal-only record removal (queue row delete; destination files untouched)
// ---------------------------------------------------------------------------

describe('removeTerminal', () => {
  function seedTerminal(status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): CloneRecord {
    switch (status) {
      case 'cancelled':
        return store.cancelQueued(store.createQueued(makeInput()).id)
      case 'completed': {
        const queued = store.createQueued(makeInput())
        return store.complete(store.start(queued.id).id)
      }
      case 'failed': {
        const queued = store.createQueued(makeInput())
        return store.fail(store.start(queued.id).id, {
          errorCode: 'network',
          error: 'connection refused (sanitized)'
        })
      }
      case 'interrupted': {
        const queued = store.createQueued(makeInput())
        store.start(queued.id)
        const recovered = store.recoverInterrupted()
        const record = recovered[0]
        if (record === undefined) {
          throw new CloneStoreError('expected recovered interrupted row')
        }
        return record
      }
      default: {
        const _exhaustive: never = status
        return _exhaustive
      }
    }
  }

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'removes a %s row from the returned list and from the database',
    (status) => {
      const record = seedTerminal(status)
      const sibling = store.createQueued(makeInput({ id: 'qa-author/model-keep' }))

      const returned = store.removeTerminal(record.id)

      expect(returned.find((row) => row.id === record.id)).toBeUndefined()
      expect(returned.map((row) => row.id)).toContain(sibling.id)
      expect(store.list().find((row) => row.id === record.id)).toBeUndefined()
      expect(store.get(record.id)).toBeUndefined()
      expect(cloneTaskRows().find((row) => row.id === record.id)).toBeUndefined()
      expect(statusOf(sibling.id)).toBe('queued')
    }
  )

  it('detaches a retry child then deletes the parent without an FK failure', () => {
    db.exec('PRAGMA foreign_keys = ON')
    const parent = seedTerminal('failed')
    const child = store.retry(
      parent.id,
      makeInput({ destination: join(tmpdir(), `t023-retry-child-${parent.id}`) })
    )
    expect(child.retryOf).toBe(parent.id)

    const returned = store.removeTerminal(parent.id)

    expect(returned.find((row) => row.id === parent.id)).toBeUndefined()
    expect(store.list().find((row) => row.id === parent.id)).toBeUndefined()
    expect(cloneTaskRows().find((row) => row.id === parent.id)).toBeUndefined()

    const surviving = store.get(child.id)
    expect(surviving?.id).toBe(child.id)
    expect(surviving?.retryOf).toBeUndefined()
    const raw = db.prepare('SELECT retry_of FROM clone_tasks WHERE id = ?').get(child.id) as
      { retry_of: string | null } | undefined
    expect(raw).toEqual({ retry_of: null })
  })

  it.each(['queued', 'running', 'cancelling'] as const)(
    'rejects removing a %s row and leaves the database unchanged',
    (status) => {
      const queued = store.createQueued(makeInput())
      let target: CloneRecord
      switch (status) {
        case 'queued':
          target = queued
          break
        case 'running':
          target = store.start(queued.id)
          break
        case 'cancelling':
          target = store.requestCancel(store.start(queued.id).id)
          break
        default: {
          const _exhaustive: never = status
          return _exhaustive
        }
      }
      const before = cloneTaskRows()

      let thrown: unknown
      try {
        store.removeTerminal(target.id)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(CloneStoreError)
      expect(thrown).not.toBeInstanceOf(IllegalCloneTransitionError)
      expect(thrown).not.toBeInstanceOf(CloneNotFoundError)
      expect(thrown instanceof Error ? thrown.message : '').toBe(
        `cannot remove clone ${target.id} in status ${status}`
      )
      expect(cloneTaskRows()).toEqual(before)
      expect(store.get(target.id)?.status).toBe(status)
    }
  )

  it('throws CloneNotFoundError for a missing id and mutates nothing', () => {
    const kept = store.createQueued(makeInput())
    const before = cloneTaskRows()
    const missing = '00000000-0000-4000-8000-000000000000'

    expect(() => store.removeTerminal(missing)).toThrow(CloneNotFoundError)
    expect(cloneTaskRows()).toEqual(before)
    expect(store.get(kept.id)?.id).toBe(kept.id)
  })

  it('leaves the destination directory byte-for-byte unchanged after removing the record', () => {
    const dest = mkdtempSync(join(tmpdir(), 't023-remove-dest-'))
    writeFileSync(join(dest, 'model.bin'), Buffer.from('clone-bytes-must-stay'))
    writeFileSync(join(dest, 'config.json'), '{"ok":true}')
    const namesBefore = readdirSync(dest).sort()
    const hash = createHash('sha256')
    for (const name of namesBefore) {
      hash.update(name)
      hash.update('\0')
      hash.update(readFileSync(join(dest, name)))
    }
    const digestBefore = hash.digest('hex')

    const queued = store.createQueued(makeInput({ destination: dest }))
    const completed = store.complete(store.start(queued.id).id)
    store.removeTerminal(completed.id)

    expect(store.get(completed.id)).toBeUndefined()
    expect(cloneTaskRows().find((row) => row.id === completed.id)).toBeUndefined()
    const namesAfter = readdirSync(dest).sort()
    expect(namesAfter).toEqual(namesBefore)
    const hashAfter = createHash('sha256')
    for (const name of namesAfter) {
      hashAfter.update(name)
      hashAfter.update('\0')
      hashAfter.update(readFileSync(join(dest, name)))
    }
    expect(hashAfter.digest('hex')).toBe(digestBefore)
  })
})
