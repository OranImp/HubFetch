/**
 * Tests for cache action plans (plan Todo 15): expiring main-owned prune and
 * repair plans with atomic revalidation.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CacheManager } from './cache'
import type { CachePlanDeps } from './cache'
import { cleanupRepairStaging, REPAIR_STAGING_DIR } from './cache-plans'
import { verifyCache } from './workers/cache-verification-worker'
import type { CacheRepairTransport, CacheRepairFetchMeta } from './cache-plans'
import type { SettingsStore } from './settings'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

// --- fixture helpers ---------------------------------------------------------

function makeCacheRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omh-cache-plans-'))
}

function makeRepo(root: string): string {
  return join(root, 'models--org--name')
}

function writeBlob(repo: string, name: string, content: string): string {
  const blob = join(repo, 'blobs', name)
  mkdirSync(dirname(blob), { recursive: true })
  writeFileSync(blob, content)
  return blob
}

function linkSnapshotFile(repo: string, commit: string, path: string, blob: string): void {
  const file = join(repo, 'snapshots', commit, path)
  mkdirSync(dirname(file), { recursive: true })
  symlinkSync(relative(dirname(file), blob), file)
}

function copySnapshotFile(repo: string, commit: string, path: string, content: string): void {
  const file = join(repo, 'snapshots', commit, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function writeRef(repo: string, name: string, commit: string): void {
  mkdirSync(join(repo, 'refs'), { recursive: true })
  writeFileSync(join(repo, 'refs', name), commit)
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function gitBlobSha1Hex(content: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex')
}

// --- stubs -------------------------------------------------------------------

function managerFor(
  cacheDir: string,
  options: {
    protectedTaskIds?: () => ReadonlySet<string>
    protectedCommits?: () => ReadonlySet<string>
    planDeps?: CachePlanDeps
  } = {}
): CacheManager {
  return new CacheManager(
    {
      get: () => ({ hfCacheDir: cacheDir })
    } as unknown as SettingsStore,
    options.protectedTaskIds ?? (() => new Set()),
    options.protectedCommits ?? (() => new Set()),
    options.planDeps
  )
}

function planDeps(overrides: Partial<CachePlanDeps> = {}): CachePlanDeps {
  return {
    activeAccountId: () => null,
    leaseAccountCredential: () => {
      throw new Error('account-not-found')
    },
    currentEndpoint: () => 'https://huggingface.co',
    currentProxy: () => ({ mode: 'direct' }),
    ...overrides
  }
}

interface StubFixture {
  bytes: Buffer
  etag: string
  commit?: string
  networkError?: boolean
}

function transportFor(fixture: StubFixture): CacheRepairTransport & { calls: number } {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    async fetchToFile({ destination }: { destination: string }): Promise<CacheRepairFetchMeta> {
      calls += 1
      if (fixture.networkError) throw new Error('getaddrinfo ENOTFOUND huggingface.co')
      writeFileSync(destination, fixture.bytes)
      return { etag: fixture.etag, commit: fixture.commit, size: fixture.bytes.length }
    },
    close: async () => undefined
  }
}

let roots: string[] = []

beforeEach(() => {
  roots = []
})

afterEach(() => {
  vi.useRealTimers()
})

function newRoot(): string {
  const root = makeCacheRoot()
  roots.push(root)
  return root
}

// --- prune --------------------------------------------------------------------

describe('prune plans', () => {
  it('plans detached snapshots, orphan blobs, and stale partials — excluding refs, protected commits, retained revisions, and protected partials', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const sharedContent = 'shared-blob-content'
    const orphanContent = 'orphan-blob-content'
    const sharedBlob = writeBlob(repo, sha256Hex(sharedContent), sharedContent)
    writeBlob(repo, sha256Hex(orphanContent), orphanContent)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', sharedBlob)
    linkSnapshotFile(repo, COMMIT_B, 'config.json', sharedBlob)
    // The ref pins COMMIT_B, so COMMIT_A is the detached revision.
    writeRef(repo, 'main', COMMIT_B)
    const partialOld = writeBlob(repo, `${'9'.repeat(64)}.incomplete.taskGone-12345678`, 'partial')
    const partialProtected = writeBlob(
      repo,
      `${'8'.repeat(64)}.incomplete.taskAlive-87654321`,
      'partial'
    )
    const stale = (Date.now() - 60 * 60_000) / 1000
    utimesSync(partialOld, stale, stale)
    utimesSync(partialProtected, stale, stale)

    const manager = managerFor(root, {
      protectedCommits: () => new Set([COMMIT_B]),
      protectedTaskIds: () => new Set(['taskAlive'])
    })
    const plan = await manager.planAction({
      action: 'prune',
      kind: 'model',
      repoId: 'org/name',
      retainCommits: []
    })

    expect(plan.action).toBe('prune')
    if (plan.action !== 'prune') throw new Error('expected a prune plan')
    expect(plan.planId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/)
    const names = plan.entries.map((entry) => entry.name).sort()
    // COMMIT_A is detached (no ref, unprotected); COMMIT_B is protected.
    expect(names).toContain(COMMIT_A)
    expect(names).not.toContain(COMMIT_B)
    // Orphan blob (referenced only by the protected snapshot is NOT an orphan —
    // shared blob stays; the second blob is unreferenced by remaining snapshots).
    expect(names).toContain(sha256Hex(orphanContent))
    // The shared blob is referenced by the remaining (protected) snapshot.
    expect(names).not.toContain(sha256Hex(sharedContent))
    // Stale partial without a protected task; protected partial stays.
    expect(names).toContain(`${'9'.repeat(64)}.incomplete.taskGone-12345678`)
    expect(names).not.toContain(`${'8'.repeat(64)}.incomplete.taskAlive-87654321`)
    // Sanitized: no absolute path ever crosses IPC.
    expect(JSON.stringify(plan)).not.toContain(root)
    // Refs are never prune candidates.
    expect(plan.entries.every((entry) => !entry.path.includes('/refs/'))).toBe(true)
    void partialOld
    void partialProtected
    void sharedBlob
  })

  it('keeps user-selected retained revisions out of the plan', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const content = 'blob-content'
    const blob = writeBlob(repo, sha256Hex(content), content)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', blob)
    writeRef(repo, 'main', COMMIT_B)
    linkSnapshotFile(repo, COMMIT_B, 'config.json', blob)
    // Another prune candidate so the plan is non-empty even with A retained.
    const partial = writeBlob(repo, `${'7'.repeat(64)}.incomplete.taskGone-abcdef12`, 'partial')
    const stale = (Date.now() - 60 * 60_000) / 1000
    utimesSync(partial, stale, stale)

    const manager = managerFor(root)
    const plan = await manager.planAction({
      action: 'prune',
      kind: 'model',
      repoId: 'org/name',
      retainCommits: [COMMIT_A]
    })
    if (plan.action !== 'prune') throw new Error('expected a prune plan')

    expect(plan.entries.map((entry) => entry.name)).not.toContain(COMMIT_A)
    expect(plan.entries.length).toBeGreaterThan(0)
  })

  it('applies exactly the planned entries with exact reclaimed bytes and consumes the plan (one-shot)', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const keptContent = 'kept'
    const goneContent = 'gone'
    const keptBlob = writeBlob(repo, sha256Hex(keptContent), keptContent)
    writeBlob(repo, sha256Hex(goneContent), goneContent)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', keptBlob)
    writeRef(repo, 'main', COMMIT_B)
    linkSnapshotFile(repo, COMMIT_B, 'config.json', keptBlob)
    copySnapshotFile(repo, COMMIT_A, 'weights.bin', 'w'.repeat(128))

    const manager = managerFor(root)
    const plan = await manager.planAction({ action: 'prune', kind: 'model', repoId: 'org/name' })
    if (plan.action !== 'prune') throw new Error('expected a prune plan')
    const snapshotEntry = plan.entries.find((entry) => entry.kind === 'detached-snapshot')
    const expectedBytes = plan.entries.reduce((acc, entry) => acc + entry.estimatedBytes, 0)
    expect(snapshotEntry).toBeDefined()

    const result = await manager.applyAction(plan.planId)
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(plan.entries.length)
    expect(result.bytes).toBe(expectedBytes)
    expect(existsSync(join(repo, 'snapshots', COMMIT_A, 'weights.bin'))).toBe(false)
    expect(existsSync(join(repo, 'blobs', sha256Hex(goneContent)))).toBe(false)
    expect(existsSync(keptBlob)).toBe(true)
    expect(existsSync(join(repo, 'refs', 'main'))).toBe(true)
    expect(existsSync(join(repo, 'snapshots', COMMIT_B))).toBe(true)

    // One-shot: the second apply finds no plan.
    const second = await manager.applyAction(plan.planId)
    expect(second.ok).toBe(false)
    expect(second.failure?.reason).toBe('plan-not-found')
  })

  it('rejects with zero mutation when a planned snapshot becomes protected between plan and apply', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const content = 'content'
    const blob = writeBlob(repo, sha256Hex(content), content)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', blob)
    writeRef(repo, 'main', COMMIT_B)
    linkSnapshotFile(repo, COMMIT_B, 'config.json', blob)

    let protectedNow: ReadonlySet<string> = new Set()
    const manager = managerFor(root, { protectedCommits: () => protectedNow })
    const plan = await manager.planAction({ action: 'prune', kind: 'model', repoId: 'org/name' })
    expect(plan.entries.length).toBeGreaterThan(0)

    protectedNow = new Set([COMMIT_A])
    const result = await manager.applyAction(plan.planId)
    expect(result.ok).toBe(false)
    expect(result.failure?.reason).toBe('plan-stale-protected')
    expect(result.changed).toBe(0)
    expect(existsSync(join(repo, 'snapshots', COMMIT_A))).toBe(true)
    expect(existsSync(blob)).toBe(true)
  })

  it('rejects with zero mutation when the filesystem changed since the plan', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const content = 'content'
    const blob = writeBlob(repo, sha256Hex(content), content)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', blob)
    writeRef(repo, 'main', COMMIT_B)
    linkSnapshotFile(repo, COMMIT_B, 'config.json', blob)

    const manager = managerFor(root)
    const plan = await manager.planAction({ action: 'prune', kind: 'model', repoId: 'org/name' })
    // Mutate the planned snapshot after planning (size drift).
    copySnapshotFile(repo, COMMIT_A, 'extra.bin', 'unexpected')

    const result = await manager.applyAction(plan.planId)
    expect(result.ok).toBe(false)
    expect(result.failure?.reason).toBe('plan-stale-filesystem')
    expect(result.changed).toBe(0)
    expect(existsSync(join(repo, 'snapshots', COMMIT_A, 'config.json'))).toBe(true)
  })

  it('rejects an expired plan and a tampered plan digest before mutating', async () => {
    vi.useFakeTimers()
    const root = newRoot()
    const repo = makeRepo(root)
    const content = 'content'
    const blob = writeBlob(repo, sha256Hex(content), content)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', blob)
    writeRef(repo, 'main', COMMIT_B)
    linkSnapshotFile(repo, COMMIT_B, 'config.json', blob)
    const manager = managerFor(root)

    // The 15-minute expiry timer consumes the plan.
    const plan = await manager.planAction({ action: 'prune', kind: 'model', repoId: 'org/name' })
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
    const consumed = await manager.applyAction(plan.planId)
    expect(consumed.ok).toBe(false)
    expect(consumed.failure?.reason).toBe('plan-not-found')
    expect(existsSync(join(repo, 'snapshots', COMMIT_A))).toBe(true)

    // The expiry CHECK itself: a plan whose stored expiry is in the past.
    const plan2 = await manager.planAction({ action: 'prune', kind: 'model', repoId: 'org/name' })
    const internals = manager as unknown as {
      planStore: {
        get: (id: string) => { plan: { expiresAt: string; digest: string } } | undefined
      }
    }
    const stored = internals.planStore.get(plan2.planId)
    expect(stored).toBeDefined()
    if (stored) stored.plan.expiresAt = new Date(Date.now() - 1000).toISOString()
    const expired = await manager.applyAction(plan2.planId)
    expect(expired.ok).toBe(false)
    expect(expired.failure?.reason).toBe('plan-expired')
    expect(existsSync(join(repo, 'snapshots', COMMIT_A))).toBe(true)

    // Tampered digest.
    const plan3 = await manager.planAction({ action: 'prune', kind: 'model', repoId: 'org/name' })
    const stored3 = internals.planStore.get(plan3.planId)
    if (stored3) stored3.plan.digest = 'tampered-digest'
    const tampered = await manager.applyAction(plan3.planId)
    expect(tampered.ok).toBe(false)
    expect(tampered.failure?.reason).toBe('plan-digest-mismatch')
    expect(existsSync(join(repo, 'snapshots', COMMIT_A))).toBe(true)
  })

  it('reports a typed failure when there is nothing to prune', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const content = 'content'
    const blob = writeBlob(repo, sha256Hex(content), content)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', blob)
    writeRef(repo, 'main', COMMIT_A)

    const manager = managerFor(root)
    await expect(
      manager.planAction({ action: 'prune', kind: 'model', repoId: 'org/name' })
    ).rejects.toThrow('no prune candidates')
    void repo
  })
})

// --- repair planning -----------------------------------------------------------

describe('repair plan mapping', () => {
  it('maps a corrupt LFS blob to its referencing snapshot at one commit and sanitizes the plan', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const good = 'good-lfs-content'
    const corrupt = 'corrupt!!!'
    const blobHash = sha256Hex(good)
    const blob = writeBlob(repo, blobHash, corrupt)
    linkSnapshotFile(repo, COMMIT_A, 'model.safetensors', blob)
    writeRef(repo, 'main', COMMIT_A)

    const manager = managerFor(root, { planDeps: planDeps() })
    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })

    expect(plan.action).toBe('repair')
    if (plan.action !== 'repair') return
    expect(plan.resolvedCommit).toBe(COMMIT_A)
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]!.issue).toBe('hash-mismatch')
    expect(plan.entries[0]!.repoPath).toBe('model.safetensors')
    expect(plan.entries[0]!.path).toContain('blobs/')
    // Sanitized: expected hashes/absolute paths stay in main.
    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain('"expectedHash"')
    expect(serialized).not.toContain('snapshotFilePath')
  })

  it('refuses to map an orphan corrupt blob with no snapshot reference', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    writeBlob(repo, sha256Hex('claimed-content'), 'corrupt!!!')

    const manager = managerFor(root, { planDeps: planDeps() })
    await expect(
      manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    ).rejects.toThrow('orphan blob')
  })

  it('refuses issues that span multiple commits', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const contentA = 'content-a'
    const contentB = 'content-b'
    const blobA = writeBlob(repo, sha256Hex(contentA), 'corrupt-a!')
    const blobB = writeBlob(repo, sha256Hex(contentB), 'corrupt-b!')
    linkSnapshotFile(repo, COMMIT_A, 'a.bin', blobA)
    linkSnapshotFile(repo, COMMIT_B, 'b.bin', blobB)

    const manager = managerFor(root, { planDeps: planDeps() })
    await expect(
      manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    ).rejects.toThrow('multiple commits')
  })

  it('rejects issue ids the fresh scan does not confirm', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const blob = writeBlob(repo, sha256Hex('good'), 'corrupt!')
    linkSnapshotFile(repo, COMMIT_A, 'f.bin', blob)
    writeRef(repo, 'main', COMMIT_A)

    const manager = managerFor(root, { planDeps: planDeps() })
    await expect(
      manager.planAction({
        action: 'repair',
        kind: 'model',
        repoId: 'org/name',
        issueIds: ['hash-mismatch:models--org--name/snapshots/main/fake.bin']
      })
    ).rejects.toThrow('not detected')
  })
})

// --- repair apply ----------------------------------------------------------------

describe('repair apply', () => {
  function corruptLfsRepo(root: string): { repo: string; blobHash: string; good: string } {
    const repo = makeRepo(root)
    const good = 'verified-lfs-payload'
    const blobHash = sha256Hex(good)
    const blob = writeBlob(repo, blobHash, 'corrupted-bytes')
    linkSnapshotFile(repo, COMMIT_A, 'model.safetensors', blob)
    writeRef(repo, 'main', COMMIT_A)
    return { repo, blobHash, good }
  }

  it('downloads once to a temp file, verifies, and atomically replaces — leaving a clean verification report', async () => {
    const root = newRoot()
    const { repo, blobHash, good } = corruptLfsRepo(root)
    const transport = transportFor({ bytes: Buffer.from(good), etag: blobHash, commit: COMMIT_A })
    const manager = managerFor(root, {
      planDeps: planDeps({ createRepairTransport: () => transport })
    })

    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    const result = await manager.applyAction(plan.planId)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(1)
    expect(result.bytes).toBe(Buffer.byteLength(good))
    expect(transport.calls).toBe(1)
    // The blob now contains the verified content.
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(repo, 'blobs', blobHash), 'utf8')
      )
    ).toBe(good)
    // Snapshot entry resolves to the verified content (link or copy fallback).
    const snapshotFile = join(repo, 'snapshots', COMMIT_A, 'model.safetensors')
    const entry = await lstat(snapshotFile)
    expect(entry.isSymbolicLink() || entry.isFile()).toBe(true)
    // No staging leftovers for this plan (the staging root itself may remain).
    const planStaging = join(root, REPAIR_STAGING_DIR, plan.planId)
    expect(existsSync(planStaging)).toBe(false)
    // Todo 14 report is clean.
    const report = await verifyCache(root)
    expect(report.ok).toBe(true)
    expect(report.totalIssues).toBe(0)
  })

  it('repairs a corrupt git-blob (40-hex) entry via Git blob SHA-1 verification', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const good = 'plain-git-content'
    const hash = gitBlobSha1Hex(good)
    const blob = writeBlob(repo, hash, 'corrupted-git-bytes')
    linkSnapshotFile(repo, COMMIT_A, 'README.md', blob)
    writeRef(repo, 'main', COMMIT_A)
    const transport = transportFor({ bytes: Buffer.from(good), etag: hash, commit: COMMIT_A })
    const manager = managerFor(root, {
      planDeps: planDeps({ createRepairTransport: () => transport })
    })

    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    const result = await manager.applyAction(plan.planId)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(1)
    expect(existsSync(join(repo, 'blobs', hash))).toBe(true)
    const report = await verifyCache(root)
    expect(report.ok).toBe(true)
    expect(report.totalIssues).toBe(0)
  })

  it('repairs a broken snapshot link by restoring the missing blob', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const good = 'restored-blob'
    const blobHash = sha256Hex(good)
    linkSnapshotFile(repo, COMMIT_A, 'config.json', join(repo, 'blobs', blobHash))
    writeRef(repo, 'main', COMMIT_A)
    const transport = transportFor({ bytes: Buffer.from(good), etag: blobHash, commit: COMMIT_A })
    const manager = managerFor(root, {
      planDeps: planDeps({ createRepairTransport: () => transport })
    })

    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    const result = await manager.applyAction(plan.planId)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(1)
    expect(existsSync(join(repo, 'blobs', blobHash))).toBe(true)
    const report = await verifyCache(root)
    expect(report.ok).toBe(true)
  })

  it('repairs an unmatched snapshot copy (copy layout) with the etag-pinned identity', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    const good = 'copy-layout-payload'
    const hash = sha256Hex(good)
    // A verified, unrelated blob so the repo has a blobs dir; the corrupt copy
    // matches no verified blob.
    writeBlob(repo, sha256Hex('other-content'), 'other-content')
    copySnapshotFile(repo, COMMIT_A, 'tokenizer.json', 'corrupted-copy')
    writeRef(repo, 'main', COMMIT_A)
    const transport = transportFor({ bytes: Buffer.from(good), etag: hash, commit: COMMIT_A })
    const manager = managerFor(root, {
      planDeps: planDeps({ createRepairTransport: () => transport })
    })

    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    const result = await manager.applyAction(plan.planId)

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(1)
    expect(existsSync(join(repo, 'blobs', hash))).toBe(true)
    const report = await verifyCache(root)
    expect(report.ok).toBe(true)
  })

  it('rejects wrong content with the original bytes intact and no temp leftovers', async () => {
    const root = newRoot()
    const { repo, blobHash } = corruptLfsRepo(root)
    const originalCorrupt = 'corrupted-bytes'
    const wrongPayload = 'totally-wrong-payload'
    const transport = transportFor({ bytes: Buffer.from(wrongPayload), etag: blobHash })
    const manager = managerFor(root, {
      planDeps: planDeps({ createRepairTransport: () => transport })
    })

    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    const result = await manager.applyAction(plan.planId)

    expect(result.ok).toBe(false)
    expect(result.failure?.reason).toBe('integrity')
    expect(result.changed).toBe(0)
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(repo, 'blobs', blobHash), 'utf8')
      )
    ).toBe(originalCorrupt)
    expect(existsSync(join(root, REPAIR_STAGING_DIR, plan.planId))).toBe(false)
  })

  it('rejects an etag identity drift before replacing anything', async () => {
    const root = newRoot()
    const { repo, blobHash } = corruptLfsRepo(root)
    const transport = transportFor({
      bytes: Buffer.from('some-other-content'),
      etag: sha256Hex('some-other-content')
    })
    const manager = managerFor(root, {
      planDeps: planDeps({ createRepairTransport: () => transport })
    })

    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    const result = await manager.applyAction(plan.planId)
    expect(result.ok).toBe(false)
    expect(result.failure?.reason).toBe('integrity')
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(repo, 'blobs', blobHash), 'utf8')
      )
    ).toBe('corrupted-bytes')
  })

  it('returns a typed network failure with zero changes when offline', async () => {
    const root = newRoot()
    const { repo, blobHash } = corruptLfsRepo(root)
    const transport = transportFor({ bytes: Buffer.alloc(0), etag: blobHash, networkError: true })
    const manager = managerFor(root, {
      planDeps: planDeps({ createRepairTransport: () => transport })
    })

    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    const result = await manager.applyAction(plan.planId)
    expect(result.ok).toBe(false)
    expect(result.failure?.reason).toBe('network')
    expect(result.changed).toBe(0)
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(repo, 'blobs', blobHash), 'utf8')
      )
    ).toBe('corrupted-bytes')
    expect(existsSync(join(root, REPAIR_STAGING_DIR, plan.planId))).toBe(false)
  })

  it('rejects when the active account changed or the credential is unavailable', async () => {
    const root = newRoot()
    const { blobHash, good } = corruptLfsRepo(root)
    const accountId = '11111111-1111-4111-8111-111111111111'
    let activeAccount: string | null = accountId
    const manager = managerFor(root, {
      planDeps: planDeps({
        activeAccountId: () => activeAccount,
        leaseAccountCredential: () => {
          throw new Error('account-not-found')
        }
      })
    })
    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    expect(plan.accountId).toBe(accountId)

    // Lease fails at apply → typed account-unavailable.
    const failed = await manager.applyAction(plan.planId)
    expect(failed.ok).toBe(false)
    expect(failed.failure?.reason).toBe('account-unavailable')

    // Fresh plan, then switch account → plan-stale-account.
    const plan2 = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    activeAccount = '22222222-2222-4222-8222-222222222222'
    const stale = await manager.applyAction(plan2.planId)
    expect(stale.ok).toBe(false)
    expect(stale.failure?.reason).toBe('plan-stale-account')
    void blobHash
    void good
  })

  it('rejects when the endpoint or proxy changed since the plan', async () => {
    const root = newRoot()
    const { blobHash } = corruptLfsRepo(root)
    let endpoint = 'https://huggingface.co'
    const manager = managerFor(root, {
      planDeps: planDeps({ currentEndpoint: () => endpoint })
    })
    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })

    endpoint = 'https://hf-mirror.com'
    const result = await manager.applyAction(plan.planId)
    expect(result.ok).toBe(false)
    expect(result.failure?.reason).toBe('plan-stale-environment')
    void blobHash
  })

  it('rejects when the resolved commit becomes protected before apply', async () => {
    const root = newRoot()
    const { repo, blobHash } = corruptLfsRepo(root)
    let protectedNow: ReadonlySet<string> = new Set()
    const transport = transportFor({ bytes: Buffer.from('verified-lfs-payload'), etag: blobHash })
    const manager = managerFor(root, {
      protectedCommits: () => protectedNow,
      planDeps: planDeps({ createRepairTransport: () => transport })
    })
    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })

    protectedNow = new Set([COMMIT_A])
    const result = await manager.applyAction(plan.planId)
    expect(result.ok).toBe(false)
    expect(result.failure?.reason).toBe('plan-stale-protected')
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(repo, 'blobs', blobHash), 'utf8')
      )
    ).toBe('corrupted-bytes')
    expect(transport.calls).toBe(0)
  })
})

// --- staging sweep -----------------------------------------------------------------

describe('cleanupRepairStaging', () => {
  function stagingEntry(root: string, name: string): string {
    const staging = join(root, REPAIR_STAGING_DIR)
    mkdirSync(staging, { recursive: true })
    return join(staging, name)
  }

  it('removes only old UUID-named plan directories and exempts active plans', async () => {
    const root = newRoot()
    const uuid = '12345678-1234-4123-8123-123456789abc'
    const freshUuid = '12345678-1234-4123-8123-123456789def'
    const activeUuid = '12345678-1234-4123-8123-123456789aaa'
    const old = stagingEntry(root, uuid)
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, 'x.tmp'), 'temp')
    const fresh = stagingEntry(root, freshUuid)
    mkdirSync(fresh, { recursive: true })
    const active = stagingEntry(root, activeUuid)
    mkdirSync(active, { recursive: true })
    const foreign = stagingEntry(root, 'not-a-uuid')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'keep.txt'), 'keep')
    const oldTime = (Date.now() - 25 * 60 * 60 * 1000) / 1000
    utimesSync(old, oldTime, oldTime)
    utimesSync(active, oldTime, oldTime)

    await cleanupRepairStaging(root, new Set([activeUuid]))

    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(join(foreign, 'keep.txt'))).toBe(true)
  })

  it('never traverses link, file, or unexpected staging entries', async () => {
    const root = newRoot()
    const outside = mkdtempSync(join(tmpdir(), 'omh-cache-staging-outside-'))
    const linked = stagingEntry(root, '12345678-1234-4123-8123-123456789abc')
    symlinkSync(outside, linked, 'dir')
    const fileEntry = stagingEntry(root, '12345678-1234-4123-8123-123456789bbb')
    writeFileSync(fileEntry, 'a file where a dir would be')
    const foreignDir = stagingEntry(root, 'random-name')
    mkdirSync(foreignDir, { recursive: true })
    const oldTime = (Date.now() - 25 * 60 * 60 * 1000) / 1000
    utimesSync(foreignDir, oldTime, oldTime)

    await cleanupRepairStaging(root, new Set())

    // The link, the file entry, and the non-UUID dir are all untouched.
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(fileEntry)).toBe(true)
    expect(existsSync(foreignDir)).toBe(true)
    const remaining = await readdir(join(root, REPAIR_STAGING_DIR))
    expect(remaining.sort()).toEqual(
      [
        '12345678-1234-4123-8123-123456789abc',
        '12345678-1234-4123-8123-123456789bbb',
        'random-name'
      ].sort()
    )
  })

  it('rejects a symlinked staging root', async () => {
    const root = newRoot()
    const outside = mkdtempSync(join(tmpdir(), 'omh-cache-staging-root-'))
    // A staging root that is itself a link/reparse point is rejected — the
    // real directory must not pre-exist for the link to be created.
    symlinkSync(outside, join(root, REPAIR_STAGING_DIR), 'dir')

    await expect(cleanupRepairStaging(root, new Set())).rejects.toThrow('symbolic link or junction')
  })

  it('removes registered temp files on orderly shutdown', async () => {
    const root = newRoot()
    const repo = makeRepo(root)
    // A corrupt blob referenced by a snapshot so a repair plan can be built.
    const good = 'verified-lfs-payload'
    const blobHash = sha256Hex(good)
    const blob = writeBlob(repo, blobHash, 'corrupted-bytes')
    linkSnapshotFile(repo, COMMIT_A, 'model.safetensors', blob)
    writeRef(repo, 'main', COMMIT_A)
    const manager = managerFor(root, { planDeps: planDeps() })
    const plan = await manager.planAction({ action: 'repair', kind: 'model', repoId: 'org/name' })
    // Simulate a repair temp registered at creation time.
    const staging = join(root, REPAIR_STAGING_DIR, plan.planId)
    mkdirSync(staging, { recursive: true })
    const temp = join(staging, 'tempfile.tmp')
    writeFileSync(temp, 'partial download')
    const internals = manager as unknown as {
      planStore: {
        registerTemp: (id: string, path: string) => void
        shutdown: () => Promise<void>
      }
    }
    internals.planStore.registerTemp(plan.planId, temp)

    await manager.shutdown()

    expect(existsSync(temp)).toBe(false)
  })
})
