import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, migrate, openDatabase } from './db'

/**
 * better-sqlite3 is built for Electron's ABI; vitest runs on system Node, so
 * orchestration (which migrations run, user_version bookkeeping, settings JSON
 * upgrade) is proven against a recording mock. The migration SQL itself is
 * executed against node:sqlite — a real SQLite engine — so the DDL and row
 * remapping are proven for real without the native module.
 */
const dbMock = vi.hoisted(() => {
  class MockDatabase {
    static instances: MockDatabase[] = []
    userVersion = 0
    execs: string[] = []
    kv = new Map<string, string>()

    constructor(_file: string) {
      MockDatabase.instances.push(this)
    }

    pragma(expr: string | { simple?: boolean }): number | void {
      if (typeof expr === 'string' && expr.startsWith('user_version =')) {
        this.userVersion = Number(expr.split('=')[1]?.trim())
        return undefined
      }
      return this.userVersion
    }

    exec(sql: string): void {
      this.execs.push(sql)
    }

    prepare(sql: string): {
      get: (...params: unknown[]) => { value: string } | undefined
      run: (...params: unknown[]) => void
      all: () => unknown[]
    } {
      return {
        get: (...params) => {
          const value = this.kv.get(params[0] as string)
          return value === undefined ? undefined : { value }
        },
        run: (...params) => {
          if (sql.includes('INSERT INTO kv')) {
            this.kv.set(params[0] as string, params[1] as string)
          } else if (sql.includes('UPDATE kv SET value')) {
            this.kv.set(params[1] as string, params[0] as string)
          }
        },
        all: () => []
      }
    }

    transaction<T>(fn: () => T): () => T {
      return () => fn()
    }
  }
  return { MockDatabase }
})

vi.mock('better-sqlite3', () => ({ default: dbMock.MockDatabase }))

function latestInstance(): InstanceType<typeof dbMock.MockDatabase> {
  return dbMock.MockDatabase.instances.at(-1)!
}

beforeEach(() => {
  dbMock.MockDatabase.instances = []
})

describe('openDatabase migration orchestration', () => {
  it('builds the full schema on a fresh database and ends at the latest version', () => {
    openDatabase(':memory:')
    const db = latestInstance()

    expect(db.userVersion).toBe(MIGRATIONS.length)
    // Every migration SQL ran in order, ending with the upload_tasks migration.
    expect(db.execs).toEqual([...MIGRATIONS])
    expect(db.execs.at(-1)).toContain('CREATE TABLE upload_tasks')
    expect(db.execs.at(-1)).toContain('CREATE INDEX idx_upload_tasks_status')
  })

  it('upgrades an upstream v2 fixture: runs the remaining migrations and remaps settings', () => {
    const db = new dbMock.MockDatabase(':memory:')
    db.userVersion = 2
    db.kv.set(
      'settings',
      JSON.stringify({ locale: 'en', theme: 'light', proxyUrl: 'http://127.0.0.1:7890' })
    )

    migrate(db as never)

    expect(db.userVersion).toBe(MIGRATIONS.length)
    expect(db.execs).toEqual([MIGRATIONS[2], MIGRATIONS[3], MIGRATIONS[4], MIGRATIONS[5]])
    const upgraded = JSON.parse(db.kv.get('settings')!) as Record<string, unknown>
    expect(upgraded).not.toHaveProperty('proxyUrl')
    expect(upgraded.proxy).toEqual({ mode: 'manual', manualUrl: 'http://127.0.0.1:7890' })
  })

  it('drops credential-bearing legacy proxy URLs to the safe default', () => {
    const db = new dbMock.MockDatabase(':memory:')
    db.userVersion = 2
    db.kv.set('settings', JSON.stringify({ proxyUrl: 'http://user:pass@127.0.0.1:7890' }))

    migrate(db as never)

    const upgraded = JSON.parse(db.kv.get('settings')!) as Record<string, unknown>
    expect(upgraded).not.toHaveProperty('proxyUrl')
    expect(upgraded.proxy).toEqual({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' })
  })

  it('maps a legacy null proxyUrl to system and seeds the manual URL', () => {
    const db = new dbMock.MockDatabase(':memory:')
    db.userVersion = 2
    db.kv.set('settings', JSON.stringify({ proxyUrl: null }))

    migrate(db as never)

    const upgraded = JSON.parse(db.kv.get('settings')!) as Record<string, unknown>
    expect(upgraded.proxy).toEqual({ mode: 'system', manualUrl: 'http://127.0.0.1:7897' })
  })

  it('is idempotent when settings already carry the closed proxy config', () => {
    const db = new dbMock.MockDatabase(':memory:')
    db.userVersion = 2
    db.kv.set(
      'settings',
      JSON.stringify({ proxy: { mode: 'direct', manualUrl: 'http://127.0.0.1:7897' } })
    )

    migrate(db as never)

    const upgraded = JSON.parse(db.kv.get('settings')!) as Record<string, unknown>
    expect(upgraded.proxy).toEqual({ mode: 'direct', manualUrl: 'http://127.0.0.1:7897' })
    expect(upgraded).not.toHaveProperty('proxyUrl')
  })

  it('leaves corrupt settings JSON alone', () => {
    const db = new dbMock.MockDatabase(':memory:')
    db.userVersion = 2
    db.kv.set('settings', '{corrupt!')

    migrate(db as never)

    expect(db.kv.get('settings')).toBe('{corrupt!')
  })
})

describe('migration SQL on a real SQLite engine', () => {
  it('upgrades an upstream v2 database and maps rows to closed modes', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(MIGRATIONS[0]!)
    db.exec(MIGRATIONS[1]!)
    db.exec('PRAGMA user_version = 2')
    db.exec(
      `INSERT INTO downloads (id, repo_id, kind, revision, status, total_bytes, received_bytes, files_json, created_at, proxy_url) VALUES
         ('a', 'org/a', 'model', 'main', 'paused', 0, 0, '[]', '2026-01-01T00:00:00.000Z', 'http://127.0.0.1:7890'),
         ('b', 'org/b', 'model', 'main', 'completed', 1, 1, '[]', '2026-01-01T00:00:00.000Z', NULL)`
    )

    db.exec(MIGRATIONS[2]!)

    const rows = db.prepare('SELECT id, proxy_mode, proxy_url FROM downloads ORDER BY id').all()
    expect(rows[0]).toMatchObject({
      id: 'a',
      proxy_mode: 'manual',
      proxy_url: 'http://127.0.0.1:7890'
    })
    expect(rows[1]).toMatchObject({ id: 'b', proxy_mode: 'system', proxy_url: null })
    db.close()
  })

  it('leaves a fresh database with the proxy_mode column present', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of MIGRATIONS) db.exec(sql)

    const columns = db
      .prepare('PRAGMA table_info(downloads)')
      .all()
      .map((column) => column.name)
    expect(columns).toContain('proxy_mode')
    expect(columns).toContain('proxy_url')
    expect(columns).toContain('endpoint')
    db.close()
  })

  it('creates clone_tasks with the status/created and retry indexes on a fresh database', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of MIGRATIONS) db.exec(sql)

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clone_tasks'")
      .get()
    expect(table).toBeDefined()
    const columns = db
      .prepare('PRAGMA table_info(clone_tasks)')
      .all()
      .map((column) => column.name)
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
    const indexes = db
      .prepare("PRAGMA index_list('clone_tasks')")
      .all()
      .map((index) => index.name)
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_clone_tasks_status_created', 'idx_clone_tasks_retry_of'])
    )
    db.close()
  })

  it('upgrades a v3 database to v4: adds clone_tasks and leaves downloads rows intact', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(MIGRATIONS[0]!)
    db.exec(MIGRATIONS[1]!)
    db.exec(MIGRATIONS[2]!)
    db.exec('PRAGMA user_version = 3')
    db.exec(
      `INSERT INTO downloads (id, repo_id, kind, revision, status, total_bytes, received_bytes, files_json, created_at) VALUES
         ('d', 'org/d', 'model', 'main', 'completed', 1, 1, '[]', '2026-01-01T00:00:00.000Z')`
    )

    db.exec(MIGRATIONS[3]!)

    const cloneTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clone_tasks'")
      .get()
    expect(cloneTable).toBeDefined()
    const download = db.prepare('SELECT status FROM downloads WHERE id = ?').get('d') as {
      status: string
    }
    expect(download.status).toBe('completed')
    db.close()
  })

  it('adds account metadata and marks legacy follows/inbox rows as legacy-local', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of MIGRATIONS.slice(0, 4)) db.exec(sql)
    db.exec(
      `INSERT INTO follows (id, type, target, created_at) VALUES ('f', 'user', 'alice', '2026-01-01')`
    )
    db.exec(
      `INSERT INTO inbox (id, kind, title, body, route, created_at) VALUES ('i', 'paper', 't', 'b', '/papers/p', '2026-01-01')`
    )
    db.exec(MIGRATIONS[4]!)

    const follows = db.prepare('SELECT * FROM follows').all()
    const inbox = db.prepare('SELECT * FROM inbox').all()
    expect(follows[0]).toMatchObject({ account_id: null, legacy_origin: 'legacy-local' })
    expect(inbox[0]).toMatchObject({ account_id: null, legacy_origin: 'legacy-local' })
    const downloadColumns = db
      .prepare('PRAGMA table_info(downloads)')
      .all()
      .map((column) => column.name)
    expect(downloadColumns).toEqual(expect.arrayContaining(['account_id', 'account_label']))
    const cloneColumns = db
      .prepare('PRAGMA table_info(clone_tasks)')
      .all()
      .map((column) => column.name)
    expect(cloneColumns).toEqual(expect.arrayContaining(['account_id', 'account_label']))
    db.close()
  })

  it('creates upload_tasks with all columns and status CHECK on a fresh database', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of MIGRATIONS) db.exec(sql)

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_tasks'")
      .get()
    expect(table).toBeDefined()

    const columns = db
      .prepare('PRAGMA table_info(upload_tasks)')
      .all()
      .map((column: Record<string, unknown>) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'account_id',
        'account_label',
        'repo_kind',
        'repo_name',
        'repo_visibility',
        'root_path',
        'manifest_fingerprint',
        'warning_codes',
        'summary_file_count',
        'summary_total_bytes',
        'status',
        'phase',
        'progress',
        'message_key',
        'params_json',
        'repo_id',
        'repo_url',
        'created_at',
        'updated_at',
        'completed_at'
      ])
    )

    const indexes = db
      .prepare("PRAGMA index_list('upload_tasks')")
      .all()
      .map((index: Record<string, unknown>) => index.name)
    expect(indexes).toContain('idx_upload_tasks_status')

    // Verify CHECK constraint rejects invalid status
    expect(() =>
      db
        .prepare(
          `INSERT INTO upload_tasks (
            id, repo_kind, repo_name, repo_visibility, root_path,
            manifest_fingerprint, warning_codes,
            summary_file_count, summary_total_bytes,
            status, phase, progress, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'bad',
          'model',
          'test',
          'public',
          '/tmp',
          'abc',
          '[]',
          0,
          0,
          'bogus-status',
          'preparing',
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
    ).toThrow()

    db.close()
  })
})
