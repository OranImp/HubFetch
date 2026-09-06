import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { defaultCacheDir, repoCachePaths } from '@hubfetch/hub-api'
import {
  isValidRepoId,
  type CacheActionPlan,
  type CacheActionPlanRequest,
  type CacheActionResult,
  type CacheApplyFailureReason,
  type CacheActionKind,
  type CachePruneEntry,
  type CacheRepairEntry,
  type CacheReport,
  type CacheVerificationProgress,
  type CacheVerificationReport,
  type ProxySnapshot,
  type RepoKind
} from '@hubfetch/shared'
import type { AccountCredentialLease } from './auth'
import {
  applyPrunePlan,
  applyRepairPlan,
  CacheActionPlanStore,
  cleanupRepairStaging,
  createDefaultRepairTransport,
  PlanError,
  scanPruneTargets,
  scanRepairTargets,
  type CacheRepairTransport,
  type StoredPruneTarget,
  type StoredRepairTarget
} from './cache-plans'
import { CacheVerifier } from './cache-verify'
import type { SettingsStore } from './settings'

/**
 * Main-process dependencies for cache action plans (plan Todo 15). Credentials
 * are leased by account id (Todo 12) and released after apply; endpoint and
 * proxy are frozen into repair plans for stale detection.
 */
export interface CachePlanDeps {
  readonly activeAccountId: () => string | null
  readonly leaseAccountCredential: (accountId: string) => AccountCredentialLease
  readonly currentEndpoint: () => string
  readonly currentProxy: () => ProxySnapshot
  readonly createRepairTransport?: (proxy: ProxySnapshot) => CacheRepairTransport
}

function validateRetainCommits(commits: readonly string[] | undefined): Set<string> {
  const set = new Set<string>()
  for (const commit of commits ?? []) {
    if (!COMMIT_HASH.test(commit)) throw new Error('Invalid retained commit hash')
    set.add(commit)
  }
  return set
}

/** Closed-snapshot equality: same mode, same Manual endpoint when applicable. */
function proxySnapshotsEqual(a: ProxySnapshot, b: ProxySnapshot): boolean {
  if (a.mode !== b.mode) return false
  switch (a.mode) {
    case 'manual':
      return b.mode === 'manual' && a.url === b.url
    case 'system':
    case 'direct':
      return true
  }
}

function failResult(
  action: CacheActionKind,
  planId: string,
  reason: CacheApplyFailureReason,
  message: string
): CacheActionResult {
  return { ok: false, action, planId, bytes: 0, changed: 0, failure: { reason, message } }
}

/**
 * Map an apply failure to a typed result. Unexpected errors get a generic,
 * path-free message: error text from the OS can contain absolute paths and
 * must never cross IPC.
 */
function failureFromError(
  action: CacheActionKind,
  planId: string,
  error: unknown
): CacheActionResult {
  if (error instanceof PlanError) return failResult(action, planId, error.reason, error.message)
  return failResult(action, planId, 'internal', 'Cache action failed; no changes were made')
}

export const COMMIT_HASH = /^[0-9a-f]{40}$/
export const PARTIAL_MAX_AGE_MS = 10 * 60_000
const MAIN_DIR = dirname(fileURLToPath(import.meta.url))

export interface SafeRepo {
  repo: string
  blobsDir: string
  snapshotsDir: string
  refsDir: string
  blobsExist: boolean
  snapshotsExist: boolean
  refsExist: boolean
}

export interface SnapshotDirectory {
  name: string
  path: string
}

interface RevisionDeletionPlan {
  repo: string
  snapshots: string[]
  refs: string[]
  blobs: string[]
  removeRepo: boolean
}

export class CacheManager {
  /**
   * @param protectedTaskIds returns the download task ids whose in-progress
   *   partials are still resumable; their `.incomplete.<id>-*` files are spared
   *   by cleanPartials even when the mtime looks stale (a paused download's
   *   partial has a frozen mtime but is not an orphan).
   * @param protectedCommitHashes returns commits used by active or resumable
   *   downloads for one repository. Renderer input is deliberately not used for
   *   this decision.
   */
  constructor(
    private readonly settings: SettingsStore,
    private readonly protectedTaskIds: () => ReadonlySet<string> = () => new Set(),
    private readonly protectedCommitHashes: (
      kind: RepoKind,
      repoId: string
    ) => ReadonlySet<string> = () => new Set(),
    private readonly planDeps?: CachePlanDeps
  ) {}

  /** Main-memory registry of active prune/repair plans and their temp files. */
  private readonly planStore = new CacheActionPlanStore()
  private readonly verifier = new CacheVerifier()

  cacheDir(): string {
    return this.settings.get().hfCacheDir ?? defaultCacheDir()
  }

  /** Scan runs in a worker thread; the traversal can touch hundreds of GB. */
  scan(): Promise<CacheReport> {
    const cacheDir = this.cacheDir()
    if (!existsSync(cacheDir)) {
      return Promise.resolve({
        root: cacheDir,
        totalSize: 0,
        repos: [],
        scannedAt: new Date().toISOString()
      })
    }
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(join(MAIN_DIR, 'cache-worker.mjs'), {
        workerData: { cacheDir }
      })
      worker.once('message', (report: CacheReport) => {
        resolvePromise(report)
        void worker.terminate()
      })
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`cache scan exited with code ${code}`))
      })
    })
  }

  /**
   * Resolve a repository from its logical identity. This is the only path that
   * cache reveal IPC should use; it applies the same anti-symlink and boundary
   * checks as destructive cache operations.
   */
  async resolveRepo(kind: RepoKind, repoId: string): Promise<string> {
    const safeRepo = await resolveSafeRepo(this.cacheDir(), kind, repoId)
    if (!safeRepo) throw new Error('Repository cache does not exist')
    return safeRepo.repo
  }

  /**
   * Delete snapshot revisions, their refs, and blobs no longer referenced by a
   * remaining snapshot. The repository path is always derived in main from the
   * configured cache root and the logical repository identity.
   */
  async deleteRevisions(
    kind: RepoKind,
    repoId: string,
    commitHashes: string[]
  ): Promise<CacheReport> {
    await deleteRevisionFiles(
      this.cacheDir(),
      kind,
      repoId,
      commitHashes,
      this.protectedCommitHashes(kind, repoId)
    )
    return this.scan()
  }

  /**
   * Delete leftover `*.incomplete*` download partials in a repository's blobs
   * directory. The path is derived and validated in main before any deletion.
   */
  async cleanPartials(kind: RepoKind, repoId: string): Promise<CacheReport> {
    await deleteRepoPartials(this.cacheDir(), kind, repoId, this.protectedTaskIds())
    return this.scan()
  }

  // --- prune/repair action plans (plan Todo 15) --------------------------------

  /**
   * One-time startup sweep: no-follow enumeration of the repair staging root,
   * rejecting link/reparse entries and removing only UUID-named plan
   * directories older than 24 hours (active in-memory plan ids exempt).
   */
  async startup(): Promise<void> {
    await cleanupRepairStaging(this.cacheDir(), this.planStore.activePlanIds())
  }

  /** Abort in-flight applies/verification and remove every registered repair temp file. */
  async shutdown(): Promise<void> {
    this.verifier.cancel()
    await this.planStore.shutdown()
  }

  /**
   * Offline integrity verification. Progress is relative repo ids and counts
   * only — never absolute paths. Cooperative cancel via `cancelVerify`.
   */
  verify(
    onProgress: (progress: CacheVerificationProgress) => void
  ): Promise<CacheVerificationReport> {
    return this.verifier.run(this.cacheDir(), onProgress)
  }

  cancelVerify(): void {
    this.verifier.cancel()
  }

  /**
   * Build an expiring prune/repair plan from logical identity only. The
   * returned plan is sanitized (relative display paths, byte estimates); the
   * absolute targets, expected hashes, and frozen cache root stay in the
   * main-memory registry, covered by the plan digest.
   */
  async planAction(request: CacheActionPlanRequest): Promise<CacheActionPlan> {
    // Before accepting a plan: revalidate the repair staging root.
    await this.startup()
    const retainCommits = validateRetainCommits(request.retainCommits)
    const cacheDir = this.cacheDir()
    const protectedCommits = this.protectedCommitHashes(request.kind, request.repoId)
    const protectedTaskIds = this.protectedTaskIds()

    if (request.action === 'prune') {
      const scan = await scanPruneTargets(cacheDir, request.kind, request.repoId, {
        protectedCommits,
        protectedTaskIds,
        retainCommits
      })
      if (scan.targets.length === 0) throw new Error('no prune candidates found')
      const entries: CachePruneEntry[] = scan.targets.map((target) => ({
        kind: target.targetKind,
        path: target.displayPath,
        name: target.name,
        estimatedBytes: target.sizeBytes
      }))
      return this.planStore.createPrune(
        {
          action: 'prune',
          kind: request.kind,
          repoId: request.repoId,
          scannedAt: scan.scannedAt,
          protectedCommits: [...protectedCommits].sort(),
          protectedTaskIds: [...protectedTaskIds].sort(),
          retainCommits: [...retainCommits].sort(),
          entries,
          estimatedBytes: entries.reduce((acc, entry) => acc + entry.estimatedBytes, 0)
        },
        scan.targets,
        retainCommits,
        resolve(cacheDir)
      )
    }

    // Repair: needs the network environment (endpoint/proxy/account).
    const deps = this.planDeps
    if (!deps) throw new Error('Cache plan dependencies are unavailable')
    const safeRepo = await resolveSafeRepo(cacheDir, request.kind, request.repoId)
    if (!safeRepo) throw new Error('Repository cache does not exist')
    const scan = await scanRepairTargets(cacheDir, request.kind, request.repoId, request.issueIds)
    const accountId = deps.activeAccountId() ?? undefined
    let accountLabel: string | undefined
    if (accountId !== undefined) {
      try {
        const lease = deps.leaseAccountCredential(accountId)
        accountLabel = lease.accountLabel
        lease.release()
      } catch {
        // Account unavailable at plan time; the id is still captured so apply
        // can reject with a clear typed error.
      }
    }
    const entries: CacheRepairEntry[] = scan.targets.map((target) => ({
      issue: target.issue,
      path: target.displayPath,
      repoPath: target.repoPath,
      estimatedBytes: target.estimatedBytes
    }))
    return this.planStore.createRepair(
      {
        action: 'repair',
        kind: request.kind,
        repoId: request.repoId,
        scannedAt: scan.scannedAt,
        resolvedCommit: scan.resolvedCommit,
        endpoint: deps.currentEndpoint(),
        proxy: deps.currentProxy(),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(accountLabel !== undefined ? { accountLabel } : {}),
        protectedCommits: [...protectedCommits].sort(),
        protectedTaskIds: [...protectedTaskIds].sort(),
        entries,
        estimatedBytes: entries.reduce((acc, entry) => acc + entry.estimatedBytes, 0)
      },
      scan.targets,
      resolve(cacheDir)
    )
  }

  /**
   * Apply one plan by id (one-shot). Revalidates expiry, the canonical digest,
   * the protected sets, the frozen environment, and the file identities from a
   * fresh scan BEFORE the first mutation; every failure returns a typed result
   * with zero changes and consumes the plan.
   */
  async applyAction(planId: string): Promise<CacheActionResult> {
    const stored = this.planStore.get(planId)
    if (!stored) {
      return failResult('prune', planId, 'plan-not-found', 'Plan not found or already applied')
    }
    const action = stored.plan.action
    if (new Date(stored.plan.expiresAt) <= new Date()) {
      this.planStore.consume(planId)
      return failResult(action, planId, 'plan-expired', 'Plan expired')
    }
    if (CacheActionPlanStore.computeDigest(stored.digestInput) !== stored.plan.digest) {
      this.planStore.consume(planId)
      return failResult(action, planId, 'plan-digest-mismatch', 'Plan digest mismatch')
    }

    if (action === 'prune') {
      try {
        const result = await applyPrunePlan({
          cacheDir: this.cacheDir(),
          kind: stored.plan.kind,
          repoId: stored.plan.repoId,
          targets: stored.targets as readonly StoredPruneTarget[],
          protectedCommits: this.protectedCommitHashes(stored.plan.kind, stored.plan.repoId),
          protectedTaskIds: this.protectedTaskIds(),
          retainCommits: stored.retainCommits
        })
        this.planStore.consume(planId)
        return { ok: true, action, planId, bytes: result.bytes, changed: result.changed }
      } catch (error) {
        this.planStore.consume(planId)
        return failureFromError(action, planId, error)
      }
    }

    // Repair: environment and account checks come before any filesystem work.
    const plan = stored.plan
    if (plan.action !== 'repair') {
      return failResult('repair', planId, 'internal', 'Plan kind mismatch')
    }
    const deps = this.planDeps
    if (!deps) {
      this.planStore.consume(planId)
      return failResult(
        action,
        planId,
        'plan-stale-environment',
        'Cache plan dependencies are unavailable'
      )
    }
    if (deps.currentEndpoint() !== plan.endpoint) {
      this.planStore.consume(planId)
      return failResult(
        action,
        planId,
        'plan-stale-environment',
        'Hub endpoint changed since the plan'
      )
    }
    if (!proxySnapshotsEqual(deps.currentProxy(), plan.proxy)) {
      this.planStore.consume(planId)
      return failResult(
        action,
        planId,
        'plan-stale-environment',
        'Proxy selection changed since the plan'
      )
    }
    if (resolve(this.cacheDir()) !== stored.cacheDir) {
      this.planStore.consume(planId)
      return failResult(
        action,
        planId,
        'plan-stale-environment',
        'Cache directory changed since the plan'
      )
    }
    let lease: AccountCredentialLease | undefined
    if (plan.accountId !== undefined) {
      if ((deps.activeAccountId() ?? undefined) !== plan.accountId) {
        this.planStore.consume(planId)
        return failResult(
          action,
          planId,
          'plan-stale-account',
          'Active account changed since the plan'
        )
      }
      try {
        lease = deps.leaseAccountCredential(plan.accountId)
      } catch {
        this.planStore.consume(planId)
        return failResult(
          action,
          planId,
          'account-unavailable',
          'The account for this repair is unavailable'
        )
      }
    }
    const transport = deps.createRepairTransport
      ? deps.createRepairTransport(plan.proxy)
      : createDefaultRepairTransport(plan.proxy)
    try {
      const result = await applyRepairPlan(
        {
          cacheDir: this.cacheDir(),
          kind: plan.kind,
          repoId: plan.repoId,
          plan,
          targets: stored.targets as readonly StoredRepairTarget[],
          authToken: lease?.accessToken,
          transport,
          protectedCommits: this.protectedCommitHashes(plan.kind, plan.repoId),
          signal: this.planStore.signalFor(planId)
        },
        {
          planId,
          registerTemp: (id, path) => this.planStore.registerTemp(id, path),
          releaseTemp: (id, path, succeeded) => this.planStore.releaseTemp(id, path, succeeded)
        }
      )
      this.planStore.consume(planId)
      return { ok: true, action, planId, bytes: result.bytes, changed: result.changed }
    } catch (error) {
      this.planStore.consume(planId)
      return failureFromError(action, planId, error)
    } finally {
      await transport.close().catch(() => undefined)
      lease?.release()
    }
  }
}

/**
 * Filesystem half of deleteRevisions, exported for focused tests. It performs a
 * complete read-only preflight before the first mutation so one unsafe revision,
 * ref, blob, symlink, or junction cannot leave a partially deleted repository.
 *
 * Blob GC only runs when references are provable: the copy-fallback layout
 * (Windows without the symlink privilege) yields zero symlinks, and treating its
 * blobs as unreferenced would wipe the store. With revisions remaining and no
 * detectable references, blob GC is skipped entirely.
 */
export async function deleteRevisionFiles(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  commitHashes: string[],
  protectedCommitHashes: ReadonlySet<string> = new Set()
): Promise<void> {
  const hashes = validateCommitHashes(commitHashes)
  const protectedHash = hashes.find((hash) => protectedCommitHashes.has(hash))
  if (protectedHash) {
    throw new Error(`Cannot delete revision used by an active download: ${protectedHash}`)
  }

  const safeRepo = await resolveSafeRepo(cacheDir, kind, repoId)
  if (!safeRepo) return

  const plan = await prepareRevisionDeletion(safeRepo, hashes)
  if (!plan) return

  // All paths and contents were validated above. No mutation happens before
  // this point, preserving all-or-nothing behavior for validation failures.
  for (const snapshot of plan.snapshots) {
    await rm(snapshot, { recursive: true, force: true })
  }
  for (const ref of plan.refs) await unlink(ref)
  for (const blob of plan.blobs) await rm(blob, { force: true })
  if (plan.removeRepo) await rm(plan.repo, { recursive: true, force: true })
}

/**
 * Delete leftover `*.incomplete*` partials from a logically addressed repo.
 * Every blobs entry is validated before stale candidates are removed, preventing
 * a malicious blobs symlink/junction from redirecting cleanup outside the cache.
 */
export async function deleteRepoPartials(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  protectedTaskIds: ReadonlySet<string> = new Set()
): Promise<void> {
  const safeRepo = await resolveSafeRepo(cacheDir, kind, repoId)
  if (!safeRepo?.blobsExist) return

  const stalePartials: string[] = []
  const protectedMarkers = [...protectedTaskIds].map((id) => `.incomplete.${id}`)
  for (const name of await readdir(safeRepo.blobsDir)) {
    const full = join(safeRepo.blobsDir, name)
    const entry = await lstat(full)
    assertRegularFile(entry, `blob ${name}`)
    assertDirectChild(safeRepo.blobsDir, await realpath(full), `blob ${name}`)

    if (!name.includes('.incomplete')) continue
    if (protectedMarkers.some((marker) => name.includes(marker))) continue
    if (Date.now() - entry.mtimeMs < PARTIAL_MAX_AGE_MS) continue
    stalePartials.push(full)
  }

  // The loop above is a complete read-only preflight of the blobs directory.
  for (const partial of stalePartials) await rm(partial, { force: true })
}

async function prepareRevisionDeletion(
  safeRepo: SafeRepo,
  hashes: string[]
): Promise<RevisionDeletionPlan | null> {
  const snapshots = await inspectSnapshotDirectories(safeRepo)
  const selected = snapshots.filter(({ name }) => hashes.includes(name))
  if (selected.length === 0) return null

  const remaining = snapshots.filter(({ name }) => !hashes.includes(name))
  const blobFiles = await inspectBlobFiles(safeRepo)
  const refFiles = await inspectRefFiles(safeRepo)

  // Validate every selected tree too. `rm` unlinks leaf symlinks rather than
  // following them, but accepting a link outside blobs would make the safety
  // invariant hard to audit and could become dangerous after a future refactor.
  for (const snapshot of selected) {
    await collectSnapshotReferences(snapshot.path, safeRepo, new Set())
  }

  const referenced = new Set<string>()
  for (const snapshot of remaining) {
    await collectSnapshotReferences(snapshot.path, safeRepo, referenced)
  }

  const refs: string[] = []
  for (const refPath of refFiles) {
    const target = (await readFile(refPath, 'utf8')).trim()
    if (hashes.includes(target)) refs.push(refPath)
  }

  const blobs: string[] = []
  if (remaining.length === 0 || referenced.size > 0) {
    for (const { name, path } of blobFiles) {
      if (!referenced.has(path) && !name.includes('.incomplete')) blobs.push(path)
    }
  }

  if (remaining.length === 0) await validateExtraRepoEntries(safeRepo)

  return {
    repo: safeRepo.repo,
    snapshots: selected.map(({ path }) => path),
    refs,
    blobs,
    removeRepo: remaining.length === 0
  }
}

export async function resolveSafeRepo(
  cacheDir: string,
  kind: RepoKind,
  repoId: string
): Promise<SafeRepo | null> {
  if (!isAbsolute(cacheDir)) throw new Error('Cache directory must be absolute')
  if (!isValidRepoId(repoId)) throw new Error('Invalid repository id')

  const cacheRoot = resolve(cacheDir)
  const derived = repoCachePaths(cacheRoot, kind, repoId)
  const expectedRepo = resolve(derived.repoDir)
  const expectedRelative = relative(cacheRoot, expectedRepo)
  if (!isSinglePathSegment(expectedRelative)) {
    throw new Error('Derived repository path is outside the configured cache directory')
  }

  const rootEntry = await lstatIfExists(cacheRoot)
  if (!rootEntry) return null
  assertDirectory(rootEntry, 'cache root')
  const realRoot = await realpath(cacheRoot)

  const repoEntry = await lstatIfExists(expectedRepo)
  if (!repoEntry) return null
  assertDirectory(repoEntry, 'repository')
  const realRepo = await realpath(expectedRepo)
  const actualRelative = relative(realRoot, realRepo)
  if (actualRelative !== expectedRelative || !isSinglePathSegment(actualRelative)) {
    throw new Error('Repository resolves outside the configured cache directory')
  }

  const blobs = await resolveStructuralDirectory(realRepo, 'blobs')
  const snapshots = await resolveStructuralDirectory(realRepo, 'snapshots')
  const refs = await resolveStructuralDirectory(realRepo, 'refs')
  return {
    repo: realRepo,
    blobsDir: blobs.path,
    snapshotsDir: snapshots.path,
    refsDir: refs.path,
    blobsExist: blobs.exists,
    snapshotsExist: snapshots.exists,
    refsExist: refs.exists
  }
}

async function resolveStructuralDirectory(
  repo: string,
  name: 'blobs' | 'snapshots' | 'refs'
): Promise<{ path: string; exists: boolean }> {
  const path = join(repo, name)
  const entry = await lstatIfExists(path)
  if (!entry) return { path, exists: false }
  assertDirectory(entry, name)
  const real = await realpath(path)
  if (relative(repo, real) !== name) {
    throw new Error(`Unsafe cache path: ${name} resolves outside its repository`)
  }
  return { path: real, exists: true }
}

export async function inspectSnapshotDirectories(safeRepo: SafeRepo): Promise<SnapshotDirectory[]> {
  if (!safeRepo.snapshotsExist) return []
  const snapshots: SnapshotDirectory[] = []
  for (const name of await readdir(safeRepo.snapshotsDir)) {
    const path = join(safeRepo.snapshotsDir, name)
    const entry = await lstat(path)
    assertDirectory(entry, `snapshot ${name}`)
    const real = await realpath(path)
    assertDirectChild(safeRepo.snapshotsDir, real, `snapshot ${name}`)
    snapshots.push({ name, path: real })
  }
  return snapshots
}

export async function inspectBlobFiles(
  safeRepo: SafeRepo
): Promise<Array<{ name: string; path: string }>> {
  if (!safeRepo.blobsExist) return []
  const blobs: Array<{ name: string; path: string }> = []
  for (const name of await readdir(safeRepo.blobsDir)) {
    const path = join(safeRepo.blobsDir, name)
    const entry = await lstat(path)
    assertRegularFile(entry, `blob ${name}`)
    const real = await realpath(path)
    assertDirectChild(safeRepo.blobsDir, real, `blob ${name}`)
    blobs.push({ name, path: real })
  }
  return blobs
}

export async function inspectRefFiles(safeRepo: SafeRepo): Promise<string[]> {
  if (!safeRepo.refsExist) return []
  return listRegularFilesRecursive(safeRepo.refsDir, safeRepo.refsDir, 'ref')
}

async function listRegularFilesRecursive(
  directory: string,
  boundary: string,
  label: string
): Promise<string[]> {
  const files: string[] = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      throw new Error(`Unsafe cache path: ${label} ${name} is a symbolic link or junction`)
    }
    if (entry.isDirectory()) {
      const real = await realpath(path)
      assertContained(boundary, real, `${label} directory ${name}`)
      files.push(...(await listRegularFilesRecursive(real, boundary, label)))
      continue
    }
    assertRegularFile(entry, `${label} ${name}`)
    const real = await realpath(path)
    assertContained(boundary, real, `${label} ${name}`)
    files.push(real)
  }
  return files
}

export async function collectSnapshotReferences(
  directory: string,
  safeRepo: SafeRepo,
  out: Set<string>
): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isDirectory()) {
      const real = await realpath(path)
      assertContained(directory, real, `snapshot directory ${name}`)
      await collectSnapshotReferences(real, safeRepo, out)
      continue
    }
    if (entry.isSymbolicLink()) {
      if (!safeRepo.blobsExist) {
        throw new Error(`Unsafe cache path: snapshot link ${name} has no blobs directory`)
      }
      const target = resolve(dirname(path), await readlink(path))
      assertContained(safeRepo.blobsDir, target, `snapshot link ${name}`)
      const targetEntry = await lstatIfExists(target)
      if (!targetEntry) throw new Error(`Unsafe cache path: snapshot link ${name} is broken`)
      assertRegularFile(targetEntry, `snapshot link target ${name}`)
      const realTarget = await realpath(target)
      assertDirectChild(safeRepo.blobsDir, realTarget, `snapshot link ${name}`)
      out.add(realTarget)
      continue
    }
    assertRegularFile(entry, `snapshot file ${name}`)
  }
}

/** Validate non-standard repo entries before recursively removing the last snapshot. */
async function validateExtraRepoEntries(safeRepo: SafeRepo): Promise<void> {
  for (const name of await readdir(safeRepo.repo)) {
    if (name === 'blobs' || name === 'snapshots' || name === 'refs') continue
    await validateNoLinks(join(safeRepo.repo, name), safeRepo.repo)
  }
}

export async function validateNoLinks(path: string, boundary: string): Promise<void> {
  const entry = await lstat(path)
  if (entry.isSymbolicLink()) {
    throw new Error(`Unsafe cache path: ${relative(boundary, path)} is a symbolic link or junction`)
  }
  if (entry.isDirectory()) {
    const real = await realpath(path)
    assertContained(boundary, real, `directory ${relative(boundary, path)}`)
    for (const name of await readdir(real)) await validateNoLinks(join(real, name), boundary)
    return
  }
  assertRegularFile(entry, `entry ${relative(boundary, path)}`)
  assertContained(boundary, await realpath(path), `entry ${relative(boundary, path)}`)
}

export function validateCommitHashes(commitHashes: string[]): string[] {
  if (commitHashes.length < 1 || commitHashes.length > 100) {
    throw new Error('Expected between 1 and 100 commit hashes')
  }
  const hashes = [...new Set(commitHashes)]
  if (hashes.some((hash) => !COMMIT_HASH.test(hash))) throw new Error('Invalid commit hash')
  return hashes
}

export function assertDirectory(entry: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (entry.isSymbolicLink()) {
    throw new Error(`Unsafe cache path: ${label} is a symbolic link or junction`)
  }
  if (!entry.isDirectory()) throw new Error(`Unsafe cache path: ${label} is not a directory`)
}

export function assertRegularFile(entry: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (entry.isSymbolicLink()) {
    throw new Error(`Unsafe cache path: ${label} is a symbolic link or junction`)
  }
  if (!entry.isFile()) throw new Error(`Unsafe cache path: ${label} is not a regular file`)
}

export function assertDirectChild(parent: string, child: string, label: string): void {
  const rel = relative(parent, child)
  if (!isSinglePathSegment(rel)) {
    throw new Error(`Unsafe cache path: ${label} resolves outside its parent`)
  }
}

function assertContained(parent: string, child: string, label: string): void {
  const rel = relative(parent, child)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe cache path: ${label} resolves outside its parent`)
  }
}

function isSinglePathSegment(path: string): boolean {
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path) &&
    !path.includes(sep)
  )
}

export async function lstatIfExists(
  path: string
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
