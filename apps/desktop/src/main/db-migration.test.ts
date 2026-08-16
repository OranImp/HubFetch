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
    // Every migration SQL ran in order, ending with the proxy_mode migration.
    expect(db.execs).toEqual([...MIGRATIONS])
    expect(db.execs.at(-1)).toContain('ALTER TABLE downloads ADD COLUMN proxy_mode TEXT')
    expect(db.execs.at(-1)).toContain('SET proxy_mode = CASE WHEN proxy_url IS NULL')
  })

  it('upgrades an upstream v2 fixture: runs only the proxy migration and remaps settings', () => {
    const db = new dbMock.MockDatabase(':memory:')
    db.userVersion = 2
    db.kv.set(
      'settings',
      JSON.stringify({ locale: 'en', theme: 'light', proxyUrl: 'http://127.0.0.1:7890' })
    )

    migrate(db as never)

    expect(db.userVersion).toBe(MIGRATIONS.length)
    expect(db.execs).toEqual([MIGRATIONS[2]])
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
})
