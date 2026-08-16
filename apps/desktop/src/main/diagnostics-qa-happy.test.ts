/**
 * QA happy path (plan Todo 23): run the DiagnosticsService against controlled
 * fixtures where every dependency is healthy and validate the bounded, ordered
 * results. Prints `[qa-happy]` evidence lines for qa-happy.txt. No network —
 * the reachability probe uses a fake fetch.
 */
import { describe, expect, it } from 'vitest'
import type {
  AppInfoSnapshot,
  CommandOutcome,
  DiagnosticsEnv,
  ProcessInfo
} from './diagnostics-env'
import { DiagnosticsService, DEFAULT_PROBE_TIMEOUT_MS } from './diagnostics'

const PROCESS_INFO: ProcessInfo = {
  platform: 'win32',
  release: '10.0.26100',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) i7-14700',
  cpuCount: 20,
  totalMemBytes: 16 * 1024 ** 3,
  freeMemBytes: 8 * 1024 ** 3
}

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

describe('QA happy — every dependency healthy', () => {
  it('returns a bounded, ordered, all-pass report with no secrets or paths', async () => {
    const report = await new DiagnosticsService(healthyEnv()).run()
    console.log('[qa-happy] report.completedAt:', report.completedAt)
    console.log(
      `[qa-happy] report.checks: ${report.checks.length} (expected 14) — ordered ${report.checks
        .map((c) => c.id)
        .join(', ')}`
    )
    let maxDuration = 0
    for (const check of report.checks) {
      maxDuration = Math.max(maxDuration, check.durationMs)
      console.log(
        `[qa-happy] ${check.id} => ${check.status}/${check.reasonCode} (${check.durationMs}ms) — ${check.message}`
      )
      if (check.detail) console.log(`[qa-happy]   detail: ${check.detail}`)
      if (check.action) console.log(`[qa-happy]   action: ${check.action}`)
    }
    console.log(
      `[qa-happy] max probe duration: ${maxDuration}ms <= ${DEFAULT_PROBE_TIMEOUT_MS}ms deadline`
    )
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('C:\\Users\\qa')
    expect(serialized).not.toContain('AppData')
    expect(report.checks).toHaveLength(14)
    for (const check of report.checks) {
      expect(['pass', 'warning', 'failure', 'unknown']).toContain(check.status)
      expect(check.durationMs).toBeLessThanOrEqual(DEFAULT_PROBE_TIMEOUT_MS)
    }
    // Happy path: every probe reports pass.
    for (const check of report.checks) {
      expect(check.status, `${check.id} should pass on healthy fixtures`).toBe('pass')
    }
  })
})
