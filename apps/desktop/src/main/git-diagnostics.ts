/**
 * Read-only Git, Git-Xet, filter, and credential readiness assessment
 * (plan Todo 28).
 *
 * Every probe is a bounded subprocess launched with `shell: false` through the
 * injected runner and only *reads*: `git --version`, `git xet version` (with
 * `git xet --version` as the supported fallback), `git config --show-origin`
 * for the effective `filter.xet.*` and `credential.helper` configuration,
 * `git credential-manager version`, and `ssh -V`. No command here can mutate
 * configuration and the service never runs `git xet install` or edits any Git
 * config file.
 *
 * Raw config output never leaves the service: filter keys/values and
 * credential-helper origins are sanitized (personal paths collapsed) and then
 * stored as SHA-256 hashes with a coarse origin scope only, so the report
 * never carries a config path, helper path, username, or URL. Probe results
 * are cached briefly (keyed by an executable/probe fingerprint) and can be
 * invalidated explicitly for a user-initiated Recheck.
 */
import { createHash } from 'node:crypto'
import type { CommandOutcome } from './diagnostics-env'
import { sanitizePathText } from './diagnostics-env'

export type GitProbeStatus = 'installed' | 'missing' | 'timeout' | 'nonzero' | 'denied'

export type XetProbeStatus =
  'configured' | 'uninitialized' | 'missing' | 'old' | 'timeout' | 'nonzero' | 'unknown'

export type CredentialProbeStatus = 'configured' | 'none' | 'plaintext' | 'timeout' | 'unknown'

export type ToolAvailability =
  'available' | 'missing' | 'timeout' | 'nonzero' | 'denied' | 'unknown'

export type ConfigOriginScope = 'local' | 'global' | 'system' | 'command' | 'worktree' | 'unknown'

export type HelperKind = 'gcm' | 'store' | 'cache' | 'custom' | 'unknown'

/** One hashed `filter.xet.*` entry; no raw text survives into the report. */
export interface FilterEntry {
  keyHash: string
  valueHash: string
  originHash: string
  originScope: ConfigOriginScope
}

/** One hashed credential helper entry; the helper name is never persisted. */
export interface HelperEntry {
  kind: HelperKind
  originHash: string
  originScope: ConfigOriginScope
}

export interface GitProbeResult {
  status: GitProbeStatus
  version: string | null
}

export interface XetProbeResult {
  status: XetProbeStatus
  version: string | null
  filterCount: number
  filters: FilterEntry[]
}

export interface CredentialProbeResult {
  status: CredentialProbeStatus
  helperCount: number
  hasGcm: boolean
  helpers: HelperEntry[]
}

export interface ToolProbeResult {
  status: ToolAvailability
  version: string | null
}

export interface GitDiagnosticsReport {
  git: GitProbeResult
  xet: XetProbeResult
  credentials: CredentialProbeResult
  gcm: ToolProbeResult
  ssh: ToolProbeResult
  /** SHA-256 over the sanitized, allowlisted filter/helper config state. */
  configFingerprint: string
  cache: { hit: boolean; fingerprint: string }
}

/** Shell-free argv-safe command seam (the Todo 23 `runCommand` adapter fits). */
export interface GitDiagnosticsRunner {
  runCommand(argv: readonly string[], opts: { signal: AbortSignal }): Promise<CommandOutcome>
}

export interface GitDiagnosticsOptions {
  runner: GitDiagnosticsRunner
  /** Executable prefix that behaves like `git` (default `['git']`). */
  gitCommand?: readonly string[]
  /** Executable prefix that behaves like `ssh` (default `['ssh']`). */
  sshCommand?: readonly string[]
  /** Per-probe deadline in milliseconds (default 5000). */
  timeoutMs?: number
  /** Brief result cache lifetime in milliseconds (default 2000). */
  cacheTtlMs?: number
  /** Oldest Git-Xet version still considered supported (default 0.10.0). */
  minXetVersion?: string
}

export const DEFAULT_TIMEOUT_MS = 5_000
export const DEFAULT_CACHE_TTL_MS = 2_000
const DEFAULT_MIN_XET_VERSION = '0.10.0'

/** Bump when the probe set or its parsing changes; participates in the fingerprint. */
const PROBE_VERSION = 1

const SEMVER_PATTERN = /\b\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?\b/
const SSH_VERSION_PATTERN =
  /OpenSSH[_-](?:for[_-][A-Za-z]+[_-])?v?([0-9]+(?:\.[0-9]+)+[a-z]?[0-9]*)/i
const XET_KEY_PATTERN = /^filter\.xet\./
const MISSING_SUBCOMMAND_MARKER = 'not a git command'
const GCM_HELPER_NAMES = new Set(['manager', 'manager-core', 'gcm'])
const PLAINTEXT_HELPER_NAMES = new Set(['store'])
const CACHE_HELPER_NAMES = new Set(['cache'])
const HEX_RE = /^[0-9a-f]{64}$/

export interface ParsedSemver {
  major: number
  minor: number
  patch: number
}

export function parseSemver(text: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(text)
  if (!match) return null
  const parts = match[0].split('.')
  const major = Number(parts[0])
  const minor = Number(parts[1] ?? '0')
  const patch = Number((parts[2] ?? '0').split(/[-.]/)[0] ?? '0')
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null
  return { major, minor, patch }
}

export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1
  }
  return 0
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function combined(outcome: CommandOutcome): string {
  return [outcome.stdout, outcome.stderr].filter(Boolean).join('\n')
}

function extractSemver(text: string): string | null {
  const parsed = parseSemver(text)
  // Normalize to base `major.minor.patch` (e.g. Git-for-Windows reports
  // `2.47.0.windows.1`, which is not a semver suffix).
  return parsed === null ? null : `${parsed.major}.${parsed.minor}.${parsed.patch}`
}

function extractSshVersion(text: string): string | null {
  const match = SSH_VERSION_PATTERN.exec(text)
  return match?.[1] ?? null
}

function classifyLaunchError(outcome: CommandOutcome): 'denied' | 'missing' {
  const code = outcome.errorCode
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  return 'missing'
}

function classifyOriginScope(sanitized: string): ConfigOriginScope {
  if (sanitized.startsWith('command') || sanitized.startsWith('cmdline')) return 'command'
  if (/\.git\/config\.worktree/.test(sanitized) || /worktree/.test(sanitized)) return 'worktree'
  if (/\.git[\\/]config/.test(sanitized)) return 'local'
  if (/\.gitconfig/.test(sanitized) || /\.config[\\/]git[\\/]config/.test(sanitized)) {
    return 'global'
  }
  if (/Program Files|mingw64|etc[\\/]gitconfig|Library/.test(sanitized)) return 'system'
  return 'unknown'
}

function classifyHelperKind(value: string): HelperKind {
  const name = value.trim().toLowerCase()
  if (GCM_HELPER_NAMES.has(name)) return 'gcm'
  if (PLAINTEXT_HELPER_NAMES.has(name)) return 'store'
  if (CACHE_HELPER_NAMES.has(name)) return 'cache'
  return 'custom'
}

/** Sanitize a field, hash it, and classify its origin scope — never raw. */
function hashedEntry(
  origin: string,
  key: string,
  value: string
): { originHash: string; originScope: ConfigOriginScope; keyHash: string; valueHash: string } {
  const originSanitized = sanitizePathText(origin)
  return {
    originHash: sha256(originSanitized),
    originScope: classifyOriginScope(originSanitized),
    keyHash: sha256(sanitizePathText(key)),
    valueHash: sha256(sanitizePathText(value))
  }
}

function parseFilterLines(text: string): FilterEntry[] {
  const entries: FilterEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue
    let origin = ''
    let rest = rawLine
    const tab = rawLine.indexOf('\t')
    if (tab >= 0) {
      origin = rawLine.slice(0, tab)
      rest = rawLine.slice(tab + 1)
    }
    const space = rest.indexOf(' ')
    const key = space >= 0 ? rest.slice(0, space) : rest
    const value = space >= 0 ? rest.slice(space + 1) : ''
    if (!XET_KEY_PATTERN.test(key)) continue
    const hashed = hashedEntry(origin, key, value)
    entries.push({
      keyHash: hashed.keyHash,
      valueHash: hashed.valueHash,
      originHash: hashed.originHash,
      originScope: hashed.originScope
    })
  }
  return entries
}

function parseHelperLines(text: string): HelperEntry[] {
  const helpers: HelperEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue
    let origin = ''
    let value = rawLine
    const tab = rawLine.indexOf('\t')
    if (tab >= 0) {
      origin = rawLine.slice(0, tab)
      value = rawLine.slice(tab + 1)
    }
    helpers.push({
      kind: classifyHelperKind(value),
      originHash: sha256(sanitizePathText(origin)),
      originScope: classifyOriginScope(sanitizePathText(origin))
    })
  }
  return helpers
}

export class GitDiagnostics {
  private readonly runner: GitDiagnosticsRunner
  private readonly gitCommand: readonly string[]
  private readonly sshCommand: readonly string[]
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly minXetVersion: ParsedSemver | null
  private cache: { fingerprint: string; storedAt: number; report: GitDiagnosticsReport } | null =
    null
  private inflight: Promise<GitDiagnosticsReport> | null = null

  constructor(options: GitDiagnosticsOptions) {
    this.runner = options.runner
    this.gitCommand = options.gitCommand ?? ['git']
    this.sshCommand = options.sshCommand ?? ['ssh']
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.minXetVersion = parseSemver(options.minXetVersion ?? DEFAULT_MIN_XET_VERSION)
  }

  get git(): readonly string[] {
    return this.gitCommand
  }

  /** Drop the cached report so the next `check` re-probes the machine. */
  invalidate(): void {
    this.cache = null
  }

  /** Run every probe once (or serve the brief cache) and return a typed report. */
  async check(signal?: AbortSignal): Promise<GitDiagnosticsReport> {
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    const fingerprint = this.fingerprint()
    const cached = this.cache
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      Date.now() - cached.storedAt < this.cacheTtlMs
    ) {
      return { ...cached.report, cache: { hit: true, fingerprint } }
    }
    // Concurrent callers (the DiagnosticsService probes fire sequentially but
    // may outlive the outer probe deadline) share one in-flight probe run.
    if (this.inflight) return this.inflight
    const run = this.runCheck(fingerprint)
    this.inflight = run
    try {
      return await run
    } finally {
      this.inflight = null
    }
  }

  private async runCheck(fingerprint: string): Promise<GitDiagnosticsReport> {
    const git = await this.probeGit()
    let xet: XetProbeResult
    let credentials: CredentialProbeResult
    let gcm: ToolProbeResult
    if (git.status === 'installed') {
      xet = await this.probeXet()
      credentials = await this.probeCredentials()
      gcm = await this.probeGcm()
    } else {
      xet = { status: 'unknown', version: null, filterCount: 0, filters: [] }
      credentials = { status: 'unknown', helperCount: 0, hasGcm: false, helpers: [] }
      gcm = { status: 'unknown', version: null }
    }
    const ssh = await this.probeSsh()
    const report: GitDiagnosticsReport = {
      git,
      xet,
      credentials,
      gcm,
      ssh,
      configFingerprint: sha256(JSON.stringify([xet.filters, credentials.helpers])),
      cache: { hit: false, fingerprint }
    }
    this.cache = { fingerprint, storedAt: Date.now(), report }
    return report
  }

  private fingerprint(): string {
    return sha256(JSON.stringify([this.gitCommand, this.sshCommand, PROBE_VERSION]))
  }

  /**
   * Run one probe under its own deadline. The child is killed on the internal
   * timer so a hanging binary can never outlive the bound; the caller's outer
   * deadline (in the DiagnosticsService) settles independently.
   */
  private async probeCommand(argv: readonly string[]): Promise<CommandOutcome | { timeout: true }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const outcome = await this.runner.runCommand(argv, { signal: controller.signal })
      if (controller.signal.aborted) return { timeout: true }
      return outcome
    } catch {
      // The bounded runner rejects when its signal aborts (deadline) or on an
      // internal failure; both mean the probe could not complete.
      return controller.signal.aborted ? { timeout: true } : { timeout: true }
    } finally {
      clearTimeout(timer)
    }
  }

  private async probeGit(): Promise<GitProbeResult> {
    const outcome = await this.probeCommand([...this.gitCommand, '--version'])
    if ('timeout' in outcome) return { status: 'timeout', version: null }
    if (outcome.status === 'launch-error') {
      return { status: classifyLaunchError(outcome), version: null }
    }
    if (outcome.exitCode !== 0) return { status: 'nonzero', version: null }
    return { status: 'installed', version: extractSemver(combined(outcome)) }
  }

  private async probeXet(): Promise<XetProbeResult> {
    const primary = await this.probeCommand([...this.gitCommand, 'xet', 'version'])
    let outcome: CommandOutcome | { timeout: true }
    if ('timeout' in primary)
      return { status: 'timeout', version: null, filterCount: 0, filters: [] }
    if (primary.status === 'launch-error' || primary.exitCode !== 0) {
      const fallback = await this.probeCommand([...this.gitCommand, 'xet', '--version'])
      if ('timeout' in fallback) {
        return { status: 'timeout', version: null, filterCount: 0, filters: [] }
      }
      if (fallback.status === 'launch-error' || fallback.exitCode !== 0) {
        const marker = `${combined(primary)}\n${combined(fallback)}`.toLowerCase()
        return {
          status: marker.includes(MISSING_SUBCOMMAND_MARKER) ? 'missing' : 'nonzero',
          version: null,
          filterCount: 0,
          filters: []
        }
      }
      outcome = fallback
    } else {
      outcome = primary
    }
    const version = extractSemver(combined(outcome))
    if (version !== null && this.minXetVersion !== null) {
      const parsed = parseSemver(version)
      if (parsed !== null && compareSemver(parsed, this.minXetVersion) < 0) {
        return { status: 'old', version, filterCount: 0, filters: [] }
      }
    }
    const filters = await this.probeFilters()
    if (filters.status !== 'ok') {
      return { status: filters.status, version, filterCount: 0, filters: [] }
    }
    if (filters.entries.length === 0) {
      return { status: 'uninitialized', version, filterCount: 0, filters: [] }
    }
    return {
      status: 'configured',
      version,
      filterCount: filters.entries.length,
      filters: filters.entries
    }
  }

  private async probeFilters(): Promise<
    { status: 'ok'; entries: FilterEntry[] } | { status: XetProbeStatus; entries: [] }
  > {
    const outcome = await this.probeCommand([
      ...this.gitCommand,
      'config',
      '--show-origin',
      '--get-regexp',
      '^filter\\.xet\\.'
    ])
    if ('timeout' in outcome) return { status: 'timeout', entries: [] }
    if (outcome.status === 'launch-error') return { status: 'unknown', entries: [] }
    if (outcome.exitCode === 1) return { status: 'uninitialized', entries: [] }
    if (outcome.exitCode !== 0) return { status: 'unknown', entries: [] }
    return { status: 'ok', entries: parseFilterLines(outcome.stdout) }
  }

  private async probeCredentials(): Promise<CredentialProbeResult> {
    const outcome = await this.probeCommand([
      ...this.gitCommand,
      'config',
      '--show-origin',
      '--get-all',
      'credential.helper'
    ])
    if ('timeout' in outcome) {
      return { status: 'timeout', helperCount: 0, hasGcm: false, helpers: [] }
    }
    if (outcome.status === 'launch-error') {
      return { status: 'unknown', helperCount: 0, hasGcm: false, helpers: [] }
    }
    if (outcome.exitCode === 1) {
      return { status: 'none', helperCount: 0, hasGcm: false, helpers: [] }
    }
    if (outcome.exitCode !== 0) {
      return { status: 'unknown', helperCount: 0, hasGcm: false, helpers: [] }
    }
    const helpers = parseHelperLines(outcome.stdout)
    const hasGcm = helpers.some((helper) => helper.kind === 'gcm')
    const status: CredentialProbeStatus = helpers.some((helper) => helper.kind === 'store')
      ? 'plaintext'
      : 'configured'
    return { status, helperCount: helpers.length, hasGcm, helpers }
  }

  private async probeGcm(): Promise<ToolProbeResult> {
    const outcome = await this.probeCommand([...this.gitCommand, 'credential-manager', 'version'])
    if ('timeout' in outcome) return { status: 'timeout', version: null }
    if (outcome.status === 'launch-error') {
      return { status: classifyLaunchError(outcome), version: null }
    }
    if (outcome.exitCode === 0) {
      return { status: 'available', version: extractSemver(combined(outcome)) }
    }
    const marker = combined(outcome).toLowerCase()
    return {
      status: marker.includes(MISSING_SUBCOMMAND_MARKER) ? 'missing' : 'nonzero',
      version: null
    }
  }

  private async probeSsh(): Promise<ToolProbeResult> {
    const outcome = await this.probeCommand([...this.sshCommand, '-V'])
    if ('timeout' in outcome) return { status: 'timeout', version: null }
    if (outcome.status === 'launch-error') {
      const status = classifyLaunchError(outcome)
      return { status: status === 'denied' ? 'denied' : 'missing', version: null }
    }
    const version = extractSshVersion(combined(outcome))
    if (version !== null) return { status: 'available', version }
    // Windows OpenSSH prints the version and still exits nonzero; a successful
    // exit with no version is still an available client.
    if (outcome.exitCode === 0) return { status: 'available', version: null }
    return { status: 'missing', version: null }
  }
}

/** Exported for evidence/QA tooling: re-export the hash shape validator. */
export { HEX_RE }
