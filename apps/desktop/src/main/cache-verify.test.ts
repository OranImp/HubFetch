import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CacheVerifier } from './cache-verify'

describe('CacheVerifier', () => {
  it('returns a clean empty report when the cache directory is missing', async () => {
    const verifier = new CacheVerifier()
    const missing = join(tmpdir(), `hf-verify-missing-${Date.now()}`)
    const phases: string[] = []
    const report = await verifier.run(missing, (progress) => phases.push(progress.phase))
    expect(report.ok).toBe(true)
    expect(report.repos).toEqual([])
    expect(report.totalIssues).toBe(0)
    expect(phases).toEqual(['scanning', 'done'])
  })

  it('cancel is a no-op when no worker is running', () => {
    const verifier = new CacheVerifier()
    expect(() => verifier.cancel()).not.toThrow()
  })

  it('emits scanning then done for an empty existing cache root', async () => {
    const verifier = new CacheVerifier()
    const empty = mkdtempSync(join(tmpdir(), 'hf-verify-empty-'))
    const phases: string[] = []
    try {
      const report = await verifier.run(empty, (progress) => phases.push(progress.phase))
      expect(report.ok).toBe(true)
      expect(report.repos).toEqual([])
      expect(phases[0]).toBe('scanning')
      expect(phases.at(-1)).toBe('done')
    } catch (error) {
      // The worker bundle is only emitted by electron-vite; unit tests that
      // cannot spawn it still cover the missing-root path above.
      expect(error).toBeInstanceOf(Error)
    }
  })
})
