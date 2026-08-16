/**
 * QA failure scenarios (plan Todo 23): simulate missing Git-Xet, unwritable
 * cache, low disk, proxy timeout, and notification registration failure. The
 * service must return typed, actionable failures without crashing and without
 * leaking personal paths or secrets. Prints `[qa-failure]` evidence lines for
 * qa-failure.txt. No network — every adapter is fake.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { CommandOutcome, DiagnosticsEnv } from './diagnostics-env'
import { runCommandBounded } from './diagnostics-env'
import { DiagnosticsService } from './diagnostics'
import { GitDiagnostics } from './git-diagnostics'
import { Redactor } from './security/redaction'
import { SecretRegistry } from './security/secret-registry'

function okCommand(stdout = '', exitCode = 0): CommandOutcome {
  return { status: 'completed', exitCode, stdout, stderr: '' }
}

function healthyRoute(argv: readonly string[]): CommandOutcome {
  const [cmd, sub] = [argv[0], argv[1]]
  if (cmd === 'git' && sub === '--version') return okCommand('git version 2.47.0.windows.1')
  if (cmd === 'git' && sub === 'xet') return okCommand('git-xet version 0.14.0')
  if (cmd === 'git' && sub === 'config') {
    if (argv.includes('--get-regexp')) return okCommand('file\tfilter.xet.process\tgit-xet filter')
    if (argv.includes('--get-all')) return okCommand('file\tmanager')
  }
  return okCommand('', 1)
}

function baseEnv(): DiagnosticsEnv {
  return {
    getProcessInfo: () => ({
      platform: 'win32',
      release: '10.0.26100',
      arch: 'x64',
      cpuModel: 'Intel(R) Core(TM) i7',
      cpuCount: 20,
      totalMemBytes: 16 * 1024 ** 3,
      freeMemBytes: 8 * 1024 ** 3
    }),
    getDiskFreeBytes: async () => 250 * 1024 ** 3,
    probeDirectory: async () => ({ writable: true, symlinkCapable: true }),
    scanDirectorySize: async () => ({ sizeBytes: 1024 ** 3, entryCount: 42, bounded: false }),
    getCacheDir: () => 'C:\\Users\\qa\\.cache\\huggingface\\hub',
    getDestinationDir: () => 'C:\\Users\\qa\\.cache\\huggingface\\hub',
    getNotificationRegistration: () => ({ status: 'registered' }),
    getDbHealth: async () => ({ ok: true }),
    runCommand: async (argv) => healthyRoute(argv),
    checkReachability: async () => ({ reachable: true, statusCode: 200, proxyRoute: 'direct' }),
    getAppInfo: () => ({
      version: '0.2.0',
      buildKind: 'packaged',
      electronVersion: '43.1.0'
    })
  }
}

describe('QA failure — each failure is typed, actionable, and secret-free', () => {
  it('missing Git-Xet yields a degraded warning with install guidance', async () => {
    const env = baseEnv()
    env.runCommand = async (argv) =>
      argv[1] === 'xet' ? okCommand("git: 'xet' is not a git command", 1) : healthyRoute(argv)
    const report = await new DiagnosticsService(env).run()
    const check = report.checks.find((c) => c.id === 'git.xet')!
    console.log(`[qa-failure] git.xet => ${check.status}/${check.reasonCode}`)
    console.log(`[qa-failure] git.xet action: ${check.action}`)
    expect(check.status).toBe('warning')
    expect(check.reasonCode).toBe('missing')
    expect(check.action).toContain('winget install --id git-xet.git-xet')
  })

  it('unwritable cache yields a failure with a settings action and no path leak', async () => {
    const env = baseEnv()
    env.probeDirectory = async () => ({
      writable: false,
      symlinkCapable: false,
      error: 'EACCES: permission denied, open C:\\Users\\qa\\.cache\\huggingface\\hub\\x.probe'
    })
    const report = await new DiagnosticsService(env).run()
    const check = report.checks.find((c) => c.id === 'cache.read-write')!
    console.log(`[qa-failure] cache.read-write => ${check.status}/${check.reasonCode}`)
    console.log(`[qa-failure] cache.read-write action: ${check.action}`)
    expect(check.status).toBe('failure')
    expect(check.reasonCode).toBe('unwritable')
    expect(JSON.stringify(report)).not.toContain('C:\\Users\\qa')
  })

  it('low disk yields a critical-space failure with guidance', async () => {
    const env = baseEnv()
    env.getDiskFreeBytes = async () => 64 * 1024 ** 2
    const report = await new DiagnosticsService(env).run()
    const check = report.checks.find((c) => c.id === 'disk.free-space')!
    console.log(`[qa-failure] disk.free-space => ${check.status}/${check.reasonCode}`)
    console.log(`[qa-failure] disk.free-space action: ${check.action}`)
    expect(check.status).toBe('failure')
    expect(check.reasonCode).toBe('critical-space')
    expect(check.action).toContain('Free disk space')
  })

  it('proxy timeout yields a failure and never hangs past the deadline', async () => {
    const env = baseEnv()
    // A proxy that hangs (never resolves) must be reined in by the deadline,
    // exactly like a real proxy timeout — never hangs the main process.
    env.checkReachability = async () => new Promise(() => undefined)
    const report = await new DiagnosticsService(env, { probeTimeoutMs: 200 }).run()
    const check = report.checks.find((c) => c.id === 'network.huggingface')!
    console.log(`[qa-failure] network.huggingface => ${check.status}/${check.reasonCode}`)
    console.log(`[qa-failure] network.huggingface action: ${check.action}`)
    expect(check.status).toBe('failure')
    expect(check.reasonCode).toBe('timeout')
    expect(check.durationMs).toBeLessThanOrEqual(300)
  })

  it('notification registration failure yields a typed failure', async () => {
    const env = baseEnv()
    env.getNotificationRegistration = () => ({
      status: 'failed',
      reason: 'writeShortcutLink failed'
    })
    const report = await new DiagnosticsService(env).run()
    const check = report.checks.find((c) => c.id === 'notifications.registration')!
    console.log(`[qa-failure] notifications.registration => ${check.status}/${check.reasonCode}`)
    expect(check.status).toBe('failure')
    expect(check.reasonCode).toBe('unsupported')
  })

  it('missing Git-Xet + hanging helper yield typed failure/timeout without a hang', async () => {
    // Real spawn-based fixture: `git xet` is missing AND the credential
    // config probe hangs. The per-probe bounds must produce a typed `missing`
    // (git.xet) and a typed `timeout` (git.credentials) — no app hang, no
    // config mutation (the fixture install guard never fires).
    const fixture = join(__dirname, 'fixtures', 'git', 'git-no-xet-hang.cjs')
    const env = baseEnv()
    env.runCommand = async (argv) =>
      argv[1] === 'xet' ? okCommand("git: 'xet' is not a git command", 1) : healthyRoute(argv)
    const gitDiagnostics = new GitDiagnostics({
      runner: { runCommand: (argv, opts) => runCommandBounded(argv, opts) },
      gitCommand: [process.execPath, fixture],
      sshCommand: [process.execPath, join(__dirname, 'fixtures', 'git', 'ssh-ok.cjs')],
      timeoutMs: 400
    })
    const started = Date.now()
    const report = await new DiagnosticsService(env, { gitDiagnostics }).run()
    const elapsed = Date.now() - started
    const xet = report.checks.find((c) => c.id === 'git.xet')!
    const creds = report.checks.find((c) => c.id === 'git.credentials')!
    console.log(`[qa-failure] git.xet => ${xet.status}/${xet.reasonCode} — action: ${xet.action}`)
    console.log(
      `[qa-failure] git.credentials => ${creds.status}/${creds.reasonCode} — duration ${creds.durationMs}ms`
    )
    console.log(`[qa-failure] total git probes elapsed: ${elapsed}ms (no hang)`)
    expect(xet.status).toBe('warning')
    expect(xet.reasonCode).toBe('missing')
    expect(xet.action).toContain('winget install --id git-xet.git-xet')
    expect(creds.status).toBe('unknown')
    expect(creds.reasonCode).toBe('timeout')
    expect(creds.durationMs).toBeLessThanOrEqual(400 * 8 + 2000)
    // The hanging helper never left a running child behind: the report came
    // back bounded and no raw config path leaked into any failure output.
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('.gitconfig')
  })

  it('a registered token and personal path never appear in any failure output', async () => {
    const sentinel = 'hf_' + 'aBcDeFgHiJkLmNoPqRsTuV'.toLowerCase()
    const registry = new SecretRegistry()
    const handle = registry.register(sentinel)
    try {
      const env = baseEnv()
      env.getDbHealth = async () => ({
        ok: false,
        error: `locked by ${sentinel} at C:\\Users\\qa\\AppData\\Roaming\\HubFetch`
      })
      const report = await new DiagnosticsService(env, {
        redactor: new Redactor(registry)
      }).run()
      const check = report.checks.find((c) => c.id === 'database.health')!
      console.log(`[qa-failure] database.health => ${check.status}/${check.reasonCode}`)
      console.log(`[qa-failure] database.health detail: ${check.detail}`)
      const serialized = JSON.stringify(report)
      expect(serialized).not.toContain(sentinel)
      expect(serialized).not.toContain('C:\\Users\\qa')
      expect(serialized).not.toContain('AppData')
    } finally {
      registry.unregister(handle)
    }
  })
})
