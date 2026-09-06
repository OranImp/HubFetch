import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { CacheVerificationProgress, CacheVerificationReport } from '@hubfetch/shared'

const MAIN_DIR = dirname(fileURLToPath(import.meta.url))

export class CacheVerifyAbortedError extends Error {
  override readonly name = 'CacheVerifyAbortedError'
  constructor() {
    super('aborted')
  }
}

function emptyReport(root: string): CacheVerificationReport {
  return {
    root,
    ok: true,
    repos: [],
    totalVerifiedBlobs: 0,
    totalVerifiedBytes: 0,
    totalIssues: 0,
    totalPartialFiles: 0,
    totalPartialBytes: 0,
    truncated: false,
    scannedAt: new Date().toISOString()
  }
}

function idleProgress(
  phase: CacheVerificationProgress['phase']
): CacheVerificationProgress {
  return { phase, completedRepos: 0, totalRepos: 0, verifiedBlobs: 0, issuesFound: 0 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isReport(value: unknown): value is CacheVerificationReport {
  if (!isRecord(value)) return false
  return (
    typeof value.root === 'string' &&
    typeof value.ok === 'boolean' &&
    Array.isArray(value.repos) &&
    typeof value.totalVerifiedBlobs === 'number' &&
    typeof value.totalVerifiedBytes === 'number' &&
    typeof value.totalIssues === 'number' &&
    typeof value.totalPartialFiles === 'number' &&
    typeof value.totalPartialBytes === 'number' &&
    typeof value.truncated === 'boolean' &&
    typeof value.scannedAt === 'string'
  )
}

function parseProgress(value: Record<string, unknown>): CacheVerificationProgress | null {
  if (value.phase !== 'scanning' && value.phase !== 'verifying' && value.phase !== 'done') {
    return null
  }
  if (typeof value.completedRepos !== 'number' || typeof value.totalRepos !== 'number') return null
  if (typeof value.verifiedBlobs !== 'number' || typeof value.issuesFound !== 'number') return null
  return {
    phase: value.phase,
    completedRepos: value.completedRepos,
    totalRepos: value.totalRepos,
    verifiedBlobs: value.verifiedBlobs,
    issuesFound: value.issuesFound,
    ...(typeof value.currentRepo === 'string' ? { currentRepo: value.currentRepo } : {})
  }
}

/**
 * Spawns the offline verification worker and forwards cooperative abort.
 * Progress callbacks receive relative repo ids only — never absolute paths.
 */
export class CacheVerifier {
  private worker: Worker | null = null

  cancel(): void {
    this.worker?.postMessage({ type: 'abort' })
  }

  run(
    cacheDir: string,
    onProgress: (progress: CacheVerificationProgress) => void
  ): Promise<CacheVerificationReport> {
    this.cancel()
    if (!existsSync(cacheDir)) {
      onProgress(idleProgress('scanning'))
      onProgress(idleProgress('done'))
      return Promise.resolve(emptyReport(cacheDir))
    }

    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(join(MAIN_DIR, 'cache-verification-worker.mjs'), {
        workerData: { cacheDir }
      })
      this.worker = worker

      const settle = (next: () => void): void => {
        if (this.worker === worker) this.worker = null
        void worker.terminate()
        next()
      }

      worker.on('message', (raw: unknown) => {
        if (!isRecord(raw) || typeof raw.type !== 'string') return
        switch (raw.type) {
          case 'progress': {
            const progress = parseProgress(raw)
            if (progress) onProgress(progress)
            return
          }
          case 'done': {
            const report = raw.report
            if (!isReport(report)) {
              settle(() => reject(new Error('cache verification returned no report')))
              return
            }
            settle(() => resolvePromise(report))
            return
          }
          case 'error': {
            const message = typeof raw.message === 'string' ? raw.message : 'verification failed'
            settle(() =>
              reject(message === 'aborted' ? new CacheVerifyAbortedError() : new Error(message))
            )
            return
          }
          default:
            return
        }
      })
      worker.once('error', (error) => settle(() => reject(error)))
      worker.once('exit', (code) => {
        if (this.worker !== worker) return
        this.worker = null
        if (code !== 0) reject(new Error(`cache verification exited with code ${code}`))
      })
    })
  }
}
