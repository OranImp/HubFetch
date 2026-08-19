/**
 * DiagnosticsCoordinator shared-GitDiagnostics test (plan Todo 4).
 *
 * The coordinator and CloneManager share ONE `GitDiagnostics` instance.
 * `run()` must `invalidate()` it before probing so a Recheck never reports a
 * pre-run cache hit: a counting fake runner proves the git probes re-execute
 * after `run()` even while the pre-run snapshot is still inside the 2s TTL,
 * and that the service used the injected instance (not `env.runCommand`).
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@hubfetch/shared'
import type { AppSettings, DownloadTask } from '@hubfetch/shared'
import { DiagnosticsCoordinator } from './diagnostics-coordinator'
import type {
  AppInfoSnapshot,
  CommandOutcome,
  DiagnosticsEnv,
  DirectoryProbeOutcome,
  DirectorySizeOutcome,
  ProcessInfo,
  ReachabilityOutcome
} from './diagnostics-env'
import { GitDiagnostics } from './git-diagnostics'

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

/** Healthy git/ssh command router (same shapes as diagnostics.test.ts). */
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

function healthyEnv(envCommands: string[][] = []): DiagnosticsEnv {
  return {
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
    runCommand: async (argv) => {
      envCommands.push([...argv])
      return okCommand()
    },
    checkReachability: async (): Promise<ReachabilityOutcome> => ({
      reachable: true,
      statusCode: 200,
      proxyRoute: 'direct'
    }),
    getAppInfo: () => APP_INFO
  }
}

function makeCoordinator(gitDiagnostics: GitDiagnostics, envCommands: string[][]) {
  const broadcast = vi.fn()
  const coordinator = new DiagnosticsCoordinator({
    envFactory: () => healthyEnv(envCommands),
    settings: (): AppSettings => DEFAULT_SETTINGS,
    tasks: (): DownloadTask[] => [],
    logReader: () => ({ main: '', renderer: '' }),
    broadcast,
    gitDiagnostics
  })
  return { coordinator, broadcast }
}

describe('DiagnosticsCoordinator shared GitDiagnostics (plan Todo 4)', () => {
  it('serves the brief cache between checks: first check misses, immediate second hits', async () => {
    let calls = 0
    const gitDiagnostics = new GitDiagnostics({
      runner: {
        runCommand: async (argv) => {
          calls += 1
          return routeCommand(argv)
        }
      }
    })

    const first = await gitDiagnostics.check()
    expect(first.cache.hit).toBe(false)
    expect(first.git.status).toBe('installed')
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)

    const second = await gitDiagnostics.check()
    expect(second.cache.hit).toBe(true)
    expect(calls).toBe(afterFirst) // cache hit: no re-probe
  })

  it('run() invalidates the shared probe so the next check is not a pre-run cache hit', async () => {
    let calls = 0
    const gitDiagnostics = new GitDiagnostics({
      runner: {
        runCommand: async (argv) => {
          calls += 1
          return routeCommand(argv)
        }
      }
    })
    const envCommands: string[][] = []
    const { coordinator, broadcast } = makeCoordinator(gitDiagnostics, envCommands)

    // Prime the shared cache — the snapshot CloneManager's start gate would see.
    const primed = await gitDiagnostics.check()
    expect(primed.cache.hit).toBe(false)
    const primedCalls = calls
    expect(primedCalls).toBeGreaterThan(0)

    // A second immediate check hits the pre-run cache (no runner traffic).
    const cached = await gitDiagnostics.check()
    expect(cached.cache.hit).toBe(true)
    expect(calls).toBe(primedCalls)

    // run() must invalidate: the git probes re-execute the shared runner even
    // though the pre-run snapshot is still inside the 2s TTL. Without the
    // invalidate() this count would stay at primedCalls.
    const report = await coordinator.run()
    expect(calls).toBeGreaterThan(primedCalls)

    // The run used the injected shared instance, not env.runCommand: no
    // git/ssh argv ever reached the env during the run.
    expect(envCommands.some((argv) => argv[0] === 'git' || argv[0] === 'ssh')).toBe(false)

    // The report carries the git checks and progress was broadcast.
    expect(report.checks.some((c) => c.id === 'git.version')).toBe(true)
    expect(report.checks.some((c) => c.id === 'git.xet')).toBe(true)
    expect(broadcast).toHaveBeenCalled()

    // The post-run cache is the fresh snapshot: a further check hits it
    // without re-probing.
    const callsAfterRun = calls
    const afterRun = await gitDiagnostics.check()
    expect(afterRun.cache.hit).toBe(true)
    expect(afterRun.git.status).toBe('installed')
    expect(calls).toBe(callsAfterRun)
  })
})
