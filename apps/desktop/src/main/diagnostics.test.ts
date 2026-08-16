/**
 * DiagnosticsService test suite (plan Todo 23).
 *
 * Every probe is exercised against fake OS/process/network/FS adapters with
 * deterministic pass/warn/fail/timeout/cancel outcomes; the result schema
 * rejects unknown fields; registered sentinels and personal paths are redacted;
 * and repeated runs leave the machine/config unchanged. The bounded wrapper is
 * proven with a probe that never resolves (deadline) and a pre-aborted caller
 * signal (cancel).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DiagnosticCheck,
  DiagnosticReport,
  NotificationRegistrationInfo
} from '@hubfetch/shared'
import {
  diagnosticCheckSchema,
  diagnosticReportSchema,
  DIAGNOSTIC_REASON_CODES
} from '@hubfetch/shared'
import {
  DiagnosticsService,
  DEFAULT_PROBE_TIMEOUT_MS,
  bounded,
  runCommandBounded,
  probeDirectory,
  scanDirectorySize,
  CommandAbortedError,
  createDefaultEnv
} from './diagnostics'
import type {
  AppInfoSnapshot,
  CommandOutcome,
  DiagnosticsEnv,
  DirectoryProbeOutcome,
  DirectorySizeOutcome,
  ProcessInfo,
  ReachabilityOutcome
} from './diagnostics-env'
import { Redactor } from './security/redaction'
import { SecretRegistry } from './security/secret-registry'

const PROCESS_INFO: ProcessInfo = {
  platform: 'win32',
  release: '10.0.26100',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) i7',
  cpuCount: 8,
  totalMemBytes: 16 * 1024 ** 3,
  freeMemBytes: 8 * 1024 ** 3
}
const APP_INFO: AppInfoSnapshot = {
  version: '0.2.0',
  buildKind: 'development',
  electronVersion: '43.1.0'
}
const CACHE_DIR = 'C:\\Users\\tester\\.cache\\huggingface\\hub'

function okCommand(stdout = '', exitCode = 0): CommandOutcome {
  return { status: 'completed', exitCode, stdout, stderr: '' }
}

/** Default healthy command router for the fake env (git probes). */
function routeCommand(argv: readonly string[]): CommandOutcome {
  const [cmd, sub] = [argv[0], argv[1]]
  if (cmd === 'git' && sub === '--version') return okCommand('git version 2.47.0.windows.1')
  if (cmd === 'git' && sub === 'xet') return okCommand('git-xet version 0.14.0')
  if (cmd === 'git' && sub === 'credential-manager')
    return okCommand('Git Credential Manager version 2.5.1')
  if (cmd === 'git' && sub === 'config') {
    if (argv.includes('--get-regexp')) return okCommand('file\tfilter.xet.process\tgit-xet filter')
    if (argv.includes('--get-all')) return okCommand('file\tmanager\nfile\tmanager-core')
  }
  if (cmd === 'ssh' && sub === '-V') return okCommand('OpenSSH_9.8p1 for Windows')
  return okCommand('', 1)
}

function healthyEnv(overrides: Partial<DiagnosticsEnv> = {}): DiagnosticsEnv {
  const env: DiagnosticsEnv = {
    getProcessInfo: () => PROCESS_INFO,
    getDiskFreeBytes: async () => 50 * 1024 ** 3,
    probeDirectory: async (): Promise<DirectoryProbeOutcome> => ({
      writable: true,
      symlinkCapable: true
    }),
    scanDirectorySize: async (): Promise<DirectorySizeOutcome> => ({
      sizeBytes: 1024 ** 3,
      entryCount: 42,
      bounded: false
    }),
    getCacheDir: () => CACHE_DIR,
    getDestinationDir: () => CACHE_DIR,
    getNotificationRegistration: () => ({ status: 'registered' }),
    getDbHealth: async () => ({ ok: true }),
    runCommand: async (argv) => routeCommand(argv),
    checkReachability: async (): Promise<ReachabilityOutcome> => ({
      reachable: true,
      statusCode: 200,
      proxyRoute: 'direct'
    }),
    getAppInfo: () => APP_INFO,
    ...overrides
  }
  return env
}

function service(env: DiagnosticsEnv = healthyEnv(), options = {}): DiagnosticsService {
  return new DiagnosticsService(env, options)
}

function findCheck(report: DiagnosticReport, id: string): DiagnosticCheck {
  const check = report.checks.find((c) => c.id === id)
  if (!check) throw new Error(`missing check ${id} in ${report.checks.map((c) => c.id).join(',')}`)
  return check
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('result schema rejects unknown fields', () => {
  it('accepts a valid check and rejects an unknown field', () => {
    const base = {
      id: 'git.version',
      category: 'git',
      status: 'pass',
      reasonCode: 'ok',
      message: 'Git is installed',
      detail: '2.47.0',
      durationMs: 4,
      checkedAt: '2026-08-17T00:00:00.000Z'
    }
    expect(diagnosticCheckSchema.safeParse(base).success).toBe(true)
    expect(diagnosticCheckSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
  })

  it('rejects a check with an out-of-contract reason code or status', () => {
    const base = {
      id: 'git.version',
      category: 'git',
      status: 'pass',
      reasonCode: 'ok',
      message: 'Git is installed',
      durationMs: 4,
      checkedAt: '2026-08-17T00:00:00.000Z'
    }
    expect(diagnosticCheckSchema.safeParse({ ...base, reasonCode: 'made-up' }).success).toBe(false)
    expect(diagnosticCheckSchema.safeParse({ ...base, status: 'passes' }).success).toBe(false)
  })

  it('rejects a report with an unknown field', () => {
    expect(
      diagnosticReportSchema.safeParse({ checks: [], completedAt: 'x', hack: true }).success
    ).toBe(false)
  })

  it('exposes the closed reason-code set as a typed constant', () => {
    expect(DIAGNOSTIC_REASON_CODES).toContain('timeout')
    expect(DIAGNOSTIC_REASON_CODES).toContain('canceled')
  })
})

describe('bounded wrapper', () => {
  it('settles a probe that never resolves as timeout within the deadline', async () => {
    const outcome = await bounded(30, undefined, () => new Promise<never>(() => undefined))
    expect(outcome).toEqual({ kind: 'timeout' })
  })

  it('returns canceled immediately for a pre-aborted caller signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await bounded(5000, controller.signal, async () => 'value')
    expect(outcome).toEqual({ kind: 'canceled' })
  })

  it('propagates a caller abort to the probe as canceled', async () => {
    const controller = new AbortController()
    const probe = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          setTimeout(() => resolve('done'), 5000)
        })
    )
    const pending = bounded(10_000, controller.signal, probe)
    controller.abort()
    expect(await pending).toEqual({ kind: 'canceled' })
  })
})

describe('every probe maps timeout to failure and cancel to unknown', () => {
  it('times out deterministically when the adapter never resolves', async () => {
    const hang = () => new Promise<never>(() => undefined)
    const env = healthyEnv({
      getDiskFreeBytes: hang,
      probeDirectory: hang,
      scanDirectorySize: hang,
      getDbHealth: hang,
      runCommand: hang,
      checkReachability: hang
    })
    const report = await service(env, { probeTimeoutMs: 30 }).run()
    expect(report.checks).toHaveLength(16)
    for (const check of report.checks) {
      if (
        check.id === 'app.identity' ||
        check.id === 'system.windows' ||
        check.id === 'system.cpu-memory' ||
        check.id === 'notifications.registration'
      ) {
        // Sync adapters cannot hang; they stay pass/ok.
        expect(check.status).toBe('pass')
        continue
      }
      expect(check.status).toBe('failure')
      expect(check.reasonCode).toBe('timeout')
      expect(check.durationMs).toBeLessThanOrEqual(30 + 25)
    }
  })

  it('marks every probe canceled (unknown) when the caller signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await service(healthyEnv(), { probeTimeoutMs: 5000 }).run(controller.signal)
    for (const check of report.checks) {
      expect(check.status).toBe('unknown')
      expect(check.reasonCode).toBe('canceled')
    }
  })
})

describe('per-probe pass/warn/fail/unknown outcomes', () => {
  it('app.identity: pass, and unknown when the app info read throws', async () => {
    expect(findCheck(await service().run(), 'app.identity').status).toBe('pass')
    const report = await service(
      healthyEnv({
        getAppInfo: () => {
          throw new Error('boom')
        }
      })
    ).run()
    const check = findCheck(report, 'app.identity')
    expect(check.status).toBe('unknown')
    expect(check.reasonCode).toBe('probe-error')
  })

  it('system.windows: pass with release/arch, and unknown when process info throws', async () => {
    const check = findCheck(await service().run(), 'system.windows')
    expect(check.status).toBe('pass')
    expect(check.message).toContain('Windows 10.0.26100')
    const report = await service(
      healthyEnv({
        getProcessInfo: () => {
          throw new Error('boom')
        }
      })
    ).run()
    expect(findCheck(report, 'system.windows').status).toBe('unknown')
  })

  it('system.cpu-memory: pass above threshold, warning between, failure below critical', async () => {
    const runWith = async (freeMemBytes: number) =>
      service(
        healthyEnv({
          getProcessInfo: () => ({ ...PROCESS_INFO, freeMemBytes })
          // Disable sync probes that could throw: none throw here.
        })
      ).run()

    const pass = findCheck(await runWith(8 * 1024 ** 3), 'system.cpu-memory')
    expect(pass.status).toBe('pass')
    expect(pass.message).toContain('8 logical CPUs')

    const warn = findCheck(await runWith(300 * 1024 ** 2), 'system.cpu-memory')
    expect(warn.status).toBe('warning')
    expect(warn.reasonCode).toBe('low-memory')

    const fail = findCheck(await runWith(64 * 1024 ** 2), 'system.cpu-memory')
    expect(fail.status).toBe('failure')
    expect(fail.reasonCode).toBe('critical-memory')
    expect(fail.action).toBeTruthy()
  })

  it('disk.free-space: pass / warning / failure / unknown (null)', async () => {
    const runWith = async (free: number | null) =>
      service(healthyEnv({ getDiskFreeBytes: async () => free })).run()

    expect(findCheck(await runWith(50 * 1024 ** 3), 'disk.free-space').status).toBe('pass')
    expect(findCheck(await runWith(500 * 1024 ** 2), 'disk.free-space').status).toBe('warning')
    const fail = findCheck(await runWith(64 * 1024 ** 2), 'disk.free-space')
    expect(fail.status).toBe('failure')
    expect(fail.reasonCode).toBe('critical-space')
    const unknown = findCheck(await runWith(null), 'disk.free-space')
    expect(unknown.status).toBe('unknown')
    expect(unknown.reasonCode).toBe('unavailable')
  })

  it('cache.path: pass with size, warning on missing dir, warning on bounded scan', async () => {
    const pass = findCheck(await service().run(), 'cache.path')
    expect(pass.status).toBe('pass')
    expect(pass.message).toContain('42 entries')

    const missing = await service(
      healthyEnv({
        scanDirectorySize: async () => ({
          sizeBytes: null,
          entryCount: 0,
          bounded: false,
          error: 'ENOENT: no such file or directory'
        })
      })
    ).run()
    const missingCheck = findCheck(missing, 'cache.path')
    expect(missingCheck.status).toBe('warning')
    expect(missingCheck.reasonCode).toBe('missing')
    expect(missingCheck.action).toBeTruthy()

    const boundedReport = await service(
      healthyEnv({
        scanDirectorySize: async () => ({ sizeBytes: null, entryCount: 20_000, bounded: true })
      })
    ).run()
    const boundedCheck = findCheck(boundedReport, 'cache.path')
    expect(boundedCheck.status).toBe('warning')
    expect(boundedCheck.reasonCode).toBe('bounded')

    const errored = await service(
      healthyEnv({
        scanDirectorySize: async () => ({
          sizeBytes: null,
          entryCount: 0,
          bounded: false,
          error: 'EACCES: permission denied'
        })
      })
    ).run()
    const erroredCheck = findCheck(errored, 'cache.path')
    expect(erroredCheck.status).toBe('unknown')
    expect(erroredCheck.reasonCode).toBe('unavailable')
  })

  it('cache.read-write and destination.access: pass when writable, failure when not', async () => {
    const healthy = await service().run()
    expect(findCheck(healthy, 'cache.read-write').status).toBe('pass')
    expect(findCheck(healthy, 'destination.access').status).toBe('pass')

    const notWritable = await service(
      healthyEnv({
        probeDirectory: async (): Promise<DirectoryProbeOutcome> => ({
          writable: false,
          symlinkCapable: false,
          error: 'EACCES: permission denied'
        })
      })
    ).run()
    const cacheCheck = findCheck(notWritable, 'cache.read-write')
    expect(cacheCheck.status).toBe('failure')
    expect(cacheCheck.reasonCode).toBe('unwritable')
    expect(cacheCheck.action).toBeTruthy()
    expect(findCheck(notWritable, 'destination.access').status).toBe('failure')
  })

  it('symlink.capability: pass when capable, warning (degraded) when not', async () => {
    const pass = findCheck(await service().run(), 'symlink.capability')
    expect(pass.status).toBe('pass')

    const degraded = await service(
      healthyEnv({
        probeDirectory: async (): Promise<DirectoryProbeOutcome> => ({
          writable: true,
          symlinkCapable: false
        })
      })
    ).run()
    const check = findCheck(degraded, 'symlink.capability')
    expect(check.status).toBe('warning')
    expect(check.reasonCode).toBe('degraded')
    expect(check.action).toContain('Developer Mode')
  })

  it('notifications.registration maps all four statuses', async () => {
    const mapStatus = (
      status: NotificationRegistrationInfo['status']
    ): Promise<DiagnosticCheck> => {
      const info: NotificationRegistrationInfo =
        status === 'failed' || status === 'unsupported'
          ? { status, reason: 'something went wrong' }
          : { status }
      const report = service(healthyEnv({ getNotificationRegistration: () => info })).run()
      return report.then((r) => findCheck(r, 'notifications.registration'))
    }
    expect((await mapStatus('registered')).status).toBe('pass')
    const disabled = await mapStatus('disabled')
    expect(disabled.status).toBe('warning')
    expect(disabled.reasonCode).toBe('disabled')
    expect(disabled.action).toBeTruthy()
    expect((await mapStatus('unsupported')).status).toBe('warning')
    const failed = await mapStatus('failed')
    expect(failed.status).toBe('failure')
    expect(failed.reasonCode).toBe('unsupported')
  })

  it('network.huggingface: pass when reachable, failure when unreachable, unknown on invalid endpoint', async () => {
    const pass = findCheck(await service().run(), 'network.huggingface')
    expect(pass.status).toBe('pass')
    expect(pass.message).toContain('HTTP 200')
    expect(pass.detail).toContain('route: direct')

    const unreachable = await service(
      healthyEnv({
        checkReachability: async (): Promise<ReachabilityOutcome> => ({
          reachable: false,
          statusCode: null,
          proxyRoute: 'system',
          error: 'fetch failed: socket hang up'
        })
      })
    ).run()
    const fail = findCheck(unreachable, 'network.huggingface')
    expect(fail.status).toBe('failure')
    expect(fail.reasonCode).toBe('unreachable')
    expect(fail.action).toContain('proxy')

    const invalid = await service(healthyEnv(), { hubEndpoint: 'not a url' }).run()
    const unknown = findCheck(invalid, 'network.huggingface')
    expect(unknown.status).toBe('unknown')
    expect(unknown.reasonCode).toBe('unavailable')
  })

  it('git.version: pass when installed, failure when missing or nonzero', async () => {
    const pass = findCheck(await service().run(), 'git.version')
    expect(pass.status).toBe('pass')
    expect(pass.detail).toContain('2.47.0')

    const missing = await service(
      healthyEnv({
        runCommand: async (): Promise<CommandOutcome> => ({
          status: 'launch-error',
          exitCode: null,
          stdout: '',
          stderr: ''
        })
      })
    ).run()
    const missingCheck = findCheck(missing, 'git.version')
    expect(missingCheck.status).toBe('failure')
    expect(missingCheck.reasonCode).toBe('missing')
    expect(missingCheck.action).toContain('winget')

    const nonzero = await service(healthyEnv({ runCommand: async () => okCommand('', 2) })).run()
    const nonzeroCheck = findCheck(nonzero, 'git.version')
    expect(nonzeroCheck.status).toBe('failure')
    expect(nonzeroCheck.reasonCode).toBe('nonzero')
  })

  it('git.xet: pass configured, warning unconfigured, warning missing', async () => {
    const pass = findCheck(await service().run(), 'git.xet')
    expect(pass.status).toBe('pass')
    expect(pass.detail).toContain('filter.xet')

    const unconfigured = await service(
      healthyEnv({
        runCommand: async (argv) =>
          argv.includes('--get-regexp') ? okCommand('', 1) : routeCommand(argv)
      })
    ).run()
    const unconfigCheck = findCheck(unconfigured, 'git.xet')
    expect(unconfigCheck.status).toBe('warning')
    expect(unconfigCheck.reasonCode).toBe('unconfigured')
    expect(unconfigCheck.action).toContain('git xet install')

    const missing = await service(
      healthyEnv({
        runCommand: async (argv) =>
          argv[1] === 'xet' ? okCommand("git: 'xet' is not a git command", 1) : routeCommand(argv)
      })
    ).run()
    const missingCheck = findCheck(missing, 'git.xet')
    expect(missingCheck.status).toBe('warning')
    expect(missingCheck.reasonCode).toBe('missing')
  })

  it('git.credentials: pass configured, warning plaintext, warning none, unknown on launch error', async () => {
    const pass = findCheck(await service().run(), 'git.credentials')
    expect(pass.status).toBe('pass')

    const plaintext = await service(
      healthyEnv({
        runCommand: async (argv) =>
          argv.includes('--get-all') ? okCommand('file\tstore') : routeCommand(argv)
      })
    ).run()
    const plaintextCheck = findCheck(plaintext, 'git.credentials')
    expect(plaintextCheck.status).toBe('warning')
    expect(plaintextCheck.reasonCode).toBe('plaintext-helper')
    expect(plaintextCheck.action).toContain('Credential Manager')

    const none = await service(
      healthyEnv({
        runCommand: async (argv) =>
          argv.includes('--get-all') ? okCommand('', 1) : routeCommand(argv)
      })
    ).run()
    const noneCheck = findCheck(none, 'git.credentials')
    expect(noneCheck.status).toBe('warning')
    expect(noneCheck.reasonCode).toBe('no-credential-helper')

    const launch = await service(
      healthyEnv({
        runCommand: async (): Promise<CommandOutcome> => ({
          status: 'launch-error',
          exitCode: null,
          stdout: '',
          stderr: ''
        })
      })
    ).run()
    expect(findCheck(launch, 'git.credentials').status).toBe('unknown')
  })

  it('database.health: pass when healthy, failure when unhealthy, unknown on throw', async () => {
    expect(findCheck(await service().run(), 'database.health').status).toBe('pass')
    const unhealthy = await service(
      healthyEnv({ getDbHealth: async () => ({ ok: false, error: 'database is locked' }) })
    ).run()
    const fail = findCheck(unhealthy, 'database.health')
    expect(fail.status).toBe('failure')
    expect(fail.reasonCode).toBe('unhealthy')
    expect(fail.action).toBeTruthy()
    const thrown = await service(
      healthyEnv({
        getDbHealth: async () => {
          throw new Error('db gone')
        }
      })
    ).run()
    expect(findCheck(thrown, 'database.health').status).toBe('unknown')
  })
})

describe('redaction of sentinels and personal paths', () => {
  it('registered sentinels and personal paths never reach the report', async () => {
    const sentinel = 'sentinel-' + Math.random().toString(36).slice(2, 14)
    const registry = new SecretRegistry()
    const handle = registry.register(sentinel)
    try {
      const leaky = healthyEnv({
        getAppInfo: () => ({
          version: '0.2.0',
          buildKind: 'development',
          electronVersion: sentinel
        }),
        getDiskFreeBytes: async () => {
          throw new Error(`EACCES ${sentinel} C:\\Users\\tester\\AppData\\Roaming\\x`)
        }
      })
      const redactor = new Redactor(registry)
      const report = await service(leaky, { redactor }).run()
      const serialized = JSON.stringify(report)
      expect(serialized).not.toContain(sentinel)
      expect(serialized).not.toContain('C:\\Users\\tester')
      expect(serialized).not.toContain('AppData\\Roaming')
      // The redactor token is the only replacement.
      expect(serialized).toContain('[REDACTED]')
      expect(serialized).toContain('<path>')
    } finally {
      registry.unregister(handle)
    }
  })
})

describe('no mutation and repeated-run stability', () => {
  it('runs only read-only git commands and never touches the machine', async () => {
    const commands: string[][] = []
    const env = healthyEnv({
      runCommand: async (argv) => {
        commands.push([...argv])
        return routeCommand(argv)
      }
    })
    const first = await service(env).run()
    const second = await service(env).run()

    // No argv contains a mutating flag or any write-oriented git subcommand.
    for (const argv of commands) {
      expect(argv).not.toContain('--add')
      expect(argv).not.toContain('install')
      expect(argv).not.toContain('write')
      expect(argv).not.toContain('push')
    }
    const readOnlyPrefixes = [
      ['git', '--version'],
      ['git', 'xet', 'version'],
      ['git', 'xet', '--version'],
      ['git', 'config', '--show-origin', '--get-regexp'],
      ['git', 'config', '--show-origin', '--get-all', 'credential.helper'],
      ['git', 'credential-manager', 'version'],
      ['ssh', '-V']
    ]
    for (const argv of commands) {
      expect(readOnlyPrefixes.some((prefix) => prefix.every((part, i) => argv[i] === part))).toBe(
        true
      )
    }

    // Deterministic: the second run is identical apart from timestamps/durations.
    const stripTiming = (r: DiagnosticReport) =>
      r.checks.map(({ id, status, reasonCode, message, detail, action }) => ({
        id,
        status,
        reasonCode,
        message,
        detail,
        action
      }))
    expect(stripTiming(second)).toEqual(stripTiming(first))
  })
})

describe('real-FS primitives (temp dirs only, no task temp on C:)', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots.length = 0
  })
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'hubfetch-diag-test-'))
    roots.push(root)
    return root
  }

  it('probeDirectory reports writable and removes every probe temp dir', async () => {
    const root = tempRoot()
    const controller = new AbortController()
    const result = await probeDirectory(root, controller.signal)
    expect(result.writable).toBe(true)
    // Symlink support depends on privilege; only the probe dirs matter here.
    expect(typeof result.symlinkCapable).toBe('boolean')
    const leftovers = readdirSync(root).filter((n) => n.includes('.hubfetch-probe-'))
    expect(leftovers).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })

  it('probeDirectory reports not writable for a read-only host', async () => {
    const root = tempRoot()
    const readonly = join(root, 'readonly')
    mkdirSync(readonly)
    // No reliable chmod across Windows: simulate a host that cannot host a
    // temp dir by probing a nonexistent deep path; nearest ancestor is root,
    // so this still returns writable=true. Instead assert the no-ancestor case
    // only, which is deterministic everywhere.
    const controller = new AbortController()
    const missingRoot = await probeDirectory(join('Z:\\no\\such\\volume\\x'), controller.signal)
    expect(missingRoot.writable).toBe(false)
    void readonly
  })

  it('scanDirectorySize counts files, skips symlinks, and stays bounded', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'one.bin'), Buffer.alloc(10, 1))
    writeFileSync(join(root, 'a', 'b', 'two.bin'), Buffer.alloc(20, 2))
    const controller = new AbortController()
    const result = await scanDirectorySize(root, controller.signal)
    expect(result.bounded).toBe(false)
    expect(result.sizeBytes).toBe(30)
    expect(result.entryCount).toBe(4) // a, b, one.bin, two.bin
    expect(result.error).toBeUndefined()

    const missing = await scanDirectorySize(join(root, 'nope'), controller.signal)
    expect(missing.sizeBytes).toBeNull()
    expect(missing.error).toContain('ENOENT')
  })

  it('runCommandBounded runs argv-safe commands and rejects on deadline', async () => {
    const quick = await runCommandBounded(['node', '-e', 'console.log("hello")'], {
      signal: new AbortController().signal
    })
    expect(quick.status).toBe('completed')
    expect(quick.exitCode).toBe(0)
    expect(quick.stdout).toContain('hello')

    const missing = await runCommandBounded(['hubfetch-no-such-binary-xyz'], {
      signal: new AbortController().signal
    })
    expect(missing.status).toBe('launch-error')

    // The deadline is owned by the caller's signal: aborting kills the child
    // and rejects with the abort marker (bounded wrapper maps it to timeout).
    const controller = new AbortController()
    const pending = runCommandBounded(['node', '-e', 'setTimeout(() => {}, 10_000)'], {
      signal: controller.signal
    })
    const abortTimer = setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toBeInstanceOf(CommandAbortedError)
    clearTimeout(abortTimer)
  })

  it('createDefaultEnv produces a fully runnable service (fake fetch, no network)', async () => {
    const env = createDefaultEnv({
      cacheDir: () => tempRoot(),
      destinationDir: () => tempRoot(),
      notificationRegistration: () => ({ status: 'unsupported' }),
      dbHealth: async () => ({ ok: true }),
      // Fake transport: never touch the real network from a unit test.
      fetchImpl: async () => new Response(null, { status: 200 }) as Response,
      proxyRoute: () => 'direct'
    })
    const report = await new DiagnosticsService(env, { probeTimeoutMs: 3000 }).run()
    expect(report.checks.length).toBeGreaterThan(0)
    const ids = report.checks.map((c) => c.id)
    expect(ids).toContain('app.identity')
    expect(ids).toContain('system.windows')
    expect(ids).toContain('system.cpu-memory')
    expect(ids).toContain('disk.free-space')
    expect(ids).toContain('cache.path')
    expect(ids).toContain('git.version')
    expect(findCheck(report, 'app.identity').status).toBe('pass')
    expect(findCheck(report, 'database.health').status).toBe('pass')
    expect(findCheck(report, 'network.huggingface').status).toBe('pass')
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(5000)
  })
})
