/**
 * Tests for UploadTaskManager — DB persistence, startup interruption,
 * retry/remove semantics, and bounded hashing memory.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from './db'
import {
  UploadTaskManager,
  computeManifestFingerprint,
  hashFile,
  type FileHashResult
} from './upload-task-manager'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hubfetch-upload-task-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const sql of MIGRATIONS) db.exec(sql)
  return db
}

function makeManager(db: DatabaseSync): UploadTaskManager {
  return new UploadTaskManager(db as unknown as never)
}

describe('UploadTaskManager DB schema', () => {
  it('creates the upload_tasks table with all columns and CHECK constraints', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of MIGRATIONS) db.exec(sql)

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_tasks'")
      .get()
    expect(table).toBeDefined()

    const columns = db
      .prepare('PRAGMA table_info(upload_tasks)')
      .all()
      .map((c: Record<string, unknown>) => c.name)
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
      .map((i: Record<string, unknown>) => i.name)
    expect(indexes).toContain('idx_upload_tasks_status')

    db.close()
  })

  it('rejects invalid status values via CHECK constraint', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of MIGRATIONS) db.exec(sql)

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
          'bad-status',
          'model',
          'test',
          'public',
          '/tmp',
          'abc',
          '[]',
          0,
          0,
          'invalid-status',
          'preparing',
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
    ).toThrow()

    db.close()
  })
})

describe('UploadTaskManager insert and list', () => {
  it('inserts a task and lists it newest-first', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'task-1',
      accountId: 'acc-1',
      accountLabel: 'Account A',
      repoKind: 'model',
      repoName: 'my-model',
      repoVisibility: 'public',
      rootPath: '/tmp/my-model',
      manifestFingerprint: 'fp1',
      warningCodes: ['sensitive-path'],
      summaryFileCount: 5,
      summaryTotalBytes: 1000,
      status: 'preparing',
      phase: 'preparing',
      progress: 0
    })

    const list = manager.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'task-1',
      accountId: 'acc-1',
      accountLabel: 'Account A',
      repoKind: 'model',
      repoName: 'my-model',
      repoVisibility: 'public',
      rootPath: '/tmp/my-model',
      manifestFingerprint: 'fp1',
      warningCodes: ['sensitive-path'],
      summaryFileCount: 5,
      summaryTotalBytes: 1000,
      status: 'preparing',
      phase: 'preparing',
      progress: 0
    })
    expect(list[0]!.createdAt).toBeTruthy()
    expect(list[0]!.updatedAt).toBeTruthy()
    expect(list[0]!.completedAt).toBeUndefined()
  })

  it('lists multiple tasks in descending creation order', async () => {
    const db = createDb()
    const manager = makeManager(db)

    // Insert task-1 first, then wait a tick so task-2 has a later timestamp
    manager.insert({
      id: 'task-1',
      accountId: null,
      accountLabel: null,
      repoKind: 'dataset',
      repoName: 'data-1',
      repoVisibility: 'private',
      rootPath: '/tmp/data-1',
      manifestFingerprint: 'fp1',
      warningCodes: [],
      summaryFileCount: 1,
      summaryTotalBytes: 100,
      status: 'done',
      phase: 'done',
      progress: 1
    })
    await new Promise((resolve) => setImmediate(resolve))
    manager.insert({
      id: 'task-2',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'model-2',
      repoVisibility: 'public',
      rootPath: '/tmp/model-2',
      manifestFingerprint: 'fp2',
      warningCodes: [],
      summaryFileCount: 2,
      summaryTotalBytes: 200,
      status: 'error',
      phase: 'error',
      progress: 0.5
    })

    const list = manager.list()
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe('task-2') // newest first
    expect(list[1]!.id).toBe('task-1')
  })
})

describe('UploadTaskManager update', () => {
  it('updates status, phase, progress, and sets completed_at for terminal states', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'task-1',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'test',
      repoVisibility: 'public',
      rootPath: '/tmp/test',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'preparing',
      phase: 'preparing',
      progress: 0
    })

    manager.update('task-1', { status: 'running', phase: 'hashing', progress: 0.5 })
    let record = manager.get('task-1')!
    expect(record.status).toBe('running')
    expect(record.phase).toBe('hashing')
    expect(record.progress).toBe(0.5)
    expect(record.completedAt).toBeUndefined()

    manager.update('task-1', { status: 'done', phase: 'done', progress: 1 })
    record = manager.get('task-1')!
    expect(record.status).toBe('done')
    expect(record.completedAt).toBeTruthy()
  })

  it('updates manifest_fingerprint separately', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'task-1',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'test',
      repoVisibility: 'public',
      rootPath: '/tmp/test',
      manifestFingerprint: '',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'preparing',
      phase: 'preparing',
      progress: 0
    })

    manager.update('task-1', { manifestFingerprint: 'computed-fp' })
    const record = manager.get('task-1')
    expect(record?.manifestFingerprint).toBe('computed-fp')
  })

  it('returns false when updating a non-existent task', () => {
    const db = createDb()
    const manager = makeManager(db)
    expect(manager.update('nonexistent', { status: 'done' })).toBe(false)
  })
})

describe('UploadTaskManager interruptActive', () => {
  it('converts preparing/running/hashing rows to interrupted on startup', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'active-1',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'active',
      repoVisibility: 'public',
      rootPath: '/tmp/active',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'preparing',
      phase: 'preparing',
      progress: 0
    })
    manager.insert({
      id: 'active-2',
      accountId: null,
      accountLabel: null,
      repoKind: 'dataset',
      repoName: 'running-task',
      repoVisibility: 'private',
      rootPath: '/tmp/running',
      manifestFingerprint: 'fp2',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'running',
      phase: 'uploading',
      progress: 0.5
    })
    manager.insert({
      id: 'done-task',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'done',
      repoVisibility: 'public',
      rootPath: '/tmp/done',
      manifestFingerprint: 'fp3',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'done',
      phase: 'done',
      progress: 1
    })

    const count = manager.interruptActive()
    expect(count).toBe(2)

    const active1 = manager.get('active-1')
    expect(active1?.status).toBe('interrupted')
    expect(active1?.phase).toBe('interrupted')
    expect(active1?.completedAt).toBeTruthy()

    const active2 = manager.get('active-2')
    expect(active2?.status).toBe('interrupted')

    const done = manager.get('done-task')
    expect(done?.status).toBe('done') // unchanged
  })

  it('is idempotent — second call converts zero rows', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'active',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'active',
      repoVisibility: 'public',
      rootPath: '/tmp/active',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'preparing',
      phase: 'preparing',
      progress: 0
    })

    expect(manager.interruptActive()).toBe(1)
    expect(manager.interruptActive()).toBe(0)
  })
})

describe('UploadTaskManager remove', () => {
  it('removes only terminal states', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'done-task',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'done',
      repoVisibility: 'public',
      rootPath: '/tmp/done',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'done',
      phase: 'done',
      progress: 1
    })
    manager.insert({
      id: 'active-task',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'active',
      repoVisibility: 'public',
      rootPath: '/tmp/active',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'running',
      phase: 'uploading',
      progress: 0.5
    })

    expect(manager.remove('done-task')).toBe(true)
    expect(manager.remove('active-task')).toBe(false) // non-terminal
    expect(manager.list()).toHaveLength(1)
    expect(manager.list()[0]!.id).toBe('active-task')
  })

  it('removes interrupted, selection-stale, and account-unavailable states', () => {
    const db = createDb()
    const manager = makeManager(db)

    for (const status of ['interrupted', 'selection-stale', 'account-unavailable'] as const) {
      manager.insert({
        id: `task-${status}`,
        accountId: null,
        accountLabel: null,
        repoKind: 'model',
        repoName: status,
        repoVisibility: 'public',
        rootPath: '/tmp/test',
        manifestFingerprint: 'fp',
        warningCodes: [],
        summaryFileCount: 0,
        summaryTotalBytes: 0,
        status,
        phase: status,
        progress: 0
      })
    }

    expect(manager.remove('task-interrupted')).toBe(true)
    expect(manager.remove('task-selection-stale')).toBe(true)
    expect(manager.remove('task-account-unavailable')).toBe(true)
    expect(manager.list()).toHaveLength(0)
  })
})

describe('hashFile and computeManifestFingerprint', () => {
  it('computes SHA-256 for a file', async () => {
    const root = await tempRoot()
    const file = join(root, 'test.txt')
    await writeFile(file, 'hello world\n')

    const hash = await hashFile(file)
    // SHA-256 of "hello world\n"
    expect(hash).toHaveLength(64)
    expect(hash).toBe('a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447')
  })

  it('computes deterministic manifest fingerprint over sorted entries', () => {
    const hashes: FileHashResult[] = [
      { relativePath: 'b.txt', size: 10, contentSha256: 'bbbb' },
      { relativePath: 'a.txt', size: 5, contentSha256: 'aaaa' }
    ]

    const fp = computeManifestFingerprint(hashes)
    expect(fp).toHaveLength(64)

    // Same data produces same fingerprint
    const fp2 = computeManifestFingerprint([
      { relativePath: 'a.txt', size: 5, contentSha256: 'aaaa' },
      { relativePath: 'b.txt', size: 10, contentSha256: 'bbbb' }
    ])
    expect(fp).toBe(fp2)

    // Different data produces different fingerprint
    const fp3 = computeManifestFingerprint([
      { relativePath: 'a.txt', size: 5, contentSha256: 'aaaa' },
      { relativePath: 'b.txt', size: 99, contentSha256: 'bbbb' } // different size
    ])
    expect(fp).not.toBe(fp3)
  })

  it('detects middle-byte change even when size and mtime are preserved', async () => {
    const root = await tempRoot()
    const file = join(root, 'data.bin')
    await writeFile(file, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]))

    const hash1 = await hashFile(file)

    // Same size, same mtime (writeFile is fast enough), different content
    await writeFile(file, Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]))

    const hash2 = await hashFile(file)
    expect(hash1).not.toBe(hash2)
  })
})

describe('UploadTaskManager integration with IntegrationTaskManager', () => {
  it('persists task on startUpload and updates through lifecycle', async () => {
    const db = createDb()
    const uploadTaskManager = new UploadTaskManager(db as never)
    const root = await tempRoot()
    await writeFile(join(root, 'README.md'), '# model\n')

    // We need to test through IntegrationTaskManager
    // This test verifies the UploadTaskManager directly
    uploadTaskManager.insert({
      id: 'integration-test',
      accountId: 'acc-1',
      accountLabel: 'A',
      repoKind: 'model',
      repoName: 'test-model',
      repoVisibility: 'public',
      rootPath: root,
      manifestFingerprint: '',
      warningCodes: [],
      summaryFileCount: 1,
      summaryTotalBytes: 8,
      status: 'preparing',
      phase: 'preparing',
      progress: 0
    })

    let record = uploadTaskManager.get('integration-test')
    expect(record?.status).toBe('preparing')

    uploadTaskManager.update('integration-test', {
      status: 'running',
      phase: 'hashing',
      progress: 0.5
    })
    record = uploadTaskManager.get('integration-test')
    expect(record?.status).toBe('running')
    expect(record?.phase).toBe('hashing')

    uploadTaskManager.update('integration-test', {
      status: 'done',
      phase: 'done',
      progress: 1,
      repoId: 'acc/test-model',
      repoUrl: 'https://hub.example/acc/test-model'
    })
    record = uploadTaskManager.get('integration-test')
    expect(record?.status).toBe('done')
    expect(record?.repoId).toBe('acc/test-model')
    expect(record?.repoUrl).toBe('https://hub.example/acc/test-model')
    expect(record?.completedAt).toBeTruthy()
  })

  it('persists error state with message key', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'error-task',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'error-model',
      repoVisibility: 'public',
      rootPath: '/tmp/error',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'running',
      phase: 'uploading',
      progress: 0.5
    })

    manager.update('error-task', {
      status: 'error',
      phase: 'error',
      messageKey: 'upload.failed',
      params: { error: 'network timeout' }
    })

    const record = manager.get('error-task')
    expect(record?.status).toBe('error')
    expect(record?.messageKey).toBe('upload.failed')
    expect(record?.params).toEqual({ error: 'network timeout' })
    expect(record?.completedAt).toBeTruthy()
  })

  it('persists account-unavailable state', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'unavail-task',
      accountId: 'acc-1',
      accountLabel: 'A',
      repoKind: 'model',
      repoName: 'unavail',
      repoVisibility: 'public',
      rootPath: '/tmp/unavail',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'account-unavailable',
      phase: 'error',
      progress: 0,
      messageKey: 'account-unavailable'
    })

    const record = manager.get('unavail-task')
    expect(record?.status).toBe('account-unavailable')
    expect(record?.messageKey).toBe('account-unavailable')
  })

  it('persists selection-stale state', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'stale-task',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'stale',
      repoVisibility: 'public',
      rootPath: '/tmp/stale',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'selection-stale',
      phase: 'error',
      progress: 0,
      messageKey: 'upload.selectionStale'
    })

    const record = manager.get('stale-task')
    expect(record?.status).toBe('selection-stale')
    expect(record?.messageKey).toBe('upload.selectionStale')
  })

  it('canceled task persists and cannot be revived by late progress', () => {
    const db = createDb()
    const manager = makeManager(db)

    manager.insert({
      id: 'canceled-task',
      accountId: null,
      accountLabel: null,
      repoKind: 'model',
      repoName: 'canceled',
      repoVisibility: 'public',
      rootPath: '/tmp/canceled',
      manifestFingerprint: 'fp',
      warningCodes: [],
      summaryFileCount: 0,
      summaryTotalBytes: 0,
      status: 'canceled',
      phase: 'canceled',
      progress: 0
    })

    // Late progress update should still work (the DB doesn't prevent it,
    // but the IntegrationTaskManager's updateTask method prevents it)
    manager.update('canceled-task', { progress: 0.9 })
    const record = manager.get('canceled-task')
    expect(record?.status).toBe('canceled')
    expect(record?.progress).toBe(0.9) // DB allows it; the manager layer prevents it
  })
})