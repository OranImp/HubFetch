/**
 * GitDiagnostics service test suite (plan Todo 28).
 *
 * Every probe runs through real `spawn`-based fixture executables
 * (`shell: false`, no shell anywhere), plus one fake-runner case for an
 * execution-denied launch. Fixtures cover supported / missing / malformed /
 * timeout / old versions and filter/helper combinations. Assertions guarantee:
 * read-only argv only (no mutation verb), bounded probes (a hanging child is
 * killed and typed), hashed-only config fields (no raw origin/path/helper
 * value survives into the report), a brief cache by fingerprint with explicit
 * invalidation, and a real `git xet version` fallback when the spaced form is
 * rejected.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { CommandOutcome } from './diagnostics-env'
import { runCommandBounded } from './diagnostics-env'
import { GitDiagnostics, DEFAULT_TIMEOUT_MS } from './git-diagnostics'
import type { GitDiagnosticsOptions } from './git-diagnostics'

const FIXTURES = join(__dirname, 'fixtures', 'git')

function makeGitDiagnostics(
  fixtureName: string,
  overrides: Partial<GitDiagnosticsOptions> = {}
): GitDiagnostics {
  const fixture = join(FIXTURES, fixtureName)
  return new GitDiagnostics({
    runner: { runCommand: (argv, opts) => runCommandBounded(argv, opts) },
    gitCommand: [process.execPath, fixture],
    sshCommand: [process.execPath, join(FIXTURES, 'ssh-ok.cjs')],
    timeoutMs: 1000,
    ...overrides
  })
}

function okCommand(stdout = '', exitCode = 0): CommandOutcome {
  return { status: 'completed', exitCode, stdout, stderr: '' }
}

describe('semver extraction and comparison', () => {
  it('extracts a semver token from git/git-xet version lines', async () => {
    const report = await makeGitDiagnostics('git-ok.cjs').check()
    expect(report.git.version).toBe('2.47.0')
    expect(report.xet.version).toBe('0.14.0')
    expect(report.gcm.version).toBe('2.5.1')
    expect(report.ssh.version).toContain('9.8')
  })

  it('treats a malformed version string as an unparseable (null) version', async () => {
    const report = await makeGitDiagnostics('git-malformed.cjs').check()
    expect(report.git.status).toBe('installed')
    expect(report.git.version).toBeNull()
    expect(report.xet.status).toBe('configured')
    expect(report.xet.version).toBeNull()
  })
})

describe('fixture executables cover supported/missing/old/timeout states', () => {
  it('reports every dependency ready for the healthy fixture', async () => {
    const report = await makeGitDiagnostics('git-ok.cjs').check()
    expect(report.git).toEqual({ status: 'installed', version: '2.47.0' })
    expect(report.xet.status).toBe('configured')
    expect(report.xet.filterCount).toBe(2)
    expect(report.credentials.status).toBe('configured')
    expect(report.credentials.helperCount).toBe(2)
    expect(report.credentials.hasGcm).toBe(true)
    expect(report.gcm.status).toBe('available')
    expect(report.ssh.status).toBe('available')
  })

  it('reports a missing git binary as missing and skips dependent probes', async () => {
    const report = await makeGitDiagnostics('git-ok.cjs', {
      gitCommand: ['hubfetch-no-such-git-xyz']
    }).check()
    expect(report.git.status).toBe('missing')
    expect(report.xet.status).toBe('unknown')
    expect(report.credentials.status).toBe('unknown')
    expect(report.gcm.status).toBe('unknown')
    // SSH is an independent binary and is still probed.
    expect(report.ssh.status).toBe('available')
  })

  it('reports missing git xet (not a git command) as missing', async () => {
    const report = await makeGitDiagnostics('git-no-xet.cjs').check()
    expect(report.git.status).toBe('installed')
    expect(report.xet.status).toBe('missing')
    expect(report.xet.filterCount).toBe(0)
    expect(report.gcm.status).toBe('missing')
    expect(report.credentials.status).toBe('configured')
  })

  it('reports an installed-but-unconfigured git xet as uninitialized', async () => {
    const report = await makeGitDiagnostics('git-xet-no-filter.cjs').check()
    expect(report.xet.status).toBe('uninitialized')
    expect(report.xet.version).toBe('0.14.0')
  })

  it('reports an old git xet version as outdated', async () => {
    const report = await makeGitDiagnostics('git-old-xet.cjs').check()
    expect(report.xet.status).toBe('old')
    expect(report.xet.version).toBe('0.0.5')
  })

  it('reports HF-fork git-xet 0.2.1 with filters as configured', async () => {
    const report = await new GitDiagnostics({
      runner: {
        runCommand: async (argv, opts) => {
          if (argv.includes('xet') && (argv.at(-1) === 'version' || argv.at(-1) === '--version')) {
            return okCommand('git-xet version 0.2.1')
          }
          return runCommandBounded(argv, opts)
        }
      },
      gitCommand: [process.execPath, join(FIXTURES, 'git-ok.cjs')],
      sshCommand: [process.execPath, join(FIXTURES, 'ssh-ok.cjs')],
      timeoutMs: 1000
    }).check()
    expect(report.xet.status).toBe('configured')
    expect(report.xet.version).toBe('0.2.1')
  })

  it('uses the `git xet --version` fallback when `git xet version` is rejected', async () => {
    // The healthy fixture answers both forms; route via a fake runner that
    // rejects only the spaced form and confirm the fallback is used.
    let argv0 = true
    const report = await new GitDiagnostics({
      runner: {
        runCommand: async (argv) => {
          if (argv[1] === 'xet' && argv[2] === 'version' && argv0) {
            argv0 = false
            return okCommand("git: 'xet' is not a git command", 1)
          }
          return runCommandBounded(argv, { signal: new AbortController().signal })
        }
      },
      gitCommand: [process.execPath, join(FIXTURES, 'git-ok.cjs')],
      sshCommand: [process.execPath, join(FIXTURES, 'ssh-ok.cjs')],
      timeoutMs: 1000
    }).check()
    expect(report.xet.status).toBe('configured')
    expect(report.xet.version).toBe('0.14.0')
  })

  it('classifies a hanging `git xet version` probe as a typed timeout', async () => {
    const report = await makeGitDiagnostics('git-hang-xet.cjs', { timeoutMs: 400 }).check()
    expect(report.git.status).toBe('installed')
    expect(report.xet.status).toBe('timeout')
  })
})

describe('credential helper combinations', () => {
  it('flags a plaintext store helper', async () => {
    const report = await makeGitDiagnostics('git-plaintext.cjs').check()
    expect(report.credentials.status).toBe('plaintext')
    expect(report.credentials.hasGcm).toBe(false)
    expect(report.credentials.helpers.map((h) => h.kind)).toEqual(['store'])
  })

  it('reports no helper configured', async () => {
    const report = await makeGitDiagnostics('git-no-helper.cjs').check()
    expect(report.credentials.status).toBe('none')
    expect(report.credentials.helperCount).toBe(0)
  })

  it('keeps credentials configured while GCM binary is absent (non-fatal)', async () => {
    const report = await makeGitDiagnostics('git-no-gcm.cjs').check()
    expect(report.credentials.status).toBe('configured')
    expect(report.credentials.hasGcm).toBe(true)
    expect(report.gcm.status).toBe('missing')
  })

  it('uses the `git credential-manager --version` fallback when `version` is rejected', async () => {
    const report = await new GitDiagnostics({
      runner: {
        runCommand: async (argv, opts) => {
          if (argv.includes('credential-manager') && argv.at(-1) === 'version') {
            return okCommand("'version' was not matched. Did you mean --version?", 1)
          }
          if (argv.includes('credential-manager') && argv.at(-1) === '--version') {
            return okCommand('Git Credential Manager version 2.7.3+b77d0db269')
          }
          return runCommandBounded(argv, opts)
        }
      },
      gitCommand: [process.execPath, join(FIXTURES, 'git-ok.cjs')],
      sshCommand: [process.execPath, join(FIXTURES, 'ssh-ok.cjs')],
      timeoutMs: 1000
    }).check()
    expect(report.gcm.status).toBe('available')
    expect(report.gcm.version).toBe('2.7.3')
  })

  it('reports GCM as nonzero when both version forms fail without the missing marker', async () => {
    const report = await new GitDiagnostics({
      runner: {
        runCommand: async (argv, opts) => {
          if (argv.includes('credential-manager')) {
            return okCommand("'version' was not matched. Did you mean --version?", 1)
          }
          return runCommandBounded(argv, opts)
        }
      },
      gitCommand: [process.execPath, join(FIXTURES, 'git-ok.cjs')],
      sshCommand: [process.execPath, join(FIXTURES, 'ssh-ok.cjs')],
      timeoutMs: 1000
    }).check()
    expect(report.gcm.status).toBe('nonzero')
  })

  it('classifies a hanging credential config probe as a typed timeout', async () => {
    const report = await makeGitDiagnostics('git-hang.cjs', { timeoutMs: 400 }).check()
    expect(report.git.status).toBe('installed')
    expect(report.xet.status).toBe('configured')
    expect(report.credentials.status).toBe('timeout')
  })
})

describe('execution denied classification', () => {
  it('distinguishes EACCES (denied) from ENOENT (missing)', async () => {
    const denied = await new GitDiagnostics({
      runner: {
        runCommand: async () => ({
          status: 'launch-error',
          exitCode: null,
          stdout: '',
          stderr: '',
          errorCode: 'EACCES'
        })
      },
      sshCommand: [process.execPath, join(FIXTURES, 'ssh-ok.cjs')]
    }).check()
    expect(denied.git.status).toBe('denied')
  })
})

describe('no mutation verbs in probe argv', () => {
  it('runs only the read-only probe command set', async () => {
    const argvSeen: string[][] = []
    const diag = makeGitDiagnostics('git-ok.cjs', {
      runner: {
        runCommand: async (argv, opts) => {
          argvSeen.push([...argv])
          return runCommandBounded(argv, opts)
        }
      }
    })
    await diag.check()
    const allowed = [
      ['--version'],
      ['xet', 'version'],
      ['xet', '--version'],
      ['config', '--show-origin', '--get-regexp', '^filter\\.xet\\.'],
      ['config', '--show-origin', '--get-all', 'credential.helper'],
      ['credential-manager', 'version'],
      ['-V']
    ]
    for (const argv of argvSeen) {
      const matchesSuffix = allowed.some(
        (suffix) =>
          suffix.length <= argv.length &&
          suffix.every((part, i) => argv[argv.length - suffix.length + i] === part)
      )
      expect(matchesSuffix, JSON.stringify(argv)).toBe(true)
      for (const banned of ['install', '--add', 'write', 'push', 'update-ref']) {
        expect(argv).not.toContain(banned)
      }
    }
    // The fixture's mutation guard never fires.
    expect(argvSeen.some((argv) => argv.includes('install'))).toBe(false)
  })
})

describe('redaction: raw config output and paths never leave the service', () => {
  it('persists only hashed/sanitized config fields in the report', async () => {
    const report = await makeGitDiagnostics('git-ok.cjs').check()
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('.gitconfig')
    expect(serialized).not.toContain('Program Files')
    expect(serialized).not.toContain('C:/')
    expect(serialized).not.toContain('C:\\')
    // Filter origins are SHA-256 hex hashes only.
    for (const filter of report.xet.filters) {
      expect(filter.originHash).toMatch(/^[0-9a-f]{64}$/)
      expect(filter.keyHash).toMatch(/^[0-9a-f]{64}$/)
      expect(filter.valueHash).toMatch(/^[0-9a-f]{64}$/)
      expect(['local', 'global', 'system', 'command', 'worktree', 'unknown']).toContain(
        filter.originScope
      )
    }
    for (const helper of report.credentials.helpers) {
      expect(helper.originHash).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(report.configFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('brief cache by fingerprint with explicit invalidation', () => {
  it('serves the second check from cache and invalidates on demand', async () => {
    let runs = 0
    const diag = makeGitDiagnostics('git-ok.cjs', {
      runner: {
        runCommand: async (argv, opts) => {
          runs += 1
          return runCommandBounded(argv, opts)
        }
      }
    })
    const first = await diag.check()
    expect(first.cache.hit).toBe(false)
    const second = await diag.check()
    expect(second.cache.hit).toBe(true)
    // git --version, xet version, filter config, helper config, gcm version, ssh -V.
    expect(runs).toBe(6)
    diag.invalidate()
    const third = await diag.check()
    expect(third.cache.hit).toBe(false)
    expect(runs).toBe(12)
  })
})

describe('boundedness of the whole check', () => {
  it('never exceeds the per-probe deadline even with a hanging child', async () => {
    const started = Date.now()
    const report = await makeGitDiagnostics('git-hang.cjs', { timeoutMs: 300 }).check()
    const elapsed = Date.now() - started
    expect(report.credentials.status).toBe('timeout')
    // 7 probes max, each bounded at 300ms, plus fixture spawn overhead.
    expect(elapsed).toBeLessThan(300 * 7 + 2000)
  })
})

describe('defaults', () => {
  it('exposes a conservative default timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(5000)
  })
})
