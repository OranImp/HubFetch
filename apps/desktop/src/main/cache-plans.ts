/**
 * Expiring main-owned prune and repair plans for the HF cache (plan Todo 15).
 *
 * A plan is created, stored, and digested by the MAIN process. The renderer
 * only ever sees a sanitized summary: logical repo identity, relative display
 * paths, and byte estimates. Absolute paths, expected content hashes, and the
 * frozen cache root live in a main-memory registry keyed by an unguessable
 * plan ID and never cross IPC.
 *
 * Safety model (mirrors `deleteRevisionFiles` / the download plan system):
 *  - Planning is a complete read-only scan; nothing is deleted on verify.
 *  - Apply re-opens and re-scans the filesystem, then compares expiry, digest,
 *    protected sets, and file identities BEFORE the first mutation. Deletion
 *    paths always come from the FRESH scan, never from the stored plan.
 *  - Repair downloads each affected file into a main-owned staging directory
 *    `<cacheRoot>/.hubfetch-repair/<planId>/`, verifies the expected LFS
 *    SHA-256 or Git blob SHA-1, and atomically renames it over the corrupt
 *    blob only after a second fresh file-identity check. Every temp file is
 *    registered at creation and removed in `finally` on any failure; only a
 *    successful atomic replacement clears its registry entry.
 *  - Prune is offline. Repair is the only network path; offline repair returns
 *    a typed `network` failure with zero changes.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink
} from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { RESOLVE_PREFIX } from '@hubfetch/hub-api'
import type {
  CacheActionPlan,
  CacheApplyFailureReason,
  CachePruneEntry,
  CacheRepairEntry,
  CacheVerificationIssue,
  ProxySnapshot,
  RepoKind
} from '@hubfetch/shared'
import {
  COMMIT_HASH,
  PARTIAL_MAX_AGE_MS,
  assertDirectChild,
  assertDirectory,
  assertRegularFile,
  collectSnapshotReferences,
  inspectBlobFiles,
  inspectRefFiles,
  inspectSnapshotDirectories,
  lstatIfExists,
  resolveSafeRepo,
  validateNoLinks,
  type SafeRepo
} from './cache'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Plan TTL — same 15-minute window as the download plan system (Todo 17). */
export const CACHE_PLAN_TTL_MS = 15 * 60 * 1000

/** Main-owned staging root for repair downloads, inside the cache root. */
export const REPAIR_STAGING_DIR = '.hubfetch-repair'

/** Startup sweep removes only UUID-named staging dirs older than this. */
export const REPAIR_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const BLOB_HEX = /^(?:[0-9a-f]{64}|[0-9a-f]{40})$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_CONCURRENCY = 4
const USER_AGENT = 'HubFetch cache-repair'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Typed plan failure; `reason` maps onto the closed CacheApplyFailureReason union. */
export class PlanError extends Error {
  constructor(
    readonly reason: CacheApplyFailureReason,
    message: string
  ) {
    super(message)
    this.name = 'PlanError'
  }
}

// ---------------------------------------------------------------------------
// Stored (main-only) plan shapes
// ---------------------------------------------------------------------------

export interface StoredPruneTarget {
  targetKind: 'detached-snapshot' | 'orphan-blob' | 'stale-partial'
  /** Absolute validated path captured at scan time; apply re-derives fresh. */
  absPath: string
  /** Snapshot commit, blob hash, or partial file name. */
  name: string
  /** Measured bytes at scan time; apply requires an exact match. */
  sizeBytes: number
  /** Relative display path from the real cache root (forward slashes). */
  displayPath: string
}

export interface StoredRepairTarget {
  issue: CacheVerificationIssue
  /** 40-hex commit the entry is mapped to (one per plan). */
  commit: string
  /** Repo-relative file path inside the snapshot (forward slashes). */
  repoPath: string
  /** Absolute snapshot file path (link or copy) captured at scan time. */
  snapshotFilePath: string
  /** Absolute snapshot directory captured at scan time. */
  snapshotDir: string
  /** Content-address blob name; null for unmatched copies (resolved from etag). */
  blobHash: string | null
  /** Expected content hash; null ⇒ confirmed from the Hub etag at apply. */
  expectedHash: string | null
  hashKind: 'sha256' | 'sha1'
  /** True when the snapshot entry is a symlink (link layout). */
  isLink: boolean
  estimatedBytes: number
  /** Relative display path from the real cache root (forward slashes). */
  displayPath: string
}

interface StoredCachePlan {
  plan: CacheActionPlan
  targets: readonly StoredPruneTarget[] | readonly StoredRepairTarget[]
  /** Digest input: sanitized plan fields + registry-only absolute details. */
  digestInput: object
  /** Frozen cache root (main-only; a change rejects the plan as stale). */
  cacheDir: string
  /** Prune only: user-selected retained revisions frozen at plan time. */
  retainCommits: ReadonlySet<string>
  timer: NodeJS.Timeout
  controller: AbortController
  /** Registered repair temp files pending atomic replacement or cleanup. */
  temps: Set<string>
}

// ---------------------------------------------------------------------------
// Plan store (main memory)
// ---------------------------------------------------------------------------

/**
 * Main-memory registry of active plans. Plans expire after 15 minutes via a
 * timer; apply re-checks expiry and the canonical digest before mutating.
 */
export class CacheActionPlanStore {
  private readonly plans = new Map<string, StoredCachePlan>()

  /** Canonical SHA-256 over the plan content (same pattern as DownloadManager). */
  static computeDigest(base: object): string {
    const canonical = JSON.stringify(base, Object.keys(base).sort())
    return createHash('sha256').update(canonical).digest('hex')
  }

  createPrune(
    base: {
      action: 'prune'
      kind: RepoKind
      repoId: string
      scannedAt: string
      protectedCommits: readonly string[]
      protectedTaskIds: readonly string[]
      retainCommits: readonly string[]
      entries: readonly CachePruneEntry[]
      estimatedBytes: number
    },
    targets: readonly StoredPruneTarget[],
    retainCommits: ReadonlySet<string>,
    cacheDir: string
  ): CacheActionPlan {
    return this.create(base, targets, retainCommits, cacheDir)
  }

  createRepair(
    base: {
      action: 'repair'
      kind: RepoKind
      repoId: string
      scannedAt: string
      resolvedCommit: string
      endpoint: string
      proxy: ProxySnapshot
      accountId?: string
      accountLabel?: string
      protectedCommits: readonly string[]
      protectedTaskIds: readonly string[]
      entries: readonly CacheRepairEntry[]
      estimatedBytes: number
    },
    targets: readonly StoredRepairTarget[],
    cacheDir: string
  ): CacheActionPlan {
    return this.create(base, targets, new Set(), cacheDir)
  }

  private create(
    base: object,
    targets: readonly StoredPruneTarget[] | readonly StoredRepairTarget[],
    retainCommits: ReadonlySet<string>,
    cacheDir: string
  ): CacheActionPlan {
    // The digest covers the sanitized plan fields AND the registry-only
    // absolute paths/expected hashes/frozen cache root, so any tampering with
    // the stored plan is detected before the first mutation.
    const digestInput = { ...base, targets, cacheDir }
    const digest = CacheActionPlanStore.computeDigest(digestInput)
    const planId = randomUUID()
    const expiresAt = new Date(Date.now() + CACHE_PLAN_TTL_MS).toISOString()
    const plan = { planId, ...base, expiresAt, digest } as CacheActionPlan
    const timer = setTimeout(() => {
      this.plans.delete(planId)
    }, CACHE_PLAN_TTL_MS)
    timer.unref()
    this.plans.set(planId, {
      plan,
      targets,
      digestInput,
      cacheDir,
      retainCommits,
      timer,
      controller: new AbortController(),
      temps: new Set()
    })
    return plan
  }

  get(planId: string): StoredCachePlan | undefined {
    return this.plans.get(planId)
  }

  /** One-shot consumption: clears the expiry timer and drops the plan. */
  consume(planId: string): void {
    const stored = this.plans.get(planId)
    if (!stored) return
    clearTimeout(stored.timer)
    this.plans.delete(planId)
  }

  activePlanIds(): Set<string> {
    return new Set(this.plans.keys())
  }

  signalFor(planId: string): AbortSignal | undefined {
    return this.plans.get(planId)?.controller.signal
  }

  /** Register a repair temp file at creation time. */
  registerTemp(planId: string, path: string): void {
    this.plans.get(planId)?.temps.add(path)
  }

  /**
   * Clear a temp registry entry. On success the file was consumed by the
   * atomic rename; on any other path the file is removed here (the caller
   * runs this in `finally`).
   */
  async releaseTemp(planId: string, path: string, succeeded: boolean): Promise<void> {
    this.plans.get(planId)?.temps.delete(path)
    if (!succeeded) await rm(path, { force: true }).catch(() => undefined)
  }

  /** Orderly shutdown: abort in-flight applies, remove every registered temp. */
  async shutdown(): Promise<void> {
    for (const [planId, stored] of this.plans) {
      stored.controller.abort()
      clearTimeout(stored.timer)
      for (const temp of stored.temps) {
        await rm(temp, { force: true }).catch(() => undefined)
      }
      stored.temps.clear()
      this.plans.delete(planId)
    }
  }
}

// ---------------------------------------------------------------------------
// Shared hashing helpers (streaming, bounded memory)
// ---------------------------------------------------------------------------

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function gitBlobSha1OfFile(path: string, size: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha1')
    hash.update(`blob ${size}\0`)
    const stream = createReadStream(path)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = []
  let i = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(concurrency, Math.max(items.length, 1)); w++) {
    workers.push(
      (async () => {
        while (i < items.length) {
          const idx = i++
          results[idx] = await fn(items[idx]!)
        }
      })()
    )
  }
  await Promise.all(workers)
  return results
}

function displayPathOf(realRoot: string, absPath: string): string {
  return relative(realRoot, absPath).replace(/\\/g, '/')
}

/** Recursive byte size of a directory; symlinks contribute nothing. */
async function directorySize(directory: string): Promise<number> {
  let total = 0
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      total += await directorySize(await realpath(path))
      continue
    }
    if (entry.isFile()) total += Number(entry.size)
  }
  return total
}

// ---------------------------------------------------------------------------
// Prune scan (read-only)
// ---------------------------------------------------------------------------

export interface PruneScanOptions {
  protectedCommits: ReadonlySet<string>
  protectedTaskIds: ReadonlySet<string>
  retainCommits: ReadonlySet<string>
}

export interface PruneScan {
  scannedAt: string
  targets: StoredPruneTarget[]
}

/**
 * Read-only prune scan for one repository. Candidates:
 *  - detached snapshots: 40-hex commit dirs with no ref pointing at them,
 *    excluded when protected by a live download or user-retained;
 *  - orphaned blobs: hex-named, non-partial blobs not referenced by any
 *    remaining snapshot (only when references are provable — the copy-fallback
 *    layout yields zero symlinks, mirroring deleteRevisionFiles);
 *  - stale partials: `*.incomplete*` files older than PARTIAL_MAX_AGE_MS whose
 *    task id is no longer resumable.
 * Refs are NEVER candidates.
 */
export async function scanPruneTargets(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  opts: PruneScanOptions
): Promise<PruneScan> {
  const scannedAt = new Date().toISOString()
  const safeRepo = await resolveSafeRepo(cacheDir, kind, repoId)
  if (!safeRepo) return { scannedAt, targets: [] }
  const realRoot = dirname(safeRepo.repo)

  const snapshots = await inspectSnapshotDirectories(safeRepo)
  const refTargets = new Set<string>()
  for (const refPath of await inspectRefFiles(safeRepo)) {
    refTargets.add((await readFile(refPath, 'utf8')).trim())
  }

  const detached: typeof snapshots = []
  const remaining: typeof snapshots = []
  for (const snapshot of snapshots) {
    // Unknown-shape snapshot dirs are never prune candidates.
    if (!COMMIT_HASH.test(snapshot.name)) {
      remaining.push(snapshot)
      continue
    }
    if (refTargets.has(snapshot.name)) {
      remaining.push(snapshot)
      continue
    }
    if (opts.protectedCommits.has(snapshot.name) || opts.retainCommits.has(snapshot.name)) {
      remaining.push(snapshot)
      continue
    }
    detached.push(snapshot)
  }

  const referenced = new Set<string>()
  for (const snapshot of remaining) {
    await collectSnapshotReferences(snapshot.path, safeRepo, referenced)
  }

  const targets: StoredPruneTarget[] = []
  for (const snapshot of detached) {
    targets.push({
      targetKind: 'detached-snapshot',
      absPath: snapshot.path,
      name: snapshot.name,
      sizeBytes: await directorySize(snapshot.path),
      displayPath: displayPathOf(realRoot, snapshot.path)
    })
  }

  // Blob GC only when references are provable (copy-fallback-safe).
  if (remaining.length === 0 || referenced.size > 0) {
    for (const blob of await inspectBlobFiles(safeRepo)) {
      if (blob.name.includes('.incomplete')) continue
      if (!BLOB_HEX.test(blob.name)) continue
      if (referenced.has(blob.path)) continue
      const entry = await lstat(blob.path)
      targets.push({
        targetKind: 'orphan-blob',
        absPath: blob.path,
        name: blob.name,
        sizeBytes: Number(entry.size),
        displayPath: displayPathOf(realRoot, blob.path)
      })
    }
  }

  const protectedMarkers = [...opts.protectedTaskIds].map((id) => `.incomplete.${id}`)
  for (const blob of await inspectBlobFiles(safeRepo)) {
    if (!blob.name.includes('.incomplete')) continue
    if (protectedMarkers.some((marker) => blob.name.includes(marker))) continue
    const entry = await lstat(blob.path)
    if (Date.now() - Number(entry.mtimeMs) < PARTIAL_MAX_AGE_MS) continue
    targets.push({
      targetKind: 'stale-partial',
      absPath: blob.path,
      name: blob.name,
      sizeBytes: Number(entry.size),
      displayPath: displayPathOf(realRoot, blob.path)
    })
  }

  return { scannedAt, targets }
}

/**
 * Apply a prune plan. Re-scans the repository fresh and requires EVERY
 * planned target to still be present, eligible, and byte-identical in the
 * fresh scan — otherwise a typed stale rejection is thrown BEFORE the first
 * mutation. Deletion uses only fresh-scan paths.
 */
export async function applyPrunePlan(input: {
  cacheDir: string
  kind: RepoKind
  repoId: string
  targets: readonly StoredPruneTarget[]
  protectedCommits: ReadonlySet<string>
  protectedTaskIds: ReadonlySet<string>
  retainCommits: ReadonlySet<string>
}): Promise<{ bytes: number; changed: number }> {
  const fresh = await scanPruneTargets(input.cacheDir, input.kind, input.repoId, {
    protectedCommits: input.protectedCommits,
    protectedTaskIds: input.protectedTaskIds,
    retainCommits: input.retainCommits
  })
  const freshByKey = new Map(fresh.targets.map((t) => [`${t.targetKind}\u0000${t.name}`, t]))

  const matched: StoredPruneTarget[] = []
  for (const target of input.targets) {
    const now = freshByKey.get(`${target.targetKind}\u0000${target.name}`)
    if (!now) {
      const protectedNow =
        target.targetKind === 'detached-snapshot' &&
        (input.protectedCommits.has(target.name) || input.retainCommits.has(target.name))
      throw new PlanError(
        protectedNow ? 'plan-stale-protected' : 'plan-stale-filesystem',
        `prune target is no longer eligible: ${target.name}`
      )
    }
    if (now.sizeBytes !== target.sizeBytes) {
      throw new PlanError(
        'plan-stale-filesystem',
        `prune target changed since the plan was created: ${target.name}`
      )
    }
    matched.push(now)
  }
  if (matched.length === 0) {
    throw new PlanError('plan-stale-filesystem', 'prune plan has no remaining eligible targets')
  }

  let bytes = 0
  for (const target of matched) {
    bytes += target.sizeBytes
    if (target.targetKind === 'detached-snapshot') {
      await rm(target.absPath, { recursive: true, force: true })
    } else {
      await rm(target.absPath, { force: true })
    }
  }
  return { bytes, changed: matched.length }
}

// ---------------------------------------------------------------------------
// Repair scan (read-only, repo-scoped Todo 14 re-verification)
// ---------------------------------------------------------------------------

interface DetectedIssue {
  issue: CacheVerificationIssue
  displayPath: string
  /** Snapshot commit; null for blob-path issues. */
  commit: string | null
  repoPath: string | null
  isLink: boolean | null
  /** Known expected blob hash (link target name); null when resolved at apply. */
  targetName: string | null
  sizeBytes: number
  snapshotFilePath: string | null
  snapshotDir: string | null
}

interface RepairScanState {
  issues: Map<string, DetectedIssue>
  /** Valid-shaped snapshot links: resolved blob path → referencing snapshots. */
  linkRefs: Map<string, Array<{ commit: string; repoPath: string; snapshotFilePath: string }>>
  verifiedBlobs: Set<string>
}

async function hashBlobEntry(blob: {
  name: string
  path: string
  kind: 'sha256' | 'sha1'
}): Promise<{ ok: boolean; size: number }> {
  let entry
  try {
    entry = await lstat(blob.path)
  } catch {
    return { ok: false, size: 0 }
  }
  if (!entry.isFile()) return { ok: false, size: 0 }
  try {
    const digest =
      blob.kind === 'sha256'
        ? await sha256OfFile(blob.path)
        : await gitBlobSha1OfFile(blob.path, entry.size)
    return { ok: digest === blob.name, size: entry.size }
  } catch {
    return { ok: false, size: entry.size }
  }
}

async function walkSnapshotForRepair(
  state: RepairScanState,
  safeRepo: SafeRepo,
  realRoot: string,
  snapshot: { name: string; path: string },
  directory: string,
  prefix: string
): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const repoPath = prefix ? `${prefix}/${name}` : name
    const displayPath = displayPathOf(realRoot, path)
    let entry
    try {
      entry = await lstat(path)
    } catch {
      state.issues.set(displayPath, {
        issue: 'unreadable',
        displayPath,
        commit: snapshot.name,
        repoPath,
        isLink: null,
        targetName: null,
        sizeBytes: 0,
        snapshotFilePath: path,
        snapshotDir: snapshot.path
      })
      continue
    }
    if (entry.isSymbolicLink()) {
      let target: string
      try {
        target = await readlink(path)
      } catch {
        state.issues.set(displayPath, {
          issue: 'unreadable',
          displayPath,
          commit: snapshot.name,
          repoPath,
          isLink: true,
          targetName: null,
          sizeBytes: 0,
          snapshotFilePath: path,
          snapshotDir: snapshot.path
        })
        continue
      }
      const resolved = resolve(dirname(path), target)
      const resolvedRel = relative(safeRepo.blobsDir, resolved)
      const shapeOk =
        resolvedRel !== '' &&
        resolvedRel !== '..' &&
        !resolvedRel.startsWith(`..${sep}`) &&
        !isAbsolute(resolvedRel) &&
        !resolvedRel.includes(sep)
      if (!shapeOk) {
        state.issues.set(displayPath, {
          issue: 'snapshot-escape',
          displayPath,
          commit: snapshot.name,
          repoPath,
          isLink: true,
          targetName: null,
          sizeBytes: 0,
          snapshotFilePath: path,
          snapshotDir: snapshot.path
        })
        continue
      }
      const blobPath = join(safeRepo.blobsDir, resolvedRel)
      const targetEntry = await lstatIfExists(blobPath)
      if (!targetEntry || targetEntry.isSymbolicLink() || !targetEntry.isFile()) {
        state.issues.set(displayPath, {
          issue: 'broken-snapshot-link',
          displayPath,
          commit: snapshot.name,
          repoPath,
          isLink: true,
          targetName: resolvedRel,
          sizeBytes: 0,
          snapshotFilePath: path,
          snapshotDir: snapshot.path
        })
        continue
      }
      // Record the reference even when the target content is corrupt: the
      // corrupt blob is provably referenced by this snapshot.
      const refs = state.linkRefs.get(blobPath) ?? []
      refs.push({ commit: snapshot.name, repoPath, snapshotFilePath: path })
      state.linkRefs.set(blobPath, refs)
      if (!BLOB_HEX.test(resolvedRel)) {
        state.issues.set(displayPath, {
          issue: 'invalid-blob-name',
          displayPath,
          commit: snapshot.name,
          repoPath,
          isLink: true,
          targetName: resolvedRel,
          sizeBytes: 0,
          snapshotFilePath: path,
          snapshotDir: snapshot.path
        })
        continue
      }
      const size = Number(targetEntry.size)
      const digest = HEX64.test(resolvedRel)
        ? await sha256OfFile(blobPath)
        : await gitBlobSha1OfFile(blobPath, size)
      if (digest !== resolvedRel) {
        // Keyed by the BLOB display path so the phase-1 blob scan and the
        // phase-2 link verification dedupe onto one repair target.
        const blobDisplay = displayPathOf(realRoot, blobPath)
        state.issues.set(blobDisplay, {
          issue: 'hash-mismatch',
          displayPath: blobDisplay,
          commit: null,
          repoPath: null,
          isLink: null,
          targetName: resolvedRel,
          sizeBytes: size,
          snapshotFilePath: null,
          snapshotDir: null
        })
      }
      continue
    }
    if (entry.isDirectory()) {
      const real = await realpath(path)
      await walkSnapshotForRepair(state, safeRepo, realRoot, snapshot, real, repoPath)
      continue
    }
    if (entry.isFile()) {
      // Copy-fallback layout: content must match a verified blob name.
      let digest: string
      try {
        digest = await sha256OfFile(path)
      } catch {
        state.issues.set(displayPath, {
          issue: 'unreadable',
          displayPath,
          commit: snapshot.name,
          repoPath,
          isLink: false,
          targetName: null,
          sizeBytes: entry.size,
          snapshotFilePath: path,
          snapshotDir: snapshot.path
        })
        continue
      }
      if (state.verifiedBlobs.has(digest)) continue
      try {
        digest = await gitBlobSha1OfFile(path, entry.size)
      } catch {
        state.issues.set(displayPath, {
          issue: 'unreadable',
          displayPath,
          commit: snapshot.name,
          repoPath,
          isLink: false,
          targetName: null,
          sizeBytes: entry.size,
          snapshotFilePath: path,
          snapshotDir: snapshot.path
        })
        continue
      }
      if (state.verifiedBlobs.has(digest)) continue
      state.issues.set(displayPath, {
        issue: 'unmatched-snapshot-copy',
        displayPath,
        commit: snapshot.name,
        repoPath,
        isLink: false,
        targetName: null,
        sizeBytes: entry.size,
        snapshotFilePath: path,
        snapshotDir: snapshot.path
      })
      continue
    }
    // Any other entry type (reparse point, device, …) — never traversed.
    state.issues.set(displayPath, {
      issue: 'snapshot-escape',
      displayPath,
      commit: snapshot.name,
      repoPath,
      isLink: null,
      targetName: null,
      sizeBytes: 0,
      snapshotFilePath: path,
      snapshotDir: snapshot.path
    })
  }
}

export interface RepairScan {
  scannedAt: string
  resolvedCommit: string
  targets: StoredRepairTarget[]
}

/**
 * Read-only repo-scoped re-verification (same closed issue codes as the Todo
 * 14 worker) and mapping of the requested issue ids onto repair targets at
 * ONE resolved commit. Throws a typed PlanError when an issue cannot be
 * mapped — unknown orphan blobs are never repaired.
 */
export async function scanRepairTargets(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  issueIds?: readonly string[]
): Promise<RepairScan> {
  const scannedAt = new Date().toISOString()
  const safeRepo = await resolveSafeRepo(cacheDir, kind, repoId)
  if (!safeRepo) throw new Error('Repository cache does not exist')
  const realRoot = dirname(safeRepo.repo)

  const state: RepairScanState = {
    issues: new Map(),
    linkRefs: new Map(),
    verifiedBlobs: new Set()
  }

  // Phase 1: verify blobs (bounded concurrency, partials never hashed).
  const blobs: Array<{ name: string; path: string; kind: 'sha256' | 'sha1' }> = []
  for (const blob of await inspectBlobFiles(safeRepo)) {
    if (blob.name.includes('.incomplete')) continue
    if (HEX64.test(blob.name)) blobs.push({ ...blob, kind: 'sha256' })
    else if (HEX40.test(blob.name)) blobs.push({ ...blob, kind: 'sha1' })
    else {
      state.issues.set(displayPathOf(realRoot, blob.path), {
        issue: 'invalid-blob-name',
        displayPath: displayPathOf(realRoot, blob.path),
        commit: null,
        repoPath: null,
        isLink: null,
        targetName: null,
        sizeBytes: 0,
        snapshotFilePath: null,
        snapshotDir: null
      })
    }
  }
  const results = await mapConcurrent(blobs, hashBlobEntry, HASH_CONCURRENCY)
  results.forEach((result, index) => {
    const blob = blobs[index]!
    if (result.ok) {
      state.verifiedBlobs.add(blob.name)
      return
    }
    state.issues.set(displayPathOf(realRoot, blob.path), {
      issue: 'hash-mismatch',
      displayPath: displayPathOf(realRoot, blob.path),
      commit: null,
      repoPath: null,
      isLink: null,
      targetName: blob.name,
      sizeBytes: result.size,
      snapshotFilePath: null,
      snapshotDir: null
    })
  })

  // Phase 2: verify snapshot entries.
  for (const snapshot of await inspectSnapshotDirectories(safeRepo)) {
    if (!COMMIT_HASH.test(snapshot.name)) continue
    await walkSnapshotForRepair(state, safeRepo, realRoot, snapshot, snapshot.path, '')
  }

  // Phase 3: select requested issues and map them onto one commit.
  const selected: DetectedIssue[] = []
  if (issueIds && issueIds.length > 0) {
    for (const issueId of issueIds) {
      const separator = issueId.indexOf(':')
      const code = separator > 0 ? issueId.slice(0, separator) : ''
      const path = separator > 0 ? issueId.slice(separator + 1) : ''
      const detected = state.issues.get(path)
      if (!detected || detected.issue !== code) {
        throw new PlanError(
          'unsupported-issue',
          `issue was not detected by the fresh scan: ${code}`
        )
      }
      selected.push(detected)
    }
  } else {
    selected.push(...state.issues.values())
  }

  const targets: StoredRepairTarget[] = []
  for (const detected of selected) {
    targets.push(mapDetectedIssue(detected, state, safeRepo))
  }
  if (targets.length === 0) {
    throw new PlanError('unsupported-issue', 'no repairable issues were selected')
  }
  const commits = new Set(targets.map((target) => target.commit))
  if (commits.size > 1) {
    throw new PlanError(
      'unsupported-issue',
      'requested issues span multiple commits; plan one commit at a time'
    )
  }
  return { scannedAt, resolvedCommit: targets[0]!.commit, targets }
}

function hashKindOf(hash: string): 'sha256' | 'sha1' {
  return HEX64.test(hash) ? 'sha256' : 'sha1'
}

function mapDetectedIssue(
  detected: DetectedIssue,
  state: RepairScanState,
  safeRepo: SafeRepo
): StoredRepairTarget {
  if (detected.issue === 'broken-snapshot-link') {
    const targetName = detected.targetName
    if (!targetName || !BLOB_HEX.test(targetName)) {
      throw new PlanError('unsupported-issue', 'broken link target is not a content-addressed blob')
    }
    return {
      issue: detected.issue,
      commit: detected.commit!,
      repoPath: detected.repoPath!,
      snapshotFilePath: detected.snapshotFilePath!,
      snapshotDir: detected.snapshotDir!,
      blobHash: targetName,
      expectedHash: targetName,
      hashKind: hashKindOf(targetName),
      isLink: true,
      estimatedBytes: detected.sizeBytes,
      displayPath: detected.displayPath
    }
  }
  if (detected.issue === 'hash-mismatch') {
    // Blob-path issue: the corrupt blob must be provably referenced by a
    // snapshot link, otherwise it is an unknown orphan we refuse to repair.
    const hash = basename(detected.displayPath)
    if (!BLOB_HEX.test(hash)) {
      throw new PlanError(
        'unsupported-issue',
        'hash mismatch is not mapped to a content-addressed blob'
      )
    }
    const refs = state.linkRefs.get(join(safeRepo.blobsDir, hash)) ?? []
    if (refs.length === 0) {
      throw new PlanError(
        'unsupported-issue',
        'refusing to repair an orphan blob with no snapshot reference'
      )
    }
    const ref = [...refs].sort(
      (a, b) => a.commit.localeCompare(b.commit) || a.repoPath.localeCompare(b.repoPath)
    )[0]!
    return {
      issue: detected.issue,
      commit: ref.commit,
      repoPath: ref.repoPath,
      snapshotFilePath: ref.snapshotFilePath,
      snapshotDir: dirname(ref.snapshotFilePath),
      blobHash: hash,
      expectedHash: hash,
      hashKind: hashKindOf(hash),
      isLink: true,
      estimatedBytes: detected.sizeBytes,
      displayPath: detected.displayPath
    }
  }
  if (detected.issue === 'unmatched-snapshot-copy') {
    return {
      issue: detected.issue,
      commit: detected.commit!,
      repoPath: detected.repoPath!,
      snapshotFilePath: detected.snapshotFilePath!,
      snapshotDir: detected.snapshotDir!,
      blobHash: null,
      expectedHash: null,
      hashKind: 'sha256',
      isLink: false,
      estimatedBytes: detected.sizeBytes,
      displayPath: detected.displayPath
    }
  }
  throw new PlanError(
    'unsupported-issue',
    `issue ${detected.issue} cannot be mapped to a repair at one commit`
  )
}

// ---------------------------------------------------------------------------
// Repair apply
// ---------------------------------------------------------------------------

export interface CacheRepairFetchMeta {
  /** Lowercased etag with W/ and quotes stripped (LFS sha256 or git blob sha1). */
  etag: string
  /** x-repo-commit header when the Hub attests one. */
  commit?: string
  size: number
}

export interface CacheRepairTransport {
  /**
   * Stream one resolve URL into `destination`. Auth is sent only to the Hub
   * host itself, never across redirects to CDNs.
   */
  fetchToFile(input: {
    url: string
    authToken?: string
    destination: string
    signal?: AbortSignal
  }): Promise<CacheRepairFetchMeta>
  close(): Promise<void>
}

/** Default transport: manual proxy via undici ProxyAgent, else global fetch. */
export function createDefaultRepairTransport(proxy: ProxySnapshot): CacheRepairTransport {
  const dispatcher = proxy.mode === 'manual' ? new ProxyAgent(proxy.url) : undefined
  const doFetch = (input: string, init?: RequestInit): Promise<Response> =>
    dispatcher
      ? (undiciFetch(input, { ...(init as object), dispatcher }) as unknown as Promise<Response>)
      : fetch(input, init)
  return {
    async fetchToFile({ url, authToken, destination, signal }) {
      const hubHost = new URL(url).host
      const headersFor = (target: string): Record<string, string> => {
        const headers: Record<string, string> = {
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'identity'
        }
        if (authToken && new URL(target).host === hubHost) {
          headers.Authorization = `Bearer ${authToken}`
        }
        return headers
      }
      const head = await doFetch(url, {
        method: 'HEAD',
        headers: headersFor(url),
        redirect: 'manual',
        signal
      })
      if (head.status >= 400) {
        throw new PlanError('network', `HEAD failed with status ${head.status}`)
      }
      const location = head.headers.get('location')
      const downloadUrl = location ? new URL(location, url).toString() : url
      const etag = normalizeEtag(
        head.headers.get('x-linked-etag') ?? head.headers.get('etag') ?? ''
      )
      const commit = head.headers.get('x-repo-commit') ?? undefined
      const res = await doFetch(downloadUrl, {
        headers: headersFor(downloadUrl),
        redirect: 'follow',
        signal
      })
      if (!res.ok || !res.body) {
        throw new PlanError('network', `download failed with status ${res.status}`)
      }
      await pipeline(
        Readable.fromWeb(res.body as NodeWebReadableStream),
        createWriteStream(destination)
      )
      const size = (await lstat(destination)).size
      return { etag, commit: commit ?? undefined, size }
    },
    async close() {
      await dispatcher?.close().catch(() => undefined)
    }
  }
}

function normalizeEtag(raw: string): string {
  return raw.replace(/^W\//, '').replace(/"/g, '').toLowerCase()
}

function assertHashName(raw: string, label: string): string {
  const normalized = normalizeEtag(raw)
  if (!BLOB_HEX.test(normalized)) {
    throw new PlanError('integrity', `${label} is not a valid content hash`)
  }
  return normalized
}

function resolveUrlFor(
  endpoint: string,
  kind: RepoKind,
  repoId: string,
  commit: string,
  repoPath: string
): string {
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/')
  return `${endpoint.replace(/\/+$/, '')}/${RESOLVE_PREFIX[kind]}${repoId}/resolve/${commit}/${encoded}`
}

/** Validate a repo-relative snapshot path before it is ever joined. */
function assertSafeRepoRelativePath(repoPath: string): void {
  const segments = repoPath.split('/')
  if (
    repoPath.startsWith('/') ||
    repoPath.includes('\\') ||
    repoPath.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new PlanError('plan-stale-filesystem', 'unsafe snapshot path in plan')
  }
}

/**
 * Fresh file-identity revalidation for one repair target, derived ONLY from
 * the freshly resolved safe repo (never from stored absolute paths). Used
 * once before the network fetch and again immediately before the replace.
 */
async function revalidateRepairTarget(
  safeRepo: SafeRepo,
  target: StoredRepairTarget,
  resolvedCommit: string
): Promise<void> {
  assertSafeRepoRelativePath(target.repoPath)
  const snapshotDir = join(safeRepo.snapshotsDir, resolvedCommit)
  const snapshotDirEntry = await lstatIfExists(snapshotDir)
  if (!snapshotDirEntry || snapshotDirEntry.isSymbolicLink() || !snapshotDirEntry.isDirectory()) {
    throw new PlanError('plan-stale-filesystem', 'snapshot directory is gone or unsafe')
  }
  assertDirectChild(safeRepo.snapshotsDir, await realpath(snapshotDir), 'snapshot directory')
  const snapshotFile = join(snapshotDir, ...target.repoPath.split('/'))
  const entry = await lstatIfExists(snapshotFile)
  if (!entry) {
    throw new PlanError('plan-stale-filesystem', 'snapshot entry is gone')
  }
  if (target.isLink) {
    if (!entry.isSymbolicLink()) {
      throw new PlanError('plan-stale-filesystem', 'snapshot entry is no longer a link')
    }
    const linkTarget = await readlink(snapshotFile)
    const resolved = resolve(dirname(snapshotFile), linkTarget)
    const expected = join(safeRepo.blobsDir, target.blobHash ?? '')
    if (resolved !== expected) {
      throw new PlanError('plan-stale-filesystem', 'snapshot link target changed since the plan')
    }
    return
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new PlanError('plan-stale-filesystem', 'snapshot copy is no longer a regular file')
  }
}

/**
 * Atomically replace one corrupt target with the verified temp file:
 * rename temp → blob (same volume, atomic), then refresh the snapshot entry
 * (relink or copy fallback, mirroring the download worker). The copy-layout
 * snapshot copy is overwritten with `copyFile` (which replaces the
 * destination) BEFORE the rename so a rename failure leaves the original
 * blob untouched; the original copy is never deleted ahead of its
 * replacement.
 */
async function replaceRepairTarget(
  safeRepo: SafeRepo,
  target: StoredRepairTarget,
  blobHash: string,
  tempPath: string
): Promise<void> {
  const blobPath = join(safeRepo.blobsDir, blobHash)
  // The blobs directory may be entirely absent (e.g. a repo whose only blob
  // went missing); create it — the parent is realpath-validated by
  // resolveSafeRepo.
  try {
    await mkdir(safeRepo.blobsDir, { recursive: true })
  } catch {
    throw new PlanError('plan-stale-filesystem', 'blobs directory is missing or unsafe')
  }
  const existing = await lstatIfExists(blobPath)
  if (existing) {
    assertRegularFile(existing, `blob ${blobHash}`)
    assertDirectChild(safeRepo.blobsDir, await realpath(blobPath), `blob ${blobHash}`)
  }
  if (!target.isLink) {
    await copyFile(tempPath, target.snapshotFilePath)
  }
  await rename(tempPath, blobPath)
  if (target.isLink) {
    await rm(target.snapshotFilePath, { force: true })
    try {
      await symlink(relative(dirname(target.snapshotFilePath), blobPath), target.snapshotFilePath)
    } catch {
      // Windows without the symlink privilege: fall back to a copy.
      await copyFile(blobPath, target.snapshotFilePath)
    }
  }
}

export interface ApplyRepairOptions {
  cacheDir: string
  kind: RepoKind
  repoId: string
  plan: Extract<CacheActionPlan, { action: 'repair' }>
  targets: readonly StoredRepairTarget[]
  authToken?: string
  transport: CacheRepairTransport
  protectedCommits: ReadonlySet<string>
  signal?: AbortSignal
}

/**
 * Apply a repair plan. Revalidates the protected set and every file identity
 * from a FRESH safe-repo resolution BEFORE any network or mutation, then per
 * entry: fetch to a registered temp file, verify the expected hash, re-check
 * the file identity, and atomically replace. Temp files are removed in
 * `finally` on every failure path; only a successful atomic replacement
 * clears the registry entry without deleting.
 */
export async function applyRepairPlan(
  input: ApplyRepairOptions,
  hooks: {
    planId: string
    registerTemp: (planId: string, path: string) => void
    releaseTemp: (planId: string, path: string, succeeded: boolean) => Promise<void>
  }
): Promise<{ bytes: number; changed: number }> {
  input.signal?.throwIfAborted()
  if (input.protectedCommits.has(input.plan.resolvedCommit)) {
    throw new PlanError(
      'plan-stale-protected',
      'the resolved commit is now used by an active download'
    )
  }
  const safeRepo = await resolveSafeRepo(input.cacheDir, input.kind, input.repoId)
  if (!safeRepo) {
    throw new PlanError('plan-stale-filesystem', 'repository cache does not exist')
  }

  // Fresh revalidation of every target before the first mutation.
  for (const target of input.targets) {
    if (target.commit !== input.plan.resolvedCommit) {
      throw new PlanError('plan-stale-filesystem', 'plan entry commit drifted from the plan')
    }
    await revalidateRepairTarget(safeRepo, target, input.plan.resolvedCommit)
  }

  const planDir = await ensureRepairPlanDir(input.cacheDir, input.plan.planId)
  let bytes = 0
  let changed = 0
  try {
    for (const target of input.targets) {
      input.signal?.throwIfAborted()
      const tempPath = join(planDir, `${randomUUID()}.tmp`)
      hooks.registerTemp(hooks.planId, tempPath)
      let replaced = false
      try {
        const url = resolveUrlFor(
          input.plan.endpoint,
          input.kind,
          input.repoId,
          input.plan.resolvedCommit,
          target.repoPath
        )
        // Any non-typed transport failure (DNS, refused, timeout, abort) is a
        // typed network failure with zero changes.
        const meta = await input.transport
          .fetchToFile({
            url,
            authToken: input.authToken,
            destination: tempPath,
            signal: input.signal
          })
          .catch((error: unknown) => {
            if (error instanceof PlanError) throw error
            throw new PlanError('network', 'network fetch failed')
          })
        // Identity check: the Hub must still attest a valid content hash, and
        // when the plan pinned one (link/broken-link entries) the exact same
        // hash — for unmatched copies the fresh etag pins the identity.
        const effective = assertHashName(meta.etag, 'hub etag')
        if (target.expectedHash && effective !== target.expectedHash) {
          throw new PlanError('integrity', 'hub content identity changed since the plan')
        }
        if (meta.commit && meta.commit.toLowerCase() !== input.plan.resolvedCommit) {
          throw new PlanError('integrity', 'hub resolved a different commit')
        }
        const digest =
          effective.length === 64
            ? await sha256OfFile(tempPath)
            : await gitBlobSha1OfFile(tempPath, (await lstat(tempPath)).size)
        if (digest !== effective) {
          throw new PlanError('integrity', 'downloaded content hash mismatch')
        }
        // Second fresh file-identity check immediately before the replace.
        await revalidateRepairTarget(safeRepo, target, input.plan.resolvedCommit)
        await replaceRepairTarget(safeRepo, target, effective, tempPath)
        replaced = true
        bytes += Number(
          (await lstatIfExists(join(safeRepo.blobsDir, effective)))?.size ?? meta.size
        )
        changed += 1
      } finally {
        await hooks.releaseTemp(hooks.planId, tempPath, replaced)
      }
    }
  } finally {
    // The plan directory itself is removed when empty (success) or best-effort
    // on failure; registered temps were already handled per entry.
    await rm(planDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return { bytes, changed }
}

/**
 * Ensure the main-owned staging directory `<cacheRoot>/.hubfetch-repair/<planId>/`
 * exists and is safe: the staging root must be a real directory directly
 * inside the real cache root, and the plan directory must be UUID-named.
 */
async function ensureRepairPlanDir(cacheDir: string, planId: string): Promise<string> {
  if (!isAbsolute(cacheDir))
    throw new PlanError('plan-stale-filesystem', 'cache directory must be absolute')
  if (!UUID_RE.test(planId)) throw new PlanError('plan-stale-filesystem', 'plan id is not a UUID')
  const rootEntry = await lstatIfExists(cacheDir)
  if (!rootEntry) throw new PlanError('plan-stale-filesystem', 'cache root does not exist')
  assertDirectory(rootEntry, 'cache root')
  const realRoot = await realpath(cacheDir)
  const staging = join(realRoot, REPAIR_STAGING_DIR)
  const stagingEntry = await lstatIfExists(staging)
  if (!stagingEntry) {
    await mkdir(staging)
  } else {
    assertDirectory(stagingEntry, 'repair staging')
  }
  const realStaging = await realpath(staging)
  if (relative(realRoot, realStaging) !== REPAIR_STAGING_DIR) {
    throw new PlanError('plan-stale-filesystem', 'repair staging resolves outside the cache root')
  }
  const planDir = join(realStaging, planId)
  const planDirEntry = await lstatIfExists(planDir)
  if (!planDirEntry) {
    await mkdir(planDir)
  } else {
    assertDirectory(planDirEntry, 'repair plan directory')
  }
  const realPlanDir = await realpath(planDir)
  if (relative(realStaging, realPlanDir) !== planId) {
    throw new PlanError('plan-stale-filesystem', 'repair plan directory resolves outside staging')
  }
  return realPlanDir
}

// ---------------------------------------------------------------------------
// Startup staging sweep
// ---------------------------------------------------------------------------

/**
 * No-follow enumeration of `<cacheRoot>/.hubfetch-repair` before any plan is
 * accepted: link/reparse entries and non-directory entries are rejected
 * (never traversed), and only UUID-named child directories older than 24
 * hours are removed. Active in-memory plan IDs are exempt.
 */
export async function cleanupRepairStaging(
  cacheDir: string,
  activePlanIds: ReadonlySet<string>
): Promise<void> {
  if (!isAbsolute(cacheDir)) throw new Error('Cache directory must be absolute')
  const rootEntry = await lstatIfExists(cacheDir)
  if (!rootEntry) return
  assertDirectory(rootEntry, 'cache root')
  const realRoot = await realpath(cacheDir)
  const staging = join(realRoot, REPAIR_STAGING_DIR)
  const stagingEntry = await lstatIfExists(staging)
  if (!stagingEntry) return
  assertDirectory(stagingEntry, 'repair staging')
  const realStaging = await realpath(staging)
  if (relative(realRoot, realStaging) !== REPAIR_STAGING_DIR) {
    throw new Error('Unsafe cache path: repair staging resolves outside the cache root')
  }
  for (const name of await readdir(realStaging)) {
    const child = join(realStaging, name)
    const entry = await lstatIfExists(child)
    if (!entry) continue
    if (entry.isSymbolicLink()) continue // reject: never traverse a link/reparse entry
    if (!entry.isDirectory()) continue // unexpected temp entry: never traverse
    if (!UUID_RE.test(name)) continue // only UUID-named plan directories
    if (activePlanIds.has(name)) continue // active plans are exempt
    if (Date.now() - Number(entry.mtimeMs) < REPAIR_STAGING_MAX_AGE_MS) continue
    // Deep-validate before the recursive removal so a planted junction cannot
    // redirect the sweep outside the staging root.
    await validateNoLinks(child, realStaging)
    await rm(child, { recursive: true, force: true })
  }
}
