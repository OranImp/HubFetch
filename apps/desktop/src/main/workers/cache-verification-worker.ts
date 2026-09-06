/**
 * Offline HF cache integrity verification worker.
 *
 * Traverses the standard HF cache layout (`<cache>/{models,datasets,spaces}--*`)
 * and verifies every blob and snapshot entry without fetching, deleting, chmod'ing,
 * following an unvalidated link/reparse point, or repairing anything.
 *
 * Protocol (parentPort messages):
 *   in : { type: 'abort' }
 *   out: { type: 'progress', ...CacheVerificationProgress }
 *        { type: 'done', report: CacheVerificationReport }
 *        { type: 'error', message: string }
 *
 * workerData: { cacheDir: string }
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readlinkSync, createReadStream, type Stats } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type {
  CacheVerificationEntry,
  CacheVerificationProgress,
  CacheVerificationReport,
  CacheVerificationRepo,
  RepoKind
} from '@hubfetch/shared'
import { parseRepoFolderName } from '@hubfetch/hub-api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOB_64HEX = /^[0-9a-f]{64}$/
const BLOB_40HEX = /^[0-9a-f]{40}$/
const REPO_FOLDER = /^(models|datasets|spaces)--/
const MAX_ISSUES = 1000
const MAX_PATH_LENGTH = 4096
const HASH_CONCURRENCY = 4

type BlobKind = 'sha256' | 'sha1'

interface BlobInfo {
  name: string
  path: string
  kind: BlobKind
}

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let aborted = false

parentPort?.on('message', (msg: { type?: string }) => {
  if (msg?.type === 'abort') {
    aborted = true
  }
})

function checkAborted(signal?: AbortSignal): void {
  if (aborted) throw new Error('aborted')
  signal?.throwIfAborted()
}

function post(msg: unknown): void {
  parentPort?.postMessage(msg)
}

// ---------------------------------------------------------------------------
// Hashing helpers
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

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Relative path with forward slashes for display. */
function relPath(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, '/')
}

function isSingleSegment(p: string): boolean {
  return p !== '' && p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p) && !p.includes(sep)
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)
}

// ---------------------------------------------------------------------------
// Concurrency-limited map
// ---------------------------------------------------------------------------

async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = []
  const running: Promise<void>[] = []
  let i = 0

  function next(): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      if (i >= items.length) {
        resolvePromise()
        return
      }
      const idx = i++
      const item = items[idx]!
      const promise = fn(item).then((r) => {
        results[idx] = r
      })
      promise.finally(() => resolvePromise())
      running.push(promise)
    })
  }

  const workers: Promise<void>[] = []
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (i < items.length) {
          await next()
        }
      })()
    )
  }
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Blob verification
// ---------------------------------------------------------------------------

interface VerifiedBlob {
  name: string
  bytes: number
  ok: boolean
  issue?: CacheVerificationEntry
}

async function verifyBlob(
  root: string,
  blob: BlobInfo,
  issues: CacheVerificationEntry[],
  signal?: AbortSignal
): Promise<VerifiedBlob> {
  checkAborted(signal)

  if (issues.length >= MAX_ISSUES) {
    return { name: blob.name, bytes: 0, ok: false }
  }

  let st
  try {
    st = lstatSync(blob.path)
  } catch {
    issues.push({
      issue: 'unreadable',
      path: relPath(root, blob.path),
      detail: 'cannot lstat blob file'
    })
    return { name: blob.name, bytes: 0, ok: false }
  }

  if (!st.isFile()) {
    issues.push({
      issue: 'invalid-blob-name',
      path: relPath(root, blob.path),
      detail: 'not a regular file'
    })
    return { name: blob.name, bytes: 0, ok: false }
  }

  const size = st.size
  let digest: string
  try {
    if (blob.kind === 'sha256') {
      digest = await sha256OfFile(blob.path)
    } else {
      digest = await gitBlobSha1OfFile(blob.path, size)
    }
  } catch {
    issues.push({
      issue: 'unreadable',
      path: relPath(root, blob.path),
      detail: 'cannot read blob content'
    })
    return { name: blob.name, bytes: 0, ok: false }
  }

  if (digest !== blob.name) {
    issues.push({
      issue: 'hash-mismatch',
      path: relPath(root, blob.path),
      detail: `expected ${blob.name}, got ${digest}`
    })
    return { name: blob.name, bytes: 0, ok: false }
  }

  return { name: blob.name, bytes: size, ok: true }
}

// ---------------------------------------------------------------------------
// Snapshot verification
// ---------------------------------------------------------------------------

async function verifySnapshotEntry(
  root: string,
  repoBlobsDir: string,
  entryPath: string,
  verifiedBlobNames: ReadonlySet<string>,
  issues: CacheVerificationEntry[],
  signal?: AbortSignal
): Promise<void> {
  checkAborted(signal)

  if (issues.length >= MAX_ISSUES) {
    return
  }

  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(entryPath)
  } catch {
    issues.push({
      issue: 'unreadable',
      path: relPath(root, entryPath),
      detail: 'cannot lstat snapshot entry'
    })
    return
  }

  // Directory — recurse
  if (st.isDirectory()) {
    for (const name of readdirSync(entryPath)) {
      const child = join(entryPath, name)
      await verifySnapshotEntry(root, repoBlobsDir, child, verifiedBlobNames, issues, signal)
    }
    return
  }

  // Symbolic link — validate and hash the resolved target
  if (st.isSymbolicLink()) {
    let linkTarget: string
    try {
      linkTarget = readlinkSync(entryPath)
    } catch {
      issues.push({
        issue: 'unreadable',
        path: relPath(root, entryPath),
        detail: 'cannot read snapshot link'
      })
      return
    }

    // Resolve the textual target against the link's parent directory
    const resolved = resolve(dirname(entryPath), linkTarget)
    const resolvedRel = relative(repoBlobsDir, resolved)

    // Check that the resolved target is inside this repo's blobs directory
    if (
      resolvedRel === '' ||
      resolvedRel === '..' ||
      resolvedRel.startsWith(`..${sep}`) ||
      isAbsolute(resolvedRel) ||
      !isSingleSegment(resolvedRel)
    ) {
      issues.push({
        issue: 'snapshot-escape',
        path: relPath(root, entryPath),
        detail: `link target ${linkTarget} resolves outside blobs/`
      })
      return
    }

    // Re-lstat the resolved target — must be a regular non-reparse file
    let targetSt
    try {
      targetSt = lstatSync(resolved)
    } catch {
      issues.push({
        issue: 'broken-snapshot-link',
        path: relPath(root, entryPath),
        detail: `link target ${linkTarget} does not exist`
      })
      return
    }

    if (targetSt.isSymbolicLink() || !targetSt.isFile()) {
      issues.push({
        issue: 'snapshot-escape',
        path: relPath(root, entryPath),
        detail: `link target ${linkTarget} is not a regular file`
      })
      return
    }

    // Hash the resolved blob path directly
    const blobName = resolvedRel
    const size = targetSt.size
    let digest: string
    try {
      if (BLOB_64HEX.test(blobName)) {
        digest = await sha256OfFile(resolved)
      } else if (BLOB_40HEX.test(blobName)) {
        digest = await gitBlobSha1OfFile(resolved, size)
      } else {
        issues.push({
          issue: 'invalid-blob-name',
          path: relPath(root, resolved),
          detail: `blob name ${blobName} is not valid 64-hex or 40-hex`
        })
        return
      }
    } catch {
      issues.push({
        issue: 'unreadable',
        path: relPath(root, resolved),
        detail: 'cannot read blob target content'
      })
      return
    }

    if (digest !== blobName) {
      issues.push({
        issue: 'hash-mismatch',
        path: relPath(root, resolved),
        detail: `expected ${blobName}, got ${digest}`
      })
      return
    }

    return
  }

  // Regular file — Windows copy fallback
  if (st.isFile()) {
    const size = st.size
    const displayPath = relPath(root, entryPath)

    // Try SHA-256 first, then Git blob SHA-1
    let digest: string
    try {
      digest = await sha256OfFile(entryPath)
    } catch {
      issues.push({
        issue: 'unreadable',
        path: displayPath,
        detail: 'cannot read snapshot copy content'
      })
      return
    }

    if (verifiedBlobNames.has(digest)) {
      return
    }

    // Try Git blob SHA-1
    try {
      digest = await gitBlobSha1OfFile(entryPath, size)
    } catch {
      issues.push({
        issue: 'unreadable',
        path: displayPath,
        detail: 'cannot read snapshot copy content for sha1'
      })
      return
    }

    if (verifiedBlobNames.has(digest)) {
      return
    }

    issues.push({
      issue: 'unmatched-snapshot-copy',
      path: displayPath,
      detail: 'content hash does not match any verified blob in this repo'
    })
    return
  }

  // Any other entry type (reparse point, etc.) — report as snapshot-escape
  issues.push({
    issue: 'snapshot-escape',
    path: relPath(root, entryPath),
    detail: `unexpected file type: ${fileTypeLabel(st!)}`
  })
}

function fileTypeLabel(st: Stats): string {
  if (st.isBlockDevice()) return 'block-device'
  if (st.isCharacterDevice()) return 'character-device'
  if (st.isFIFO()) return 'fifo'
  if (st.isSocket()) return 'socket'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Repo verification
// ---------------------------------------------------------------------------

async function verifyRepo(
  root: string,
  repoFolder: string,
  issues: CacheVerificationEntry[],
  signal?: AbortSignal
): Promise<CacheVerificationRepo> {
  const parsed = parseRepoFolderName(repoFolder)
  if (!parsed) {
    return {
      id: repoFolder,
      kind: 'model' as RepoKind,
      ok: false,
      verifiedBlobs: 0,
      verifiedBytes: 0,
      issues: [],
      partialFiles: 0,
      partialBytes: 0
    }
  }

  const repoPath = join(root, repoFolder)
  const blobsDir = join(repoPath, 'blobs')
  const snapshotsDir = join(repoPath, 'snapshots')

  // Track the starting issue count so we can extract this repo's issues later
  const startIssueCount = issues.length

  // -----------------------------------------------------------------------
  // Phase 1: Verify blobs directory
  // -----------------------------------------------------------------------
  const verifiedBlobNames = new Set<string>()
  let verifiedBlobs = 0
  let verifiedBytes = 0
  let partialFiles = 0
  let partialBytes = 0

  let blobEntries: string[] = []
  try {
    blobEntries = readdirSync(blobsDir)
  } catch {
    // blobs/ may not exist — that's fine
  }

  const blobsToVerify: BlobInfo[] = []

  for (const name of blobEntries) {
    checkAborted(signal)

    if (issues.length >= MAX_ISSUES) break

    if (name.length > MAX_PATH_LENGTH) {
      issues.push({
        issue: 'invalid-blob-name',
        path: relPath(root, join(blobsDir, name)),
        detail: 'blob name exceeds maximum path length'
      })
      continue
    }

    // Partial files — count but never hash
    if (name.includes('.incomplete')) {
      let st
      try {
        st = lstatSync(join(blobsDir, name))
      } catch {
        issues.push({
          issue: 'unreadable',
          path: relPath(root, join(blobsDir, name)),
          detail: 'cannot stat partial file'
        })
        continue
      }
      if (st.isFile()) {
        partialFiles++
        partialBytes += st.size
      }
      continue
    }

    if (BLOB_64HEX.test(name)) {
      blobsToVerify.push({ name, path: join(blobsDir, name), kind: 'sha256' })
    } else if (BLOB_40HEX.test(name)) {
      blobsToVerify.push({ name, path: join(blobsDir, name), kind: 'sha1' })
    } else {
      issues.push({
        issue: 'invalid-blob-name',
        path: relPath(root, join(blobsDir, name)),
        detail: `unexpected blob name pattern: ${name.slice(0, 20)}...`
      })
    }
  }

  // Verify blobs concurrently with bounded concurrency
  const blobResults = await mapConcurrent(
    blobsToVerify,
    (blob) => verifyBlob(root, blob, issues, signal),
    HASH_CONCURRENCY
  )

  for (const result of blobResults) {
    if (result.ok) {
      verifiedBlobNames.add(result.name)
      verifiedBlobs++
      verifiedBytes += result.bytes
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: Verify snapshots directory
  // -----------------------------------------------------------------------
  if (issues.length < MAX_ISSUES) {
    let snapshotEntries: string[] = []
    try {
      snapshotEntries = readdirSync(snapshotsDir)
    } catch {
      // snapshots/ may not exist
    }

    for (const commitHash of snapshotEntries) {
      checkAborted(signal)
      if (issues.length >= MAX_ISSUES) break

      const snapshotPath = join(snapshotsDir, commitHash)
      let st
      try {
        st = lstatSync(snapshotPath)
      } catch {
        issues.push({
          issue: 'unreadable',
          path: relPath(root, snapshotPath),
          detail: 'cannot stat snapshot directory'
        })
        continue
      }

      if (!st.isDirectory()) continue

      await verifySnapshotEntry(root, blobsDir, snapshotPath, verifiedBlobNames, issues, signal)
    }
  }

  // Extract this repo's issues from the global array
  const repoIssues = issues.slice(startIssueCount)

  return {
    id: parsed.repoId,
    kind: parsed.kind,
    ok: repoIssues.length === 0,
    verifiedBlobs,
    verifiedBytes,
    issues: repoIssues,
    partialFiles,
    partialBytes
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function verifyCache(
  cacheDir: string,
  onProgress?: (progress: CacheVerificationProgress) => void,
  signal?: AbortSignal
): Promise<CacheVerificationReport> {
  const allIssues: CacheVerificationEntry[] = []
  const repos: CacheVerificationRepo[] = []
  let totalVerifiedBlobs = 0
  let totalVerifiedBytes = 0
  let totalPartialFiles = 0
  let totalPartialBytes = 0

  const root = resolve(cacheDir)

  // Discover repo folders
  let folders: string[] = []
  try {
    folders = readdirSync(root)
  } catch {
    // Cache root doesn't exist or is unreadable
  }

  const repoFolders = folders.filter((f) => REPO_FOLDER.test(f))
  const totalRepos = repoFolders.length

  onProgress?.({
    phase: 'scanning',
    completedRepos: 0,
    totalRepos,
    verifiedBlobs: 0,
    issuesFound: 0
  })

  for (let i = 0; i < repoFolders.length; i++) {
    checkAborted(signal)

    const repo = await verifyRepo(root, repoFolders[i]!, allIssues, signal)
    repos.push(repo)
    totalVerifiedBlobs += repo.verifiedBlobs
    totalVerifiedBytes += repo.verifiedBytes
    totalPartialFiles += repo.partialFiles
    totalPartialBytes += repo.partialBytes

    onProgress?.({
      phase: 'verifying',
      currentRepo: repo.id,
      completedRepos: i + 1,
      totalRepos,
      verifiedBlobs: totalVerifiedBlobs,
      issuesFound: allIssues.length
    })
  }

  const truncated = allIssues.length >= MAX_ISSUES

  onProgress?.({
    phase: 'done',
    completedRepos: totalRepos,
    totalRepos,
    verifiedBlobs: totalVerifiedBlobs,
    issuesFound: allIssues.length
  })

  return {
    root,
    ok: allIssues.length === 0,
    repos,
    totalVerifiedBlobs,
    totalVerifiedBytes,
    totalIssues: allIssues.length,
    totalPartialFiles,
    totalPartialBytes,
    truncated,
    scannedAt: new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

if (parentPort) {
  const { cacheDir } = workerData as { cacheDir: string }

  verifyCache(cacheDir, (progress) => {
    post({ type: 'progress', ...progress })
  })
    .then((report) => {
      post({ type: 'done', report })
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      post({ type: 'error', message: aborted ? 'aborted' : message })
    })
}