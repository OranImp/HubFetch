/**
 * QA happy path (plan Todo 24): register an arbitrary sentinel, run the
 * diagnostics service, export a support bundle to a Unicode + spaced path, and
 * prove the ZIP contains ONLY redacted data with the exact policy allowlist.
 * Prints `[qa-happy]` evidence lines. No network — fake adapters throughout.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, diagnosticReportSchema } from '@hubfetch/shared'
import type {
  AppInfoSnapshot,
  CommandOutcome,
  DiagnosticsEnv,
  ProcessInfo
} from './diagnostics-env'
import { DiagnosticsService } from './diagnostics'
import { Redactor } from './security/redaction'
import { SecretRegistry } from './security/secret-registry'
import { SUPPORT_BUNDLE_MEMBERS, SupportBundleBuilder, type BundleSources } from './support-bundle'

export const QA_SENTINEL = 'qa_sentinel_hubfetch_2026_☃'

const PROCESS_INFO: ProcessInfo = {
  platform: 'win32',
  release: '10.0.26100',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) i7-14700',
  cpuCount: 20,
  totalMemBytes: 16 * 1024 ** 3,
  freeMemBytes: 8 * 1024 ** 3
}

function healthyRoute(argv: readonly string[]): CommandOutcome {
  const [cmd, sub] = [argv[0], argv[1]]
  if (cmd === 'git' && sub === '--version')
    return { status: 'completed', exitCode: 0, stdout: 'git version 2.47.0.windows.1', stderr: '' }
  if (cmd === 'git' && sub === 'xet')
    return { status: 'completed', exitCode: 0, stdout: 'git-xet version 0.14.0', stderr: '' }
  if (cmd === 'git' && sub === 'config') {
    if (argv.includes('--get-regexp'))
      return {
        status: 'completed',
        exitCode: 0,
        stdout: 'file\tfilter.xet.process\tgit-xet filter',
        stderr: ''
      }
    if (argv.includes('--get-all'))
      return { status: 'completed', exitCode: 0, stdout: 'file\tmanager', stderr: '' }
  }
  return { status: 'completed', exitCode: 1, stdout: '', stderr: '' }
}

function healthyEnv(): DiagnosticsEnv {
  return {
    getProcessInfo: () => PROCESS_INFO,
    getDiskFreeBytes: async () => 250 * 1024 ** 3,
    probeDirectory: async () => ({ writable: true, symlinkCapable: true }),
    scanDirectorySize: async () => ({
      sizeBytes: 3.2 * 1024 ** 3,
      entryCount: 512,
      bounded: false
    }),
    getCacheDir: () => 'C:\\Users\\qa\\.cache\\huggingface\\hub',
    getDestinationDir: () => 'C:\\Users\\qa\\.cache\\huggingface\\hub',
    getNotificationRegistration: () => ({ status: 'registered' }),
    getDbHealth: async () => ({ ok: true }),
    runCommand: async (argv) => healthyRoute(argv),
    checkReachability: async () => ({ reachable: true, statusCode: 200, proxyRoute: 'manual' }),
    getAppInfo: (): AppInfoSnapshot => ({
      version: '0.2.0',
      buildKind: 'packaged',
      electronVersion: '43.1.0'
    })
  }
}

function readZipEntries(
  buffer: Buffer
): { name: string; usize: number; csize: number; localOffset: number }[] {
  const eocd = buffer.length - 22
  expect(buffer.readUInt32LE(eocd)).toBe(0x06054b50)
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  const entries: { name: string; usize: number; csize: number; localOffset: number }[] = []
  let cursor = cdOffset
  while (cursor < cdOffset + cdSize) {
    const nameLen = buffer.readUInt16LE(cursor + 28)
    entries.push({
      name: buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'),
      usize: buffer.readUInt32LE(cursor + 24),
      csize: buffer.readUInt32LE(cursor + 20),
      localOffset: buffer.readUInt32LE(cursor + 42)
    })
    cursor += 46 + nameLen
  }
  expect(entries).toHaveLength(count)
  return entries
}

function readZipMember(buffer: Buffer, name: string): Buffer {
  const entry = readZipEntries(buffer).find((e) => e.name === name)
  if (!entry) throw new Error(`missing member ${name}`)
  const header = entry.localOffset
  const nameLen = buffer.readUInt16LE(header + 26)
  const extraLen = buffer.readUInt16LE(header + 28)
  const data = buffer.subarray(
    header + 30 + nameLen + extraLen,
    header + 30 + nameLen + extraLen + entry.csize
  )
  return inflateRawSync(data)
}

describe('QA happy — arbitrary sentinel, diagnostics run, export to Unicode/spaced path', () => {
  it('exports a support bundle whose only trace of the sentinel is [REDACTED]', async () => {
    const registry = new SecretRegistry()
    registry.register(QA_SENTINEL)
    const redactor = new Redactor(registry)
    const report = await new DiagnosticsService(healthyEnv()).run()
    const parsed = diagnosticReportSchema.safeParse(report)
    expect(parsed.success).toBe(true)
    console.log('[qa-happy] diagnostics report:', report.checks.length, 'checks (schema-validated)')

    const sources: BundleSources = {
      app: { app: 'HubFetch', version: '0.2.0', buildKind: 'packaged', electron: '43.1.0' },
      system: {
        os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
        cpu: { model: 'Intel(R) Core(TM) i7-14700', count: 20 },
        memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 },
        disk: { freeBytes: 250 * 1024 ** 3 }
      },
      diagnostics: report,
      settings: { ...DEFAULT_SETTINGS, hfCacheDir: 'C:\\Users\\qa\\.cache\\huggingface\\hub' },
      tasks: [
        {
          id: 'task-1',
          repoId: 'openai-community/gpt2',
          kind: 'model',
          revision: 'main',
          resumable: true,
          status: 'running',
          totalBytes: 548123,
          receivedBytes: 123456,
          speedBps: 1024,
          files: [],
          createdAt: '2026-08-15T10:00:00.000Z',
          proxy: { mode: 'manual', url: 'http://127.0.0.1:7897' }
        }
      ],
      mainLog: `[main] signed in with ${QA_SENTINEL}\n[main] download started\n`,
      rendererLog: `[renderer] cache scan saw ${QA_SENTINEL}\n`
    }

    // Unicode + spaces in the target directory and filename.
    const dir = join(process.cwd(), '.omo', 'scratch', 'qa-bundle 支持包 ☃')
    const target = join(dir, 'hubfetch support bundle 支持 ☃.zip')
    const { mkdir, rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    const builder = new SupportBundleBuilder({
      clock: () => new Date('2026-08-15T12:00:00.000Z'),
      redactor,
      leakGuard: () => registry.liveSecrets()
    })
    const result = await builder.build(target, sources)
    console.log('[qa-happy] export result:', JSON.stringify(result, null, 2))
    const buffer = await readFile(target)
    const entries = readZipEntries(buffer)
    console.log('[qa-happy] members:', entries.map((e) => e.name).join(', '))
    expect(entries.map((e) => e.name)).toEqual([...SUPPORT_BUNDLE_MEMBERS])
    expect(entries.length).toBe(SUPPORT_BUNDLE_MEMBERS.length)

    // The sentinel must be absent from every member name and bytes (recursive scan).
    for (const entry of entries) {
      expect(entry.name).not.toContain(QA_SENTINEL)
      const member = readZipMember(buffer, entry.name).toString('utf8')
      expect(member).not.toContain(QA_SENTINEL)
    }
    // Only redacted data: the sentinel became [REDACTED] everywhere it appeared.
    const allText = entries.map((e) => readZipMember(buffer, e.name).toString('utf8')).join('\n')
    console.log('[qa-happy] [REDACTED] occurrences:', (allText.match(/\[REDACTED\]/g) ?? []).length)
    expect(allText).toContain('[REDACTED]')
    expect(allText).not.toContain('C:\\Users\\qa')
    // Structured members parse schemas.
    const diagnostics = JSON.parse(readZipMember(buffer, 'diagnostics.json').toString('utf8'))
    const parsedReport = diagnosticReportSchema.safeParse(diagnostics)
    if (!parsedReport.success)
      console.log(
        '[qa-happy] schema error:',
        parsedReport.error.issues.map((i) => i.path.join('.')).join('; ')
      )
    expect(parsedReport.success).toBe(true)
    console.log('[qa-happy] diagnostics.json parses diagnosticReportSchema')
    console.log('[qa-happy] target parent dir listing:', (await readdir(dir)).join(', '))
    expect(await readdir(dir)).toEqual([result.path.slice(result.path.lastIndexOf('\\') + 1)])
  })
})
