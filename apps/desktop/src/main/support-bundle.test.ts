/**
 * Support-bundle export contracts (plan Todo 24).
 *
 * The archive is a deterministic, fail-closed artifact: EXACT allowlist
 * membership and order, FIXED ZIP timestamps and permissions, per-log 1 MiB
 * cap and 5 MiB archive budget, every structured value and log line redacted +
 * path-sanitized, a recursive sentinel scan that fails closed, and teardown of
 * every temp/partial path on leak/write/delete/rename/cancel failure.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@hubfetch/shared'
import type { DiagnosticReport } from '@hubfetch/shared'
import { diagnosticReportSchema } from '@hubfetch/shared'
import { SecretRegistry } from './security/secret-registry'
import { Redactor } from './security/redaction'
import {
  crc32,
  FIXED_ZIP_DATETIME,
  FIXED_ZIP_EXTERNAL_ATTRS,
  MAX_LOG_MEMBER_BYTES,
  MAX_ARCHIVE_BYTES,
  SUPPORT_BUNDLE_MEMBERS,
  SupportBundleBuilder,
  SupportBundleError,
  TRUNCATION_MARKER,
  type BundleSources,
  type SupportBundleIo
} from './support-bundle'

export const SENTINEL = 'hf_support_test_sentinel_2026'

const FIXED_CLOCK = () => new Date('2026-08-15T12:00:00.000Z')

function reportFixture(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  const report = {
    checks: [
      {
        id: 'app.identity',
        category: 'app' as const,
        status: 'pass' as const,
        reasonCode: 'ok' as const,
        message: 'HubFetch 0.2.0 (packaged build)',
        detail: 'Electron 43.1.0',
        durationMs: 0,
        checkedAt: '2026-08-15T12:00:00.000Z'
      }
    ],
    completedAt: '2026-08-15T12:00:00.000Z',
    ...overrides
  }
  const parsed = diagnosticReportSchema.safeParse(report)
  if (!parsed.success) throw new Error(`fixture report invalid: ${parsed.error.message}`)
  return parsed.data
}

function sourcesFixture(): BundleSources {
  return {
    app: {
      app: 'HubFetch',
      version: '0.2.0',
      buildKind: 'packaged',
      electron: '43.1.0',
      node: '24.16.0',
      chrome: '140.0.0.0',
      v8: '13.0.0.0'
    },
    system: {
      os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
      cpu: { model: 'Intel(R) Core(TM) i7-14700', count: 20 },
      memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 },
      disk: { freeBytes: 250 * 1024 ** 3 }
    },
    diagnostics: reportFixture(),
    settings: { ...DEFAULT_SETTINGS, hfCacheDir: 'C:\\Users\\qa\\.cache\\huggingface\\hub' },
    tasks: [
      {
        id: 'task-1',
        repoId: 'openai-community/gpt2',
        kind: 'model' as const,
        revision: 'main',
        resumable: true,
        status: 'running' as const,
        totalBytes: 548123,
        receivedBytes: 123456,
        speedBps: 1024,
        files: [],
        createdAt: '2026-08-15T10:00:00.000Z',
        proxy: { mode: 'manual' as const, url: 'http://127.0.0.1:7897' }
      }
    ],
    mainLog:
      '2026-08-15T11:00:00Z [main] app ready\n2026-08-15T11:01:00Z [downloads] transfer started\n',
    rendererLog:
      '2026-08-15T11:00:00Z [renderer] boot\n2026-08-15T11:01:00Z [renderer] cache scan complete\n'
  }
}

/** Minimal ZIP central-directory reader for assertions (not the app code). */
interface ZipEntryMeta {
  name: string
  date: number
  time: number
  externalAttrs: number
  crc: number
  usize: number
  csize: number
  localOffset: number
}

function readZipEntries(buffer: Buffer): ZipEntryMeta[] {
  // EOCD is the last 22 bytes (comment length 0 for our writer).
  const eocd = buffer.length - 22
  expect(buffer.readUInt32LE(eocd)).toBe(0x06054b50)
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntryMeta[] = []
  let cursor = cdOffset
  const end = cdOffset + cdSize
  while (cursor < end) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    entries.push({
      name: buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'),
      time: buffer.readUInt16LE(cursor + 12),
      date: buffer.readUInt16LE(cursor + 14),
      crc: buffer.readUInt32LE(cursor + 16),
      csize: buffer.readUInt32LE(cursor + 20),
      usize: buffer.readUInt32LE(cursor + 24),
      externalAttrs: buffer.readUInt32LE(cursor + 38),
      localOffset: buffer.readUInt32LE(cursor + 42)
    })
    cursor += 46 + nameLen + extraLen + commentLen
  }
  expect(entries).toHaveLength(count)
  return entries
}

function readZipMember(buffer: Buffer, name: string): Buffer {
  const entries = readZipEntries(buffer)
  const entry = entries.find((e) => e.name === name)
  if (!entry) throw new Error(`member not found: ${name}`)
  const header = entry.localOffset
  expect(buffer.readUInt32LE(header)).toBe(0x04034b50)
  const nameLen = buffer.readUInt16LE(header + 26)
  const extraLen = buffer.readUInt16LE(header + 28)
  const data = buffer.subarray(
    header + 30 + nameLen + extraLen,
    header + 30 + nameLen + extraLen + entry.csize
  )
  return inflateRawSync(data)
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

function passThroughIo(): SupportBundleIo {
  return {
    writeFile: (path, data) => writeFile(path, data),
    rename: (from, to) => rename(from, to),
    remove: (path) => rm(path, { force: true })
  }
}

const TEST_ROOT = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test')

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  for (const sub of ['', 'leak', 'write-fail', 'delete-fail', 'rename-fail', 'cancel']) {
    mkdirSync(join(TEST_ROOT, sub), { recursive: true })
  }
})

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })
})

describe('support bundle allowlist', () => {
  it('is exactly the policy list', () => {
    expect([...SUPPORT_BUNDLE_MEMBERS]).toEqual([
      'manifest.json',
      'app.json',
      'system.json',
      'diagnostics.json',
      'settings.json',
      'tasks-summary.json',
      'logs/main.log',
      'logs/renderer.log',
      'README.txt'
    ])
  })
})

describe('SupportBundleBuilder happy path', () => {
  it('writes exactly the allowlist members in allowlist order with fixed timestamps and permissions', async () => {
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK })
    const target = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'bundle.zip')
    await builder.build(target, sourcesFixture())
    const buffer = await readFile(target)
    const entries = readZipEntries(buffer)
    expect(entries.map((e) => e.name)).toEqual([...SUPPORT_BUNDLE_MEMBERS])
    const dos = {
      date:
        ((FIXED_ZIP_DATETIME.year - 1980) << 9) |
        (FIXED_ZIP_DATETIME.month << 5) |
        FIXED_ZIP_DATETIME.day,
      time:
        (FIXED_ZIP_DATETIME.hour << 11) |
        (FIXED_ZIP_DATETIME.minute << 5) |
        (FIXED_ZIP_DATETIME.second >> 1)
    }
    for (const entry of entries) {
      expect(entry.date, entry.name).toBe(dos.date)
      expect(entry.time, entry.name).toBe(dos.time)
      expect(entry.externalAttrs, entry.name).toBe(FIXED_ZIP_EXTERNAL_ATTRS)
    }
  })

  it('serializes every structured member as schema-parseable JSON', async () => {
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK })
    const target = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'bundle-json.zip')
    await builder.build(target, sourcesFixture())
    const buffer = await readFile(target)
    const diagnostics = JSON.parse(readZipMember(buffer, 'diagnostics.json').toString('utf8'))
    const parsed = diagnosticReportSchema.safeParse(diagnostics)
    expect(parsed.success).toBe(true)
    const manifest = JSON.parse(readZipMember(buffer, 'manifest.json').toString('utf8'))
    expect(manifest.format).toBe('hubfetch-support-bundle')
    expect(manifest.members).toEqual([...SUPPORT_BUNDLE_MEMBERS])
    expect(manifest.createdAt).toBe('2026-08-15T12:00:00.000Z')
    const settings = JSON.parse(readZipMember(buffer, 'settings.json').toString('utf8'))
    // Personal paths are collapsed to <path>, never raw machine paths.
    expect(JSON.stringify(settings)).not.toContain('C:\\Users')
    const tasks = JSON.parse(readZipMember(buffer, 'tasks-summary.json').toString('utf8'))
    expect(tasks.count).toBe(1)
    expect(tasks.tasks[0].repoId).toBe('openai-community/gpt2')
  })

  it('caps each log member at 1 MiB with the truncation marker', async () => {
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK })
    const target = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'bundle-logs.zip')
    const sources = sourcesFixture()
    sources.mainLog = 'log line of diagnostic text\n'.repeat(MAX_LOG_MEMBER_BYTES * 2)
    sources.rendererLog = 'renderer log line\n'.repeat(
      Math.floor(MAX_LOG_MEMBER_BYTES / 2 / 'renderer log line\n'.length)
    )
    const result = await builder.build(target, sources)
    const buffer = await readFile(target)
    const main = readZipMember(buffer, 'logs/main.log')
    expect(main.length).toBeLessThanOrEqual(MAX_LOG_MEMBER_BYTES + TRUNCATION_MARKER.length)
    expect(main.subarray(-TRUNCATION_MARKER.length).toString('utf8')).toBe(TRUNCATION_MARKER)
    expect(result.truncatedLogs).toEqual(['logs/main.log'])
    const renderer = readZipMember(buffer, 'logs/renderer.log')
    expect(renderer.length).toBeLessThanOrEqual(MAX_LOG_MEMBER_BYTES + TRUNCATION_MARKER.length)
  })

  it('keeps every member within the 5 MiB archive budget', async () => {
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK })
    const target = join(
      process.cwd(),
      '.omo',
      'scratch',
      'support-bundle-test',
      'bundle-budget.zip'
    )
    const sources = sourcesFixture()
    sources.mainLog = 'a'.repeat(MAX_LOG_MEMBER_BYTES)
    sources.rendererLog = 'b'.repeat(MAX_LOG_MEMBER_BYTES)
    await builder.build(target, sources)
    const buffer = await readFile(target)
    const entries = readZipEntries(buffer)
    const totalUsize = entries.reduce((acc, e) => acc + e.usize, 0)
    expect(totalUsize).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES)
  })

  it('rejects an archive over the budget and leaves nothing', async () => {
    const builder = new SupportBundleBuilder({
      clock: FIXED_CLOCK,
      maxArchiveBytes: 1024
    })
    const target = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'bundle-over.zip')
    await expect(builder.build(target, sourcesFixture())).rejects.toBeInstanceOf(SupportBundleError)
    expect(
      await listDir(join(process.cwd(), '.omo', 'scratch', 'support-bundle-test'))
    ).not.toContain('bundle-over.zip')
  })

  it('rejects an invalid target and leaves no archive', async () => {
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK })
    const target = join(process.cwd(), '.omo', 'scratch', 'missing-parent-dir', 'bundle.zip')
    await expect(builder.build(target, sourcesFixture())).rejects.toBeInstanceOf(SupportBundleError)
    expect(await listDir(join(process.cwd(), '.omo', 'scratch'))).not.toContain(
      'missing-parent-dir'
    )
  })

  it('redacts a registered sentinel from every member (recursive scan zero)', async () => {
    const registry = new SecretRegistry()
    registry.register(SENTINEL)
    const redactor = new Redactor(registry)
    const builder = new SupportBundleBuilder({
      clock: FIXED_CLOCK,
      redactor,
      leakGuard: () => registry.liveSecrets()
    })
    const target = join(
      process.cwd(),
      '.omo',
      'scratch',
      'support-bundle-test',
      'bundle-redacted.zip'
    )
    const sources = sourcesFixture()
    sources.mainLog = `token=${SENTINEL} attached\n`
    sources.rendererLog = `renderer received ${SENTINEL}\n`
    sources.diagnostics = reportFixture({
      checks: [
        {
          id: 'network.huggingface',
          category: 'network',
          status: 'pass',
          reasonCode: 'ok',
          message: `reachable with ${SENTINEL}`,
          durationMs: 1,
          checkedAt: '2026-08-15T12:00:00.000Z'
        }
      ]
    })
    const result = await builder.build(target, sources)
    const buffer = await readFile(target)
    // Recursive scan: the sentinel must not appear in any member name or bytes.
    for (const entry of readZipEntries(buffer)) {
      expect(entry.name).not.toContain(SENTINEL)
      expect(readZipMember(buffer, entry.name).toString('utf8')).not.toContain(SENTINEL)
    }
    // And the redaction token replaced it.
    expect(result.members).toHaveLength(SUPPORT_BUNDLE_MEMBERS.length)
    const settings = readZipMember(buffer, 'settings.json').toString('utf8')
    expect(settings).not.toContain(SENTINEL)
  })

  it('produces byte-identical archives (same digest) for identical inputs', async () => {
    const first = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'bundle-first.zip')
    const second = join(
      process.cwd(),
      '.omo',
      'scratch',
      'support-bundle-test',
      'bundle-second.zip'
    )
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK })
    const r1 = await builder.build(first, sourcesFixture())
    const r2 = await builder.build(second, sourcesFixture())
    expect(r1.digest).toBe(r2.digest)
    expect(await readFile(first)).toEqual(await readFile(second))
  })
})

describe('SupportBundleBuilder fail-closed paths', () => {
  it('rejects a sentinel that survived redaction and leaves no archive', async () => {
    // Simulate a sentinel injected AFTER redaction: the redactor has no registry
    // (so the value is not replaced), but the leak guard claims it is live.
    const builder = new SupportBundleBuilder({
      clock: FIXED_CLOCK,
      redactor: new Redactor(null),
      leakGuard: () => [SENTINEL]
    })
    const dir = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'leak')
    const target = join(dir, 'bundle-leak.zip')
    const sources = sourcesFixture()
    sources.mainLog = `line with ${SENTINEL} survives\n`
    await expect(builder.build(target, sources)).rejects.toMatchObject({ code: 'leak' })
    expect(await listDir(dir)).toEqual([])
  })

  it('fails closed on a disk-write failure and leaves no temp/zip path', async () => {
    const failingIo: SupportBundleIo = {
      ...passThroughIo(),
      writeFile: async () => {
        throw new Error('EACCES: simulated disk write failure')
      }
    }
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK, io: failingIo })
    const dir = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'write-fail')
    const target = join(dir, 'bundle-write.zip')
    await expect(builder.build(target, sourcesFixture())).rejects.toMatchObject({ code: 'write' })
    expect(await listDir(dir)).toEqual([])
  })

  it('fails closed on a deletion failure (temp still cleaned via fallback)', async () => {
    let removeCalls = 0
    const failingIo: SupportBundleIo = {
      ...passThroughIo(),
      remove: async (_path) => {
        removeCalls += 1
        throw new Error('EACCES: simulated deletion failure')
      },
      rename: async () => {
        throw new Error('EEXIST: simulated rename failure')
      }
    }
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK, io: failingIo })
    const dir = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'delete-fail')
    const target = join(dir, 'bundle-delete.zip')
    await expect(builder.build(target, sourcesFixture())).rejects.toBeInstanceOf(SupportBundleError)
    expect(removeCalls).toBeGreaterThan(0)
    // The exporter's fallback deletion mechanisms still remove every path.
    expect(await listDir(dir)).toEqual([])
  })

  it('fails closed on a final-rename failure and leaves no temp/zip path', async () => {
    const failingIo: SupportBundleIo = {
      ...passThroughIo(),
      rename: async () => {
        throw new Error('EACCES: simulated final rename failure')
      }
    }
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK, io: failingIo })
    const dir = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'rename-fail')
    const target = join(dir, 'bundle-rename.zip')
    await expect(builder.build(target, sourcesFixture())).rejects.toMatchObject({ code: 'rename' })
    expect(await listDir(dir)).toEqual([])
  })

  it('cancellation cleans the temp archive and fails closed', async () => {
    const controller = new AbortController()
    const builder = new SupportBundleBuilder({ clock: FIXED_CLOCK, signal: controller.signal })
    const dir = join(process.cwd(), '.omo', 'scratch', 'support-bundle-test', 'cancel')
    const target = join(dir, 'bundle-cancel.zip')
    controller.abort()
    await expect(builder.build(target, sourcesFixture())).rejects.toMatchObject({
      code: 'canceled'
    })
    expect(await listDir(dir)).toEqual([])
  })
})
