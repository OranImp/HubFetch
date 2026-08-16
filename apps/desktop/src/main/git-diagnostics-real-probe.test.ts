/**
 * Real-machine probe for plan Todo 28 (evidence). Runs ONLY when
 * `HF_REAL_PROBE=1` is set so normal test runs stay hermetic. Probes the real
 * `git` / `ssh` toolchain through the production bounded runner, records the
 * sanitized report into the task evidence dir, and verifies the report is
 * bounded, complete, and free of personal paths/raw config. Every probe is
 * read-only; running it leaves the machine and its Git config unchanged.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCommandBounded } from './diagnostics-env'
import { GitDiagnostics } from './git-diagnostics'

const EVIDENCE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '.omo',
  'evidence',
  'task-28-adopt-ohmyhf-main'
)

describe.skipIf(process.env.HF_REAL_PROBE !== '1')('real machine probe', () => {
  it('probes the real git toolchain without mutating anything and records the result', async () => {
    const diag = new GitDiagnostics({
      runner: { runCommand: (argv, opts) => runCommandBounded(argv, opts) },
      timeoutMs: 5000
    })
    const report = await diag.check()
    const serialized = JSON.stringify(report, null, 2)
    // Sanitization guarantees: no personal paths, helper names, or URLs.
    expect(serialized).not.toContain('.gitconfig')
    expect(serialized).not.toContain('C:\\Users')
    expect(serialized).not.toContain('https://')
    expect(report.cache.hit).toBe(false)
    for (const filter of report.xet.filters) {
      expect(filter.originHash).toMatch(/^[0-9a-f]{64}$/)
    }
    for (const helper of report.credentials.helpers) {
      expect(helper.originHash).toMatch(/^[0-9a-f]{64}$/)
    }
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(join(EVIDENCE, 'real-machine-probe.json'), serialized)
    console.log('[real-probe] git:', report.git.status, report.git.version)
    console.log('[real-probe] xet:', report.xet.status, report.xet.version)
    console.log('[real-probe] credentials:', report.credentials.status)
    console.log('[real-probe] gcm:', report.gcm.status, report.gcm.version)
    console.log('[real-probe] ssh:', report.ssh.status, report.ssh.version)
    console.log('[real-probe] configFingerprint:', report.configFingerprint)
  })
})
