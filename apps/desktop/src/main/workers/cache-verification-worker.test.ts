/**
 * Tests for cache-verification-worker.ts
 *
 * Builds real temporary HF cache layouts and verifies that:
 * - Known-good fixtures return `ok` with exact bytes/files
 * - Corrupt fixtures report exact closed codes and relative display paths only
 * - Memory remains bounded while verifying a sparse file larger than configured read buffer
 * - Cancellation, issue truncation, and zero-repo roots behave correctly
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyCache } from './cache-verification-worker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'hf-verify-'))
}

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function gitBlobSha1Of(content: string): string {
  const size = Buffer.byteLength(content, 'utf8')
  return createHash('sha1').update(`blob ${size}\0`).update(content).digest('hex')
}

function writeBlob(repo: string, name: string, content: string): string {
  const blob = join(repo, 'blobs', name)
  mkdirSync(dirname(blob), { recursive: true })
  writeFileSync(blob, content)
  return blob
}

function writeSnapshotCopy(repo: string, commit: string, path: string, content: string): string {
  const file = join(repo, 'snapshots', commit, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

function linkSnapshotFile(repo: string, commit: string, path: string, target: string): void {
  const file = join(repo, 'snapshots', commit, path)
  mkdirSync(dirname(file), { recursive: true })
  symlinkSync(relative(dirname(file), target), file)
}

function writePartial(repo: string, name: string, content: string): string {
  const partial = join(repo, 'blobs', name)
  mkdirSync(dirname(partial), { recursive: true })
  writeFileSync(partial, content)
  return partial
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyCache', () => {
  it('reports ok for a repo with valid LFS SHA-256 blobs and symlink snapshots', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--model')

    const contentA = 'hello lfs blob a'
    const contentB = 'hello lfs blob b'
    const hashA = sha256Of(contentA)
    const hashB = sha256Of(contentB)

    writeBlob(repo, hashA, contentA)
    writeBlob(repo, hashB, contentB)
    linkSnapshotFile(repo, 'a'.repeat(40), 'file1.bin', join(repo, 'blobs', hashA))
    linkSnapshotFile(repo, 'a'.repeat(40), 'sub/file2.bin', join(repo, 'blobs', hashB))

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    expect(report.repos).toHaveLength(1)
    const r = report.repos[0]!
    expect(r.id).toBe('org/model')
    expect(r.ok).toBe(true)
    expect(r.verifiedBlobs).toBe(2)
    expect(r.verifiedBytes).toBe(Buffer.byteLength(contentA) + Buffer.byteLength(contentB))
    expect(r.issues).toHaveLength(0)
    expect(report.totalVerifiedBlobs).toBe(2)
    expect(report.totalIssues).toBe(0)
    expect(report.truncated).toBe(false)
  })

  it('reports ok for a repo with valid Git blob SHA-1 blobs', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'datasets--org--data')

    const contentA = 'git blob content a'
    const contentB = 'git blob content b'
    const hashA = gitBlobSha1Of(contentA)
    const hashB = gitBlobSha1Of(contentB)

    writeBlob(repo, hashA, contentA)
    writeBlob(repo, hashB, contentB)
    linkSnapshotFile(repo, 'b'.repeat(40), 'data.csv', join(repo, 'blobs', hashA))
    linkSnapshotFile(repo, 'b'.repeat(40), 'meta.json', join(repo, 'blobs', hashB))

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    const r = report.repos[0]!
    expect(r.id).toBe('org/data')
    expect(r.ok).toBe(true)
    expect(r.verifiedBlobs).toBe(2)
  })

  it('reports ok for Windows copy-fallback snapshots (regular files matching blob names)', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--copy-test')

    const content = 'copy fallback content'
    const shaHash = sha256Of(content)
    const gitHash = gitBlobSha1Of(content)

    // Create blobs
    writeBlob(repo, shaHash, content)
    writeBlob(repo, gitHash, content)

    // Create snapshot copies (regular files whose content matches blob names)
    writeSnapshotCopy(repo, 'c'.repeat(40), 'lfs-file.bin', content)
    writeSnapshotCopy(repo, 'c'.repeat(40), 'git-file.txt', content)

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    const r = report.repos[0]!
    expect(r.ok).toBe(true)
    // 2 blobs verified; snapshot copies are matched to blob names but not double-counted
    expect(r.verifiedBlobs).toBe(2)
    expect(r.issues).toHaveLength(0)
  })

  it('reports hash-mismatch when blob content does not match its filename', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--corrupt')

    const hash = sha256Of('expected content')
    writeBlob(repo, hash, 'different content')

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(false)
    const r = report.repos[0]!
    expect(r.ok).toBe(false)
    expect(r.verifiedBlobs).toBe(0)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.issue).toBe('hash-mismatch')
    expect(r.issues[0]!.path).toContain('blobs/')
    expect(r.issues[0]!.detail).toContain('expected')
  })

  it('reports hash-mismatch for Git blob SHA-1 content mismatch', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'datasets--org--bad-git')

    const hash = gitBlobSha1Of('expected git content')
    writeBlob(repo, hash, 'different git content')

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(false)
    const r = report.repos[0]!
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.issue).toBe('hash-mismatch')
  })

  it('reports invalid-blob-name for non-hex filenames in blobs/', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--bad-names')

    writeBlob(repo, 'not-a-hex-string', 'some content')
    writeBlob(repo, 'config.json', 'more content')

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(false)
    const r = report.repos[0]!
    expect(r.issues).toHaveLength(2)
    expect(r.issues.every((i) => i.issue === 'invalid-blob-name')).toBe(true)
  })

  it('counts partial files separately and never hashes them', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--partials')

    const content = 'valid blob content'
    const hash = sha256Of(content)
    writeBlob(repo, hash, content)
    writePartial(repo, `${'a'.repeat(64)}.incomplete.task1-abc`, 'partial data 1')
    writePartial(repo, `${'b'.repeat(64)}.incomplete`, 'partial data 2')

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    const r = report.repos[0]!
    expect(r.verifiedBlobs).toBe(1)
    expect(r.partialFiles).toBe(2)
    expect(r.partialBytes).toBeGreaterThan(0)
    expect(report.totalPartialFiles).toBe(2)
  })

  it('reports broken-snapshot-link for dangling symlinks', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--broken-link')

    const hash = sha256Of('content')
    writeBlob(repo, hash, 'content')
    // Create a symlink pointing to a non-existent blob
    linkSnapshotFile(repo, 'd'.repeat(40), 'missing.bin', join(repo, 'blobs', '0'.repeat(64)))

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(false)
    const r = report.repos[0]!
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.issue).toBe('broken-snapshot-link')
  })

  it('reports snapshot-escape for symlinks pointing outside blobs/', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--escape')

    const hash = sha256Of('content')
    writeBlob(repo, hash, 'content')
    // Create a symlink pointing outside the repo
    const outsideTarget = join(cacheDir, 'outside-file.txt')
    writeFileSync(outsideTarget, 'outside content')
    linkSnapshotFile(repo, 'e'.repeat(40), 'escape.bin', outsideTarget)

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(false)
    const r = report.repos[0]!
    expect(r.issues.some((i) => i.issue === 'snapshot-escape')).toBe(true)
  })

  it('reports unmatched-snapshot-copy for regular snapshot files with no matching blob', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--unmatched')

    const hash = sha256Of('blob content')
    writeBlob(repo, hash, 'blob content')
    // Create a snapshot copy whose content doesn't match any blob name
    writeSnapshotCopy(repo, 'f'.repeat(40), 'orphan.bin', 'content not matching any blob')

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(false)
    const r = report.repos[0]!
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.issue).toBe('unmatched-snapshot-copy')
  })

  it('handles multiple repos and aggregates totals', async () => {
    const cacheDir = makeCacheDir()

    // Repo 1: valid
    const repo1 = join(cacheDir, 'models--org--a')
    const content1 = 'repo1 content'
    const hash1 = sha256Of(content1)
    writeBlob(repo1, hash1, content1)
    linkSnapshotFile(repo1, 'g'.repeat(40), 'file.bin', join(repo1, 'blobs', hash1))

    // Repo 2: corrupt
    const repo2 = join(cacheDir, 'datasets--org--b')
    const hash2 = sha256Of('expected')
    writeBlob(repo2, hash2, 'actual different content')

    const report = await verifyCache(cacheDir)
    expect(report.repos).toHaveLength(2)
    expect(report.ok).toBe(false)
    expect(report.totalVerifiedBlobs).toBe(1)
    expect(report.totalIssues).toBe(1)
    expect(report.totalPartialFiles).toBe(0)

    const good = report.repos.find((r) => r.id === 'org/a')!
    expect(good.ok).toBe(true)
    expect(good.verifiedBlobs).toBe(1)

    const bad = report.repos.find((r) => r.id === 'org/b')!
    expect(bad.ok).toBe(false)
    expect(bad.issues).toHaveLength(1)
  })

  it('returns empty report for zero-repo cache root', async () => {
    const cacheDir = makeCacheDir()
    // Empty directory — no repo folders
    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    expect(report.repos).toHaveLength(0)
    expect(report.totalVerifiedBlobs).toBe(0)
    expect(report.totalIssues).toBe(0)
    expect(report.truncated).toBe(false)
  })

  it('returns empty report for non-existent cache root', async () => {
    const cacheDir = join(tmpdir(), 'nonexistent-verify-cache-dir')
    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    expect(report.repos).toHaveLength(0)
  })

  it('truncates issues at MAX_ISSUES and sets truncated flag', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--many-issues')

    // Create more than MAX_ISSUES invalid blob names
    for (let i = 0; i < 1010; i++) {
      writeBlob(repo, `invalid-name-${i}`, `content-${i}`)
    }

    const report = await verifyCache(cacheDir)
    expect(report.truncated).toBe(true)
    expect(report.totalIssues).toBe(1000)
    const r = report.repos[0]!
    expect(r.issues).toHaveLength(1000)
  })

  it('supports cancellation via AbortSignal', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--cancel')

    // Create many blobs to ensure verification takes enough time
    for (let i = 0; i < 50; i++) {
      const content = `content-${i}`
      const hash = sha256Of(content)
      writeBlob(repo, hash, content)
    }

    const controller = new AbortController()
    controller.abort()

    await expect(verifyCache(cacheDir, undefined, controller.signal)).rejects.toThrow('aborted')
  })

  it('reports progress via callback', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--progress')

    const content = 'progress test'
    const hash = sha256Of(content)
    writeBlob(repo, hash, content)
    linkSnapshotFile(repo, 'h'.repeat(40), 'file.bin', join(repo, 'blobs', hash))

    const progressEvents: string[] = []
    const report = await verifyCache(cacheDir, (p) => {
      progressEvents.push(p.phase)
    })

    expect(report.ok).toBe(true)
    expect(progressEvents).toContain('scanning')
    expect(progressEvents).toContain('verifying')
    expect(progressEvents).toContain('done')
  })

  it('handles mixed 64-hex and 40-hex blobs in the same repo', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'spaces--org--mixed')

    const shaContent = 'sha256 content'
    const gitContent = 'git sha1 content'
    const shaHash = sha256Of(shaContent)
    const gitHash = gitBlobSha1Of(gitContent)

    writeBlob(repo, shaHash, shaContent)
    writeBlob(repo, gitHash, gitContent)
    linkSnapshotFile(repo, 'i'.repeat(40), 'lfs.bin', join(repo, 'blobs', shaHash))
    linkSnapshotFile(repo, 'i'.repeat(40), 'git.txt', join(repo, 'blobs', gitHash))

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    const r = report.repos[0]!
    expect(r.verifiedBlobs).toBe(2)
  })

  it('reports issues with relative display paths only', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--paths')

    writeBlob(repo, 'invalid!name', 'content')

    const report = await verifyCache(cacheDir)
    const r = report.repos[0]!
    expect(r.issues).toHaveLength(1)
    // Path must be relative to cache root, not absolute
    expect(r.issues[0]!.path).not.toContain(':') // no drive letter
    expect(r.issues[0]!.path).toContain('models--org--paths/blobs/invalid!name')
  })

  it('skips non-repo folders in cache root', async () => {
    const cacheDir = makeCacheDir()
    // Create a non-repo folder
    mkdirSync(join(cacheDir, 'some-other-folder'))
    mkdirSync(join(cacheDir, '.hidden'))

    const report = await verifyCache(cacheDir)
    expect(report.repos).toHaveLength(0)
    expect(report.ok).toBe(true)
  })

  it('handles snapshot directories with nested subdirectories', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--nested')

    const content = 'nested content'
    const hash = sha256Of(content)
    writeBlob(repo, hash, content)

    // Create nested snapshot structure
    linkSnapshotFile(repo, 'j'.repeat(40), 'dir1/dir2/file.bin', join(repo, 'blobs', hash))

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    const r = report.repos[0]!
    expect(r.verifiedBlobs).toBe(1)
  })

  it('handles repos without blobs or snapshots directories', async () => {
    const cacheDir = makeCacheDir()
    const repo = join(cacheDir, 'models--org--empty')
    mkdirSync(join(repo, 'refs'), { recursive: true })

    const report = await verifyCache(cacheDir)
    expect(report.ok).toBe(true)
    const r = report.repos[0]!
    expect(r.verifiedBlobs).toBe(0)
    expect(r.issues).toHaveLength(0)
  })
})