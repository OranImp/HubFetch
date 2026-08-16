/**
 * QA failure paths (plan Todo 24): four separate fail-closed scenarios — a
 * sentinel injected after redaction, a disk-write failure, a deletion failure,
 * and a final-rename failure. In every case the exporter rejects with a typed
 * error and leaves NO `.zip`/temp path behind. Prints `[qa-failure]` evidence.
 */
import { readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@hubfetch/shared'
import type { BundleSources, SupportBundleIo } from './support-bundle'
import { SupportBundleBuilder, SupportBundleError } from './support-bundle'
import { Redactor } from './security/redaction'

export const QA_LEAK_SENTINEL = 'qa_leaked_sentinel_after_redaction_2026'

function sourcesFixture(): BundleSources {
  return {
    app: { app: 'HubFetch', version: '0.2.0', buildKind: 'packaged', electron: '43.1.0' },
    system: {
      os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
      cpu: { model: 'Intel(R) Core(TM) i7-14700', count: 20 },
      memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 },
      disk: { freeBytes: 250 * 1024 ** 3 }
    },
    diagnostics: {
      checks: [],
      completedAt: '2026-08-15T12:00:00.000Z'
    },
    settings: { ...DEFAULT_SETTINGS },
    tasks: [],
    mainLog: '[main] app ready\n',
    rendererLog: '[renderer] boot\n'
  }
}

const QA_ROOT = join(process.cwd(), '.omo', 'scratch', 'qa-failure-bundles')
const SCENARIOS = ['leak', 'write', 'delete', 'rename'] as const

beforeAll(async () => {
  await rm(QA_ROOT, { recursive: true, force: true })
  for (const name of SCENARIOS) {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(QA_ROOT, name), { recursive: true })
  }
})

async function listing(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

describe('QA failure — exporter fails closed in all four scenarios', () => {
  it('scenario 1: sentinel injected after redaction -> leak error, no archive', async () => {
    const dir = join(QA_ROOT, 'leak')
    const target = join(dir, 'bundle.zip')
    // Redactor has no registry (value not replaced); the leak guard claims the
    // sentinel is live -> the post-redaction scan must reject it.
    const builder = new SupportBundleBuilder({
      clock: () => new Date('2026-08-15T12:00:00.000Z'),
      redactor: new Redactor(null),
      leakGuard: () => [QA_LEAK_SENTINEL]
    })
    const sources = sourcesFixture()
    sources.mainLog = `raw ${QA_LEAK_SENTINEL} survived redaction\n`
    let caught: SupportBundleError | null = null
    try {
      await builder.build(target, sources)
    } catch (err) {
      caught = err instanceof SupportBundleError ? err : null
    }
    console.log('[qa-failure] leak scenario caught:', caught?.code)
    expect(caught?.code).toBe('leak')
    expect(await listing(dir)).toEqual([])
  })

  it('scenario 2: disk-write failure -> write error, no archive', async () => {
    const dir = join(QA_ROOT, 'write')
    const target = join(dir, 'bundle.zip')
    const io: SupportBundleIo = {
      writeFile: async () => {
        throw new Error('EACCES: simulated disk write failure')
      },
      rename: (from, to) => rename(from, to),
      remove: (path) => rm(path, { force: true })
    }
    const builder = new SupportBundleBuilder({
      clock: () => new Date('2026-08-15T12:00:00.000Z'),
      io
    })
    let caught: SupportBundleError | null = null
    try {
      await builder.build(target, sourcesFixture())
    } catch (err) {
      caught = err instanceof SupportBundleError ? err : null
    }
    console.log('[qa-failure] write scenario caught:', caught?.code)
    expect(caught?.code).toBe('write')
    expect(await listing(dir)).toEqual([])
  })

  it('scenario 3: deletion failure -> fail closed, no temp/zip path survives', async () => {
    const dir = join(QA_ROOT, 'delete')
    const target = join(dir, 'bundle.zip')
    let removeAttempts = 0
    const io: SupportBundleIo = {
      writeFile: (path, data) => writeFile(path, data),
      rename: async () => {
        throw new Error('EEXIST: simulated rename failure to force teardown')
      },
      remove: async (_path) => {
        removeAttempts += 1
        throw new Error('EACCES: simulated deletion failure')
      }
    }
    const builder = new SupportBundleBuilder({
      clock: () => new Date('2026-08-15T12:00:00.000Z'),
      io
    })
    let caught: SupportBundleError | null = null
    try {
      await builder.build(target, sourcesFixture())
    } catch (err) {
      caught = err instanceof SupportBundleError ? err : null
    }
    console.log(
      '[qa-failure] delete scenario caught:',
      caught?.code,
      '| removal attempts:',
      removeAttempts
    )
    expect(caught).toBeInstanceOf(SupportBundleError)
    expect(removeAttempts).toBeGreaterThan(0)
    // Fallback deletion mechanisms cleaned every temp/partial path.
    expect(await listing(dir)).toEqual([])
  })

  it('scenario 4: final-rename failure -> rename error, no archive', async () => {
    const dir = join(QA_ROOT, 'rename')
    const target = join(dir, 'bundle.zip')
    const io: SupportBundleIo = {
      writeFile: (path, data) => writeFile(path, data),
      rename: async () => {
        throw new Error('EACCES: simulated final rename failure')
      },
      remove: (path) => rm(path, { force: true })
    }
    const builder = new SupportBundleBuilder({
      clock: () => new Date('2026-08-15T12:00:00.000Z'),
      io
    })
    let caught: SupportBundleError | null = null
    try {
      await builder.build(target, sourcesFixture())
    } catch (err) {
      caught = err instanceof SupportBundleError ? err : null
    }
    console.log('[qa-failure] rename scenario caught:', caught?.code)
    expect(caught?.code).toBe('rename')
    expect(await listing(dir)).toEqual([])
  })

  it('all four scenarios leave zero .zip and zero temp paths anywhere', async () => {
    const all: string[] = []
    for (const name of SCENARIOS) {
      all.push(...(await listing(join(QA_ROOT, name))))
    }
    console.log('[qa-failure] leftover paths across all scenarios:', JSON.stringify(all))
    expect(all).toEqual([])
  })
})
