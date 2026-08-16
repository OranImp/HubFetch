// apps/desktop/src/main/clone/clone-contract.ts
//
// Todo 29: the shell-free clone command, URL, progress, and error contracts.
//
//   - URL: derived only from kind + strict namespace/name (shared schemas);
//     a raw arbitrary remote is never accepted here.
//   - argv: literal `git clone --progress [...]` arrays — branch/tag use
//     `--branch --single-branch`, a full commit uses `--no-checkout` then a
//     bounded `fetch origin <sha>` and detached checkout. Never a shell.
//   - env: LC_ALL=C, GIT_PROGRESS_DELAY=0, GIT_TERMINAL_PROMPT=0 — stable,
//     English, non-interactive stderr. No credentials, ever.
//   - progress: documented Receiving/Resolving/Updating/Checkout + Git-Xet
//     stderr parses into bounded phase/percent/counters; unknown lines become
//     bounded, redacted diagnostics.
//   - errors: exit/stderr map to dependency/auth/gated/not-found/network/
//     proxy/disk/destination/cancelled/internal typed codes with sanitized
//     detail preserved.
//   - destination: validated as absent-or-empty and reserved atomically; a
//     failed/cancelled run never deletes or overwrites the destination.
//   - success: never reported without `.git` plus `git rev-parse HEAD`
//     verification of the requested revision.
//
// This module is Electron-free and synchronous (spawnSync) so every gate and
// QA probe gets REAL exit codes; Todo 27's worker hosts the streaming spawn
// while this contract supplies its envelope argv and the typed outcome rules.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLONE_ERROR_CODES,
  CLONE_PROGRESS_PHASES,
  cloneRepoKindSchema,
  cloneRevisionSchema,
  deriveCloneUrl,
  isDerivedCloneUrl,
  isValidCloneNamespaceName,
  type CloneErrorCode,
  type CloneProgressPhase,
  type CloneRepoKind,
  type CloneRevision,
  type CloneTransport
} from '@hubfetch/shared'
import { Redactor } from '../security/redaction'
import type { GitProxyContract } from '../git-proxy'

export { CLONE_ERROR_CODES, CLONE_PROGRESS_PHASES }
export type { CloneErrorCode, CloneProgressPhase }

// ---------------------------------------------------------------------------
// Progress parsing
// ---------------------------------------------------------------------------

/** One parsed progress record. `percent` is 0..100 and `done <= total`. */
export interface GitProgressRecord {
  phase: CloneProgressPhase
  percent: number
  done: number
  total: number
  /** Optional sanitized rate tail, e.g. "1.00 MiB | 512.00 KiB/s". */
  rate?: string
}

const PERCENT_RE = /^(\d{1,3})% \((\d+)\/(\d+)\)(?:, (.*))?$/
const MAX_PERCENT = 100

/** Documented percentage-based Git phases and their leading prefixes. */
const PHASE_PREFIXES: ReadonlyArray<readonly [string, CloneProgressPhase]> = [
  ['Counting objects', 'counting'],
  ['Compressing objects', 'compressing'],
  ['Receiving objects', 'receiving'],
  ['Resolving deltas', 'resolving'],
  ['Updating files', 'updating'],
  ['Checking out files', 'checkout']
]

/** Git-Xet progress prefixes (case-insensitive action + "xet blobs"). */
const XET_PREFIX_RE = /^([A-Za-z]+ [Xx]et blobs):(.*)$/

function extractRate(tail: string | undefined): string | undefined {
  if (!tail) return undefined
  const trimmed = tail.trim()
  if (trimmed === 'done.') return undefined
  if (trimmed.endsWith(', done.')) return trimmed.slice(0, -', done.'.length).trim() || undefined
  return trimmed
}

/**
 * Parse ONE documented Git clone progress line into a typed record, or null
 * when the line is not a recognized progress record. Handles `remote:`-prefixed
 * and local lines. Percent >100 and counters that disagree are rejected.
 */
export function parseCloneProgressLine(rawLine: string): GitProgressRecord | null {
  let line = rawLine.trim()
  if (line.startsWith('remote:')) line = line.slice('remote:'.length).trim()
  if (line.startsWith('Enumerating objects:')) {
    const match = /^(\d+), done\.$/.exec(line.slice('Enumerating objects:'.length).trim())
    if (match === null) return null
    const count = Number(match[1])
    return { phase: 'enumerating', percent: MAX_PERCENT, done: count, total: count }
  }
  const xet = XET_PREFIX_RE.exec(line)
  if (xet !== null) {
    const match = PERCENT_RE.exec((xet[2] ?? '').trim())
    if (match === null || Number(match[1]) > MAX_PERCENT) return null
    return {
      phase: 'xet',
      percent: Number(match[1]),
      done: Number(match[2]),
      total: Number(match[3]),
      rate: extractRate(match[4])
    }
  }
  for (const [prefix, phase] of PHASE_PREFIXES) {
    if (!line.startsWith(`${prefix}:`)) continue
    const match = PERCENT_RE.exec(line.slice(prefix.length + 1).trim())
    if (match === null || Number(match[1]) > MAX_PERCENT) return null
    return {
      phase,
      percent: Number(match[1]),
      done: Number(match[2]),
      total: Number(match[3]),
      rate: extractRate(match[4])
    }
  }
  return null
}

function clampRecord(record: GitProgressRecord): GitProgressRecord {
  const percent = Math.min(MAX_PERCENT, Math.max(0, record.percent))
  const total = Math.max(0, record.total)
  const done = Math.min(total, Math.max(0, record.done))
  return { ...record, percent, done, total }
}

/**
 * Per-phase monotonic + clamped progress accumulator. `percent` and `done`
 * never decrease within a phase; `percent` is clamped to 0..100 and `done` is
 * clamped to `<= total`. A NEW phase starts fresh (its own progress resets).
 */
export class CloneProgressAccumulator {
  private readonly perPhase = new Map<CloneProgressPhase, GitProgressRecord>()

  /** Absorb one parsed record; returns the accumulated (clamped) record. */
  update(record: GitProgressRecord): GitProgressRecord {
    const clamped = clampRecord(record)
    const previous = this.perPhase.get(clamped.phase)
    if (previous !== undefined) {
      const merged: GitProgressRecord = {
        ...clamped,
        percent: Math.max(previous.percent, clamped.percent),
        done: Math.max(previous.done, clamped.done),
        total: Math.max(previous.total, clamped.total),
        rate: clamped.rate ?? previous.rate
      }
      this.perPhase.set(clamped.phase, merged)
      return merged
    }
    this.perPhase.set(clamped.phase, clamped)
    return clamped
  }

  /** Last accumulated percent for a phase (0 when never seen). */
  phasePercent(phase: CloneProgressPhase): number {
    return this.perPhase.get(phase)?.percent ?? 0
  }

  /** Most recent record across phases (for the UI's "current phase"). */
  latest(): GitProgressRecord | null {
    const phases = [...this.perPhase.keys()]
    if (phases.length === 0) return null
    const last = phases[phases.length - 1]
    return last === undefined ? null : (this.perPhase.get(last) ?? null)
  }

  /** Deterministic snapshot in phase-appearance order. */
  records(): GitProgressRecord[] {
    return [...this.perPhase.values()]
  }
}

// ---------------------------------------------------------------------------
// Bounded diagnostics (unknown stderr lines, redacted and capped)
// ---------------------------------------------------------------------------

export const MAX_DIAGNOSTIC_LINES = 64
export const MAX_DIAGNOSTIC_LINE_LENGTH = 512

/** Truncate one sanitized diagnostic line to the contract bound. */
export function truncateDiagnosticLine(line: string): string {
  return line.length > MAX_DIAGNOSTIC_LINE_LENGTH ? line.slice(0, MAX_DIAGNOSTIC_LINE_LENGTH) : line
}

/** Redact and bound one unknown stderr line. */
export function sanitizeCloneDiagnostic(rawLine: string, redactor: Redactor): string {
  return truncateDiagnosticLine(redactor.redactText(rawLine))
}

/** Collects unknown stderr lines into a bounded, redacted list. */
export class BoundedCloneDiagnostics {
  private readonly lines: string[] = []
  private droppedCount = 0

  /** Add one unknown stderr line; silently drops beyond the cap (counted). */
  add(rawLine: string, redactor: Redactor): void {
    if (this.lines.length >= MAX_DIAGNOSTIC_LINES) {
      this.droppedCount += 1
      return
    }
    this.lines.push(sanitizeCloneDiagnostic(rawLine, redactor))
  }

  /** Deterministic redacted lines; never more than MAX_DIAGNOSTIC_LINES. */
  snapshot(): readonly string[] {
    return this.lines
  }

  dropped(): number {
    return this.droppedCount
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Structured failure used to raise a typed CloneExecutionError. */
export interface CloneFailure {
  code: CloneErrorCode
  /** Sanitized detail (redacted stderr excerpt or synthesized). */
  detail: string
  exitCode: number | null
}

/** The typed clone execution error every failed clone raises. */
export class CloneExecutionError extends Error {
  readonly code: CloneErrorCode
  readonly exitCode: number | null

  constructor(failure: CloneFailure) {
    super(`clone ${failure.code}: ${failure.detail}`)
    this.name = 'CloneExecutionError'
    this.code = failure.code
    this.exitCode = failure.exitCode
  }
}

const AUTH_MARKERS: readonly string[] = [
  'authentication failed',
  'could not read username',
  'could not read password',
  'permission denied (publickey)',
  'terminal prompts disabled'
]
const GATED_MARKERS: readonly string[] = [
  'access to repository',
  'is disabled',
  'repository is gated'
]
const XET_DEPENDENCY_MARKERS: readonly string[] = [
  "external filter 'git-xet filter' failed",
  "filter 'xet' failed",
  'git-xet'
]
const NOT_FOUND_MARKERS: readonly string[] = [
  'not found',
  'does not appear to be a git repository',
  'could not read from remote repository'
]
const PROXY_MARKERS: readonly string[] = [
  'could not resolve proxy',
  'proxy authentication',
  'proxy error',
  'tunnel failed',
  'connect to proxy',
  'via proxy',
  '407 proxy'
]
const NETWORK_MARKERS: readonly string[] = [
  'unable to access',
  'could not resolve host',
  'unable to resolve host',
  'failed to connect',
  'connection timed out',
  'connection refused',
  'early eof',
  'hung up unexpectedly',
  'rpc failed',
  'the requested url returned error: 5',
  'name or service not known',
  'getaddrinfo',
  'ssl certificate'
]
const DISK_MARKERS: readonly string[] = [
  'no space left on device',
  'disk quota exceeded',
  'not enough space',
  'cannot create directory',
  'cannot write'
]
const DESTINATION_MARKERS: readonly string[] = [
  'already exists and is not an empty directory',
  'exists and is not empty',
  'destination path'
]
const CANCELLED_MARKERS: readonly string[] = ['operation canceled', 'clone was cancelled']

/** Map a failed clone's folded stderr to the typed code (best-effort, ordered). */
export function classifyCloneError(foldedStderr: string, exitCode: number | null): CloneErrorCode {
  const checks: ReadonlyArray<{ markers: readonly string[]; code: CloneErrorCode }> = [
    { markers: GATED_MARKERS, code: 'gated' },
    { markers: AUTH_MARKERS, code: 'auth' },
    { markers: XET_DEPENDENCY_MARKERS, code: 'dependency' },
    { markers: NOT_FOUND_MARKERS, code: 'not-found' },
    { markers: PROXY_MARKERS, code: 'proxy' },
    { markers: NETWORK_MARKERS, code: 'network' },
    { markers: DISK_MARKERS, code: 'disk' },
    { markers: DESTINATION_MARKERS, code: 'destination' },
    { markers: CANCELLED_MARKERS, code: 'cancelled' }
  ]
  for (const { markers, code } of checks) {
    if (markers.some((marker) => foldedStderr.includes(marker))) return code
  }
  void exitCode
  return 'internal'
}

/** Build a typed failure for one failed clone, preserving sanitized detail. */
export function makeCloneFailure(
  exitCode: number | null,
  stderrText: string,
  redactor: Redactor
): CloneFailure {
  const sanitized = sanitizeCloneDiagnostic(stderrText, redactor)
  const folded = stderrText.toLocaleLowerCase()
  const code = classifyCloneError(folded, exitCode)
  const detail =
    sanitized.trim() || (exitCode === null ? 'git did not start' : `git clone exited ${exitCode}`)
  return { code, detail, exitCode }
}

// ---------------------------------------------------------------------------
// argv + environment
// ---------------------------------------------------------------------------

/** Options for building one clone argv (shared by the executor and callers). */
export interface CloneArgvOptions {
  url: string
  destination: string
  revision?: CloneRevision
  /** Prepend the Todo 20 git proxy `-c` flags (before the subcommand). */
  proxy?: GitProxyContract
}

/**
 * The literal no-shell argv AFTER the git executable, starting at `clone`.
 * branch/tag → `clone --progress --branch <ref> --single-branch url dest`;
 * full commit → `clone --progress --no-checkout url dest`; no revision →
 * `clone --progress url dest`.
 */
export function buildCloneArgv(options: CloneArgvOptions): string[] {
  const { url, destination, revision } = options
  const argv = ['clone', '--progress']
  if (revision !== undefined) {
    if (revision.kind === 'branch' || revision.kind === 'tag') {
      argv.push('--branch', revision.name, '--single-branch')
    } else {
      argv.push('--no-checkout')
    }
  }
  argv.push(url, destination)
  if (options.proxy !== undefined) {
    return [...options.proxy.argv, ...argv]
  }
  return argv
}

/** Full argv INCLUDING the git executable prefix (for direct spawns). */
export function fullCloneArgv(git: readonly string[], argv: readonly string[]): string[] {
  return [...git, ...argv]
}

/**
 * Stable, non-interactive Git environment: LC_ALL=C forces English stderr so
 * progress parsing is stable across locales; GIT_PROGRESS_DELAY=0 surfaces
 * progress immediately on a pipe; GIT_TERMINAL_PROMPT=0 fails auth fast
 * instead of hanging a headless worker on an interactive prompt.
 */
export function cloneEnvironment(parent: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...parent,
    LC_ALL: 'C',
    GIT_PROGRESS_DELAY: '0',
    GIT_TERMINAL_PROMPT: '0'
  }
}

// ---------------------------------------------------------------------------
// Destination reservation (absent-or-empty, atomic, never destructive)
// ---------------------------------------------------------------------------

export const DESTINATION_MARKER_PREFIX = '.hubfetch-reserve-'

/** How the destination was claimed. */
export type DestinationReservationStatus = 'created' | 'reserved'

/** Handle that must be released before (or after) git runs. */
export interface CloneDestinationReservation {
  path: string
  status: DestinationReservationStatus
  /** Remove the reservation marker; idempotent. */
  release(): Promise<void>
}

/** Destination validation failure (code 'destination', typed detail). */
export class DestinationError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`invalid clone destination: ${reason}`)
    this.name = 'DestinationError'
    this.reason = reason
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Validate a destination as absent or empty and reserve it ATOMICALLY. An
 * absent path is created; an existing empty directory receives an exclusive
 * marker so concurrent reservations on the same path have exactly one winner.
 * Non-empty directories, files, and uncreatable parents are refused. The
 * marker is removed by the caller (executor) before git runs — the reservation
 * serializes concurrent starts; git's own empty check is the final referee.
 * NEVER deletes or overwrites anything that existed before this call.
 */
export async function reserveCloneDestination(
  destination: string
): Promise<CloneDestinationReservation> {
  let created = false
  let info
  try {
    info = await stat(destination)
  } catch {
    try {
      await mkdir(destination)
      created = true
      info = await stat(destination)
    } catch {
      throw new DestinationError(`cannot create directory: ${destination}`)
    }
  }
  if (!info.isDirectory()) {
    throw new DestinationError(`destination is not a directory: ${destination}`)
  }
  if (!created) {
    const entries = await readdir(destination)
    if (entries.length > 0) {
      throw new DestinationError(`destination is not empty: ${destination}`)
    }
  }
  const marker = join(destination, `${DESTINATION_MARKER_PREFIX}${randomBytes(6).toString('hex')}`)
  try {
    // 'wx' = exclusive create: the atomic claim.
    await writeExclusive(marker)
  } catch {
    throw new DestinationError(`destination is already reserved: ${destination}`)
  }
  return {
    path: destination,
    status: created ? 'created' : 'reserved',
    release: async () => {
      try {
        await rm(marker, { force: true })
      } catch {
        /* the marker may already be gone; release is idempotent */
      }
    }
  }
}

/** Exclusive file create — the atomic primitive behind the reservation. */
async function writeExclusive(marker: string): Promise<void> {
  const handle = await open(marker, 'wx')
  await handle.close()
}

// ---------------------------------------------------------------------------
// HEAD verification
// ---------------------------------------------------------------------------

export interface HeadVerificationOptions {
  git: readonly string[]
  timeoutMs?: number
}

export interface HeadVerification {
  /** Actual `git rev-parse HEAD` sha in the clone. */
  sha: string
  /** Expected sha for the requested revision, when it could be derived. */
  expected?: string
  ok: boolean
  /** Human detail when verification failed. */
  detail?: string
}

/** The ref whose tip a branch/tag clone should point at. */
export function expectedRefOf(revision: CloneRevision): string | null {
  if (revision.kind === 'branch') return `refs/remotes/origin/${revision.name}`
  if (revision.kind === 'tag') return `refs/tags/${revision.name}`
  return null
}

/** Ref argument to `git rev-parse` for the requested revision (commit = HEAD). */
export function revisionRefArg(revision: CloneRevision): string {
  if (revision.kind === 'commit') return 'HEAD'
  return expectedRefOf(revision) ?? 'HEAD'
}

function runGitSync(
  git: readonly string[],
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number
): { status: number | null; stdout: string; stderr: string; error: Error | null } {
  const result = spawnSync(git[0] ?? 'git', [...git.slice(1), ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null
  }
}

/**
 * Verify `.git` exists and `git rev-parse HEAD` (plus the requested revision's
 * expected tip, when derivable) matches. Throws a typed error on any mismatch —
 * success is never reported without this verification.
 */
export async function verifyCloneHead(
  destination: string,
  revision: CloneRevision | undefined,
  options: HeadVerificationOptions
): Promise<HeadVerification> {
  const redactor = new Redactor()
  const timeoutMs = options.timeoutMs ?? 60_000
  const env = cloneEnvironment(process.env as Readonly<Record<string, string>>)
  if (!(await isDirectory(join(destination, '.git')))) {
    return { sha: '', ok: false, detail: 'clone destination has no .git directory' }
  }
  const head = runGitSync(options.git, ['rev-parse', 'HEAD'], destination, env, timeoutMs)
  if (head.status !== 0 || head.error !== null) {
    const detail = redactor.redactText(head.stderr.trim() || 'git rev-parse HEAD failed')
    return { sha: '', ok: false, detail: `git rev-parse HEAD failed: ${detail}` }
  }
  const sha = head.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return { sha, ok: false, detail: 'git rev-parse HEAD returned a non-sha value' }
  }
  if (revision === undefined) {
    return { sha, ok: true }
  }
  if (revision.kind === 'commit') {
    const ok = sha === revision.sha
    return {
      sha,
      expected: revision.sha,
      ok,
      detail: ok ? undefined : `HEAD ${sha} != requested commit ${revision.sha}`
    }
  }
  const ref = expectedRefOf(revision)
  if (ref === null) return { sha, ok: true }
  const tip = runGitSync(options.git, ['rev-parse', ref], destination, env, timeoutMs)
  if (tip.status !== 0 || tip.error !== null) {
    return { sha, ok: false, detail: `requested ref ${ref} did not resolve in the clone` }
  }
  const expected = tip.stdout.trim()
  const ok = expected === sha
  return { sha, expected, ok, detail: ok ? undefined : `HEAD ${sha} != ${ref} ${expected}` }
}

// ---------------------------------------------------------------------------
// Executor (real exit codes via node spawnSync; injectable for tests/QA)
// ---------------------------------------------------------------------------

export interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
  error: Error | null
}

export interface RunCloneOptions {
  /** The DERIVED clone URL (kind + id + transport); validated before spawn. */
  url: string
  kind: CloneRepoKind
  id: string
  destination: string
  revision?: CloneRevision
  /** Git executable prefix; defaults to ['git']. */
  git?: readonly string[]
  /** Base environment; defaults to process.env. */
  baseEnv?: Readonly<Record<string, string>>
  /** Per-command timeout (bounded; default 10 minutes). */
  timeoutMs?: number
  /** Todo 20 proxy contract folded into argv + env. */
  proxy?: GitProxyContract
  /** Receives every accumulated progress record. */
  onProgress?: (record: GitProgressRecord) => void
  /** Cooperative cancellation checked before and after each git command. */
  cancel?: () => boolean
  /** Injectable spawn (tests/QA); default is spawnSync with real exit codes. */
  spawn?: (
    git: readonly string[],
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    timeoutMs: number
  ) => SpawnResult
}

export interface CloneRunResult {
  destination: string
  headSha: string
  /** Exact clone argv (git executable included) used for the primary command. */
  argv: string[]
  phases: GitProgressRecord[]
  diagnostics: readonly string[]
  droppedDiagnostics: number
}

/** Run one shell-free clone with the full contract. Throws CloneExecutionError. */
export async function runClone(options: RunCloneOptions): Promise<CloneRunResult> {
  const { url, kind, id, destination, revision, proxy } = options
  const git = options.git ?? ['git']
  const baseEnv = options.baseEnv ?? (process.env as Readonly<Record<string, string>>)
  const timeoutMs = options.timeoutMs ?? 600_000
  const redactor = new Redactor()
  const spawn =
    options.spawn ??
    ((cmd, argv, env, timeout) => {
      const result = spawnSync(cmd[0] ?? 'git', [...cmd.slice(1), ...argv], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024
      })
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error ?? null
      }
    })

  // URL boundary: only derived URLs reach git.
  if (!isDerivedCloneUrl(url)) {
    throw new CloneExecutionError({
      code: 'internal',
      detail: 'refusing a non-derived clone URL',
      exitCode: null
    })
  }
  // Runtime schema gates: an option-injecting kind/id/revision is refused
  // BEFORE any git process or destination change.
  if (!cloneRepoKindSchema.safeParse(kind).success) {
    throw new CloneExecutionError({
      code: 'internal',
      detail: 'invalid repository kind',
      exitCode: null
    })
  }
  if (!isValidCloneNamespaceName(id)) {
    throw new CloneExecutionError({
      code: 'internal',
      detail: 'invalid repository id in clone request',
      exitCode: null
    })
  }
  if (revision !== undefined && !cloneRevisionSchema.safeParse(revision).success) {
    throw new CloneExecutionError({
      code: 'internal',
      detail: 'invalid clone revision',
      exitCode: null
    })
  }
  // Derived URL and id must agree (defense-in-depth against a mixed request).
  const transport: CloneTransport = url.startsWith('git@') ? 'ssh' : 'https'
  const derived = deriveCloneUrl(kind, id, transport)
  if (url !== derived) {
    throw new CloneExecutionError({
      code: 'internal',
      detail: 'clone URL does not match the requested repository',
      exitCode: null
    })
  }

  const reservation = await reserveCloneDestination(destination)
  let cancelled = false
  try {
    if (options.cancel !== undefined && options.cancel()) {
      cancelled = true
      throw new CloneExecutionError({
        code: 'cancelled',
        detail: 'clone was cancelled',
        exitCode: null
      })
    }

    const accumulator = new CloneProgressAccumulator()
    const diagnostics = new BoundedCloneDiagnostics()

    // Release the reservation marker BEFORE git runs so the destination is
    // empty for git's own non-empty check. The reservation serialized
    // concurrent starts; git's atomic empty check is the final referee.
    await reservation.release()

    // Primary clone command.
    const cloneArgv = buildCloneArgv({ url, destination, revision, proxy })
    const fullArgv = [...git, ...cloneArgv]
    const env = cloneEnvironment(baseEnv)
    if (proxy !== undefined) {
      Object.assign(env, proxy.env)
    }
    const primary = spawn(git, cloneArgv, env, timeoutMs)
    if (options.cancel !== undefined && options.cancel()) {
      cancelled = true
      throw new CloneExecutionError({
        code: 'cancelled',
        detail: 'clone was cancelled',
        exitCode: null
      })
    }
    if (primary.error !== null && primary.status === null) {
      throw new CloneExecutionError({
        code: 'dependency',
        detail: `git could not start: ${redactor.redactText(primary.error.message)}`,
        exitCode: null
      })
    }
    parseCloneStderr(primary.stderr, {
      accumulator,
      diagnostics,
      redactor,
      onProgress: options.onProgress
    })
    if (primary.status !== 0) {
      throw new CloneExecutionError(makeCloneFailure(primary.status, primary.stderr, redactor))
    }

    // Full-commit path: bounded fetch + detached checkout.
    if (revision !== undefined && revision.kind === 'commit') {
      const fetch = spawn(git, ['-C', destination, 'fetch', 'origin', revision.sha], env, timeoutMs)
      parseCloneStderr(fetch.stderr, {
        accumulator,
        diagnostics,
        redactor,
        onProgress: options.onProgress
      })
      if (fetch.status !== 0) {
        throw new CloneExecutionError(makeCloneFailure(fetch.status, fetch.stderr, redactor))
      }
      const checkout = spawn(
        git,
        ['-C', destination, 'checkout', '--detach', revision.sha],
        env,
        timeoutMs
      )
      parseCloneStderr(checkout.stderr, {
        accumulator,
        diagnostics,
        redactor,
        onProgress: options.onProgress
      })
      if (checkout.status !== 0) {
        throw new CloneExecutionError(makeCloneFailure(checkout.status, checkout.stderr, redactor))
      }
    }

    // Final `.git` + `git rev-parse HEAD` verification.
    const verification = await verifyCloneHead(destination, revision, { git, timeoutMs })
    if (!verification.ok) {
      throw new CloneExecutionError({
        code: 'internal',
        detail: verification.detail ?? 'HEAD verification failed',
        exitCode: null
      })
    }

    return {
      destination,
      headSha: verification.sha,
      argv: fullArgv,
      phases: accumulator.records(),
      diagnostics: diagnostics.snapshot(),
      droppedDiagnostics: diagnostics.dropped()
    }
  } catch (error) {
    if (cancelled) {
      throw new CloneExecutionError({
        code: 'cancelled',
        detail: 'clone was cancelled',
        exitCode: null
      })
    }
    throw error
  } finally {
    // Release the reservation marker; a failed/cancelled run NEVER deletes the
    // destination itself (git's partials stay untouched).
    await reservation.release()
  }
}

/** Parse whole stderr text into records and bounded diagnostics (fragmented-safe). */
export function parseCloneStderr(
  text: string,
  options: {
    accumulator?: CloneProgressAccumulator
    diagnostics?: BoundedCloneDiagnostics
    redactor?: Redactor
    onProgress?: (record: GitProgressRecord) => void
  }
): GitProgressRecord[] {
  const redactor = options.redactor ?? new Redactor()
  const records: GitProgressRecord[] = []
  for (const rawLine of splitFragmentedLines(text)) {
    if (rawLine.trim() === '') continue
    const record = parseCloneProgressLine(rawLine)
    if (record !== null) {
      const accumulated = options.accumulator?.update(record) ?? record
      records.push(accumulated)
      options.onProgress?.(accumulated)
    } else {
      options.diagnostics?.add(rawLine, redactor)
    }
  }
  return records
}

/** Split stderr into lines on `\n` OR `\r`, handling git's fragmented updates. */
export function splitFragmentedLines(text: string): string[] {
  const lines: string[] = []
  let buffer = ''
  for (const character of text) {
    if (character === '\n' || character === '\r') {
      if (buffer.length > 0) {
        lines.push(buffer)
        buffer = ''
      }
    } else {
      buffer += character
    }
  }
  if (buffer.length > 0) lines.push(buffer)
  return lines
}
