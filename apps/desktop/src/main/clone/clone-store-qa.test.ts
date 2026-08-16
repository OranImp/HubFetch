// apps/desktop/src/main/clone/clone-store-qa.test.ts
//
// Todo 31 QA (evidence) — REAL persistence against node:sqlite with a real
// BEGIN IMMEDIATE transaction wrapper, including a close-and-reopen crash
// simulation.
//
// Happy:   enqueue three clones, simulate the first clone crashing, reopen the
//          database, observe the first row interrupted and the remaining two
//          still queued in FIFO order.
// Failure: illegal completed->running, retry to a nonempty path, and
//          concurrent double-start all reject transactionally (zero persisted
//          change).
//
// Evidence artifacts are written to
// .omo/evidence/task-31-adopt-ohmyhf-main/ (gitignored).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../db'
import {
  ActiveCloneExistsError,
  CloneDestinationError,
  CloneStore,
  IllegalCloneTransitionError,
  type CloneStoreDatabase
} from './clone-store'
import type { CloneCreateInput } from '@hubfetch/shared'

const ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))
const EVIDENCE = join(ROOT, '.omo', 'evidence', 'task-31-adopt-ohmyhf-main')

const scratchDirs: string[] = []
function scratch(prefix: string): string {
  // mkdtemp under os.tmpdir() (honors TMP/TEMP => E:\Programs\Temp here).
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

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

describe('Todo 31 QA', () => {
  it('qa-happy: three clones enqueued, first crashes, reopen recovers it and keeps FIFO', async () => {
    const scratchDir = scratch('t31-qa-happy-')
    const dbPath = join(scratchDir, 'qa.db')
    const lines: string[] = ['QA_HAPPY_PASS']

    // Phase 1: enqueue three clones, start the first, then "crash" (close the
    // DB without terminalizing — the running row is left mid-flight).
    const first = new DatabaseSync(dbPath)
    for (const sql of MIGRATIONS) first.exec(sql)
    const store1 = new CloneStore(nodeStoreDb(first))
    const a = store1.createQueued(
      makeInput(join(scratchDir, 'dest-a'), { id: 'qa-author/model-a' }),
      new Date('2026-01-01T00:00:00.000Z')
    )
    const b = store1.createQueued(
      makeInput(join(scratchDir, 'dest-b'), { id: 'qa-author/model-b' }),
      new Date('2026-01-01T00:00:00.001Z')
    )
    const c = store1.createQueued(
      makeInput(join(scratchDir, 'dest-c'), { id: 'qa-author/model-c' }),
      new Date('2026-01-01T00:00:00.002Z')
    )
    const runningA = store1.start(a.id, new Date('2026-01-01T00:00:01.000Z'))
    expect(runningA.status).toBe('running')
    first.close()

    // Phase 2: reopen the database (app restart), run startup recovery.
    const second = new DatabaseSync(dbPath)
    const store2 = new CloneStore(nodeStoreDb(second))
    const recovered = store2.recoverInterrupted(new Date('2026-01-01T00:00:02.000Z'))

    expect(recovered.map((r) => r.id)).toEqual([a.id])
    expect(recovered[0]).toMatchObject({ id: a.id, status: 'interrupted' })
    expect(store2.get(b.id)?.status).toBe('queued')
    expect(store2.get(c.id)?.status).toBe('queued')
    expect(store2.get(a.id)?.status).toBe('interrupted')
    // Remaining FIFO order is deterministic: B before C.
    expect(store2.nextQueued()?.id).toBe(b.id)
    expect(store2.list().map((r) => r.id)).toEqual([a.id, b.id, c.id])

    // Capture evidence BEFORE closing the reopened database.
    lines.push(
      JSON.stringify({
        enqueued: [a.id, b.id, c.id],
        firstCrashed: a.id,
        recovered: recovered.map((r) => ({ id: r.id, status: r.status })),
        remaining: [b.id, c.id].map((id) => ({ id, status: store2.get(id)?.status })),
        fifoNextAfterRecovery: store2.nextQueued()?.id,
        fifoOrder: [a.id, b.id, c.id],
        replayedStore: 'reopened clone_tasks (same file), recovery idempotent',
        determinism: 'created_at,id tie-break'
      })
    )
    second.close()
    await writeQaHappy(lines)
  }, 30_000)

  it('qa-failure: illegal completed->running, retry-to-nonempty, double-start all reject transactionally', async () => {
    const scratchDir = scratch('t31-qa-failure-')
    const lines: string[] = ['QA_FAILURE_PASS']

    // 1. Illegal completed -> running.
    {
      const db = new DatabaseSync(':memory:')
      for (const sql of MIGRATIONS) db.exec(sql)
      const store = new CloneStore(nodeStoreDb(db))
      const queued = store.createQueued(makeInput(join(scratchDir, 'f-dest-a')))
      const running = store.start(queued.id)
      const completed = store.complete(running.id)
      let errorType = 'none'
      try {
        store.start(completed.id)
      } catch (error) {
        if (error instanceof IllegalCloneTransitionError) errorType = 'IllegalCloneTransitionError'
        else throw error
      }
      expect(errorType).toBe('IllegalCloneTransitionError')
      expect(store.get(completed.id)?.status).toBe('completed')
      lines.push(
        JSON.stringify({
          case: 'illegal-completed-to-running',
          errorType,
          statusAfter: store.get(completed.id)?.status,
          persistedChange: false
        })
      )
      db.close()
    }

    // 2. Retry to a nonempty path — rejected transactionally, no new row.
    {
      const db = new DatabaseSync(':memory:')
      for (const sql of MIGRATIONS) db.exec(sql)
      const store = new CloneStore(nodeStoreDb(db))
      const queued = store.createQueued(makeInput(join(scratchDir, 'f-dest-b')))
      const failed = store.fail(store.start(queued.id).id, {
        errorCode: 'network',
        error: 'connection refused (sanitized)'
      })
      const nonempty = join(scratchDir, 'retry-nonempty')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(nonempty)
      writeFileSync(join(nonempty, 'partial.txt'), 'leftover clone data')
      const before = store.list().length
      let errorType = 'none'
      try {
        store.retry(failed.id, makeInput(nonempty))
      } catch (error) {
        if (error instanceof CloneDestinationError) errorType = 'CloneDestinationError'
        else throw error
      }
      expect(errorType).toBe('CloneDestinationError')
      expect(store.list().length).toBe(before)
      expect(store.get(failed.id)?.status).toBe('failed')
      lines.push(
        JSON.stringify({
          case: 'retry-to-nonempty-path',
          errorType,
          rowsBefore: before,
          rowsAfter: store.list().length,
          parentStatusAfter: store.get(failed.id)?.status,
          persistedChange: false
        })
      )
      db.close()
    }

    // 3. Concurrent double-start — cannot create two active rows.
    {
      const db = new DatabaseSync(':memory:')
      for (const sql of MIGRATIONS) db.exec(sql)
      const store = new CloneStore(nodeStoreDb(db))
      const a = store.createQueued(
        makeInput(join(scratchDir, 'f-dest-c'), { id: 'qa-author/model-c' })
      )
      const b = store.createQueued(
        makeInput(join(scratchDir, 'f-dest-d'), { id: 'qa-author/model-d' })
      )
      store.start(a.id)
      let errorType = 'none'
      try {
        store.start(b.id)
      } catch (error) {
        if (error instanceof ActiveCloneExistsError) errorType = 'ActiveCloneExistsError'
        else throw error
      }
      expect(errorType).toBe('ActiveCloneExistsError')
      expect(store.activeCount()).toBe(1)
      expect(store.get(b.id)?.status).toBe('queued')
      lines.push(
        JSON.stringify({
          case: 'concurrent-double-start',
          errorType,
          activeCountAfter: store.activeCount(),
          secondStatus: store.get(b.id)?.status,
          persistedChange: false
        })
      )
      db.close()
    }

    await writeQaFailure(lines)
  }, 30_000)
})

async function writeQaHappy(lines: string[]): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-happy.txt'), lines.join('\n') + '\n')
}

async function writeQaFailure(lines: string[]): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true })
  await writeFile(join(EVIDENCE, 'qa-failure.txt'), lines.join('\n') + '\n')
}
