/**
 * Diagnostics environment adapters (plan Todo 23).
 *
 * Every probe in `DiagnosticsService` reads the machine through this narrow
 * interface so tests can inject deterministic fake OS/process/network/FS
 * adapters. The default env is pure Node (no Electron import): the application
 * wiring supplies the Electron-backed pieces (app identity, notification
 * registration, database health, proxy-bound fetch) when it constructs the
 * service.
 *
 * Side-effect discipline: the write/symlink probe creates and removes a
 * uniquely named temp directory on the target volume; the size scan never
 * follows symlinks; the command runner is argv-safe (`shell: false`, capping
 * output) and bounded by an AbortSignal the caller owns.
 */
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, opendir, statfs, symlink, writeFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { cpus, freemem, release, totalmem } from 'node:os'
import { parse } from 'node:path'
import { join } from 'node:path'
import type { NotificationRegistrationInfo } from '@hubfetch/shared'
import { defaultCacheDir } from '@hubfetch/hub-api'

export interface ProcessInfo {
  platform: string
  release: string
  arch: string
  cpuModel: string
  cpuCount: number
  totalMemBytes: number
  freeMemBytes: number
}

export interface AppInfoSnapshot {
  version: string
  buildKind: 'packaged' | 'development'
  electronVersion: string
}

export interface DirectoryProbeOutcome {
  writable: boolean
  symlinkCapable: boolean
  /** Sanitized OS error detail (personal paths already stripped). */
  error?: string
}

export interface DirectorySizeOutcome {
  /** Total bytes, or null when the scan was capped or failed. */
  sizeBytes: number | null
  entryCount: number
  bounded: boolean
  error?: string
}

export interface CommandOutcome {
  status: 'completed' | 'launch-error'
  exitCode: number | null
  stdout: string
  stderr: string
  /**
   * Node error code from the spawn failure (e.g. `ENOENT` for a missing
   * binary vs `EACCES`/`EPERM` for an execution-denied one). Only set when
   * `status === 'launch-error'`; consumers must treat it as advisory and
   * redact it before it crosses any process boundary.
   */
  errorCode?: string
}

export interface CommandRunOptions {
  /**
   * The probe's deadline/cancel signal, owned by the `bounded` wrapper in the
   * service. The command runner only honors the signal (killing the child on
   * abort); it never runs its own timer.
   */
  signal: AbortSignal
  maxOutputBytes?: number
}

export interface DbHealthOutcome {
  ok: boolean
  error?: string
}

export type ProxyRoute = 'system' | 'manual' | 'direct'

export interface ReachabilityOutcome {
  reachable: boolean
  statusCode: number | null
  proxyRoute: ProxyRoute
  error?: string
}

export interface DiagnosticsEnv {
  getProcessInfo(): ProcessInfo
  /** Free bytes on the volume hosting a path, or null when unqueryable. */
  getDiskFreeBytes(path: string): Promise<number | null>
  /** Write + symlink capability on the volume; never mutates the target. */
  probeDirectory(target: string, signal: AbortSignal): Promise<DirectoryProbeOutcome>
  /** Bounded recursive size scan that never follows symlinks. */
  scanDirectorySize(path: string, signal: AbortSignal): Promise<DirectorySizeOutcome>
  getCacheDir(): string
  getDestinationDir(): string
  getNotificationRegistration(): NotificationRegistrationInfo
  getDbHealth(signal: AbortSignal): Promise<DbHealthOutcome>
  runCommand(argv: readonly string[], opts: CommandRunOptions): Promise<CommandOutcome>
  checkReachability(url: string, opts: CommandRunOptions): Promise<ReachabilityOutcome>
  getAppInfo(): AppInfoSnapshot
}

/** Marker for a command aborted by the bounded runner's signal. */
export class CommandAbortedError extends Error {
  constructor() {
    super('command aborted by its deadline or cancellation')
    this.name = 'CommandAbortedError'
  }
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Run one argv-safe bounded child process. `shell: false` so no value can be
 * interpreted by a shell; stdout/stderr are capped; an abort signal kills the
 * child and rejects with `CommandAbortedError` (the probe's deadline/cancel is
 * decided once by the `bounded` wrapper in the service).
 */
export async function runCommandBounded(
  argv: readonly string[],
  opts: CommandRunOptions
): Promise<CommandOutcome> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  return await new Promise<CommandOutcome>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn(argv[0] as string, argv.slice(1) as string[], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve({ status: 'launch-error', exitCode: null, stdout: '', stderr: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => {
      if (!settled) {
        child?.kill()
        reject(new CommandAbortedError())
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutputBytes) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutputBytes) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      // ENOENT for a missing binary, EACCES/EPERM for an execution-denied one
      // etc. — never a mutation, just unavailability. The Node code is kept so
      // callers can tell "not installed" apart from "execution denied".
      const code = (error as NodeJS.ErrnoException).code
      finish({ status: 'launch-error', exitCode: null, stdout, stderr, errorCode: code })
    })
    child.on('close', (code) => {
      finish({ status: 'completed', exitCode: code, stdout, stderr })
    })
  })
}

const PROBE_DIR_PREFIX = '.hubfetch-probe-'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function nearestExistingAncestor(target: string): Promise<string | null> {
  let candidate = target
  for (;;) {
    const entry = await lstat(candidate).catch(() => null)
    if (entry?.isDirectory()) return candidate
    const parent = parse(candidate).dir
    if (!parent || parent === candidate) return null
    candidate = parent
  }
}

/**
 * Probe writability and symlink capability on the volume hosting `target`.
 * Writes happen only inside a uniquely named temp directory that is always
 * removed afterwards — the target itself is never mutated. A failed probe never
 * throws (unless aborted); it returns a typed partial result.
 */
export async function probeDirectory(
  target: string,
  signal: AbortSignal
): Promise<DirectoryProbeOutcome> {
  signal.throwIfAborted()
  const host = await nearestExistingAncestor(target)
  if (host === null) {
    return { writable: false, symlinkCapable: false, error: 'no writable ancestor found' }
  }
  let probeDir: string | null = null
  try {
    probeDir = await mkdtemp(join(host, PROBE_DIR_PREFIX))
    signal.throwIfAborted()
    const probeFile = join(probeDir, 'write.probe')
    await writeFile(probeFile, 'hubfetch-probe', { flag: 'wx' })
    signal.throwIfAborted()
    let symlinkCapable = true
    try {
      await symlink(probeFile, join(probeDir, 'link.probe'))
    } catch {
      symlinkCapable = false
    }
    return { writable: true, symlinkCapable }
  } catch (error) {
    if (signal.aborted) throw error
    return {
      writable: false,
      symlinkCapable: false,
      error: sanitizePathText(errorMessage(error))
    }
  } finally {
    if (probeDir !== null) {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

const MAX_SCAN_DEPTH = 12
const MAX_SCAN_ENTRIES = 20_000

/**
 * Recursive byte/file scan that never follows symlinks and caps depth and entry
 * count. When the cap is hit or an error interrupts the scan, `sizeBytes` is
 * null (an unknown size is never reported as a precise number).
 */
export async function scanDirectorySize(
  path: string,
  signal: AbortSignal
): Promise<DirectorySizeOutcome> {
  let sizeBytes = 0
  let entryCount = 0
  let bounded = false
  let error: string | undefined

  const walk = async (dir: string, depth: number): Promise<void> => {
    signal.throwIfAborted()
    if (depth > MAX_SCAN_DEPTH) {
      bounded = true
      return
    }
    let handle
    try {
      handle = await opendir(dir)
    } catch (err) {
      error = errorMessage(err)
      return
    }
    try {
      for await (const entry of handle) {
        if (entryCount >= MAX_SCAN_ENTRIES) {
          bounded = true
          return
        }
        signal.throwIfAborted()
        entryCount += 1
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), depth + 1)
          continue
        }
        const full = join(dir, entry.name)
        const stat = await lstat(full).catch(() => null)
        if (stat?.isFile()) sizeBytes += stat.size
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  try {
    await walk(path, 0)
  } catch (err) {
    if (signal.aborted) throw err
    error = errorMessage(err)
  }
  if (bounded || error !== undefined) {
    return { sizeBytes: null, entryCount, bounded, error }
  }
  return { sizeBytes, entryCount, bounded: false }
}

/** Free bytes on the volume hosting a path, or null when unqueryable. */
export async function diskFreeBytes(path: string): Promise<number | null> {
  const root = parse(path).root || path
  try {
    const stats = await statfs(root)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

/**
 * Strip personal paths from probe text: Windows drive-letter paths collapse to
 * `<path>` and user-profile segments to `\Users\<user>`. Run after the redactor
 * so registered secrets and tokens are gone first.
 */
export function sanitizePathText(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '<path>')
    .replace(/([\\/])Users[\\/][^\\/\s]+/gi, '$1Users$1<user>')
    .slice(0, 2000)
}

/**
 * Bounded proxy-resolved HTTP reachability probe. `fetchImpl` is the Todo 20
 * snapshot-aware fetch; only response headers are consumed and the body is
 * canceled immediately, so the probe never downloads anything.
 */
export async function httpReachability(
  url: string,
  fetchImpl: typeof fetch,
  opts: CommandRunOptions,
  proxyRoute: ProxyRoute
): Promise<ReachabilityOutcome> {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: opts.signal })
    res.body?.cancel().catch(() => undefined)
    return { reachable: true, statusCode: res.status, proxyRoute }
  } catch (error) {
    if (opts.signal.aborted) throw error
    return {
      reachable: false,
      statusCode: null,
      proxyRoute,
      error: sanitizePathText(errorMessage(error))
    }
  }
}

export interface DefaultEnvDeps {
  appInfo?: AppInfoSnapshot
  notificationRegistration?: () => NotificationRegistrationInfo
  dbHealth?: (signal: AbortSignal) => Promise<DbHealthOutcome>
  cacheDir?: () => string
  destinationDir?: () => string
  hubEndpoint?: string
  fetchImpl?: typeof fetch
  proxyRoute?: () => ProxyRoute
}

/**
 * Default environment built from pure Node plus injected application pieces.
 * The application wiring supplies the Electron/DB/transport-backed overrides;
 * the fallbacks are deliberately explicit (unknown, never a false pass).
 */
export function createDefaultEnv(deps: DefaultEnvDeps = {}): DiagnosticsEnv {
  const appInfo: AppInfoSnapshot = deps.appInfo ?? {
    version: process.env.npm_package_version ?? '0.0.0',
    buildKind: 'development',
    electronVersion: process.versions.electron ?? 'n/a'
  }
  const cacheDir = deps.cacheDir ?? (() => defaultCacheDir(process.env))
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const proxyRoute = deps.proxyRoute ?? ((() => 'direct') as () => ProxyRoute)
  return {
    getProcessInfo: () => {
      const cpuList = cpus()
      return {
        platform: process.platform,
        release: release(),
        arch: process.arch,
        cpuModel: cpuList[0]?.model ?? 'unknown',
        cpuCount: cpuList.length,
        totalMemBytes: totalmem(),
        freeMemBytes: freemem()
      }
    },
    getDiskFreeBytes: diskFreeBytes,
    probeDirectory,
    scanDirectorySize,
    getCacheDir: cacheDir,
    getDestinationDir: deps.destinationDir ?? cacheDir,
    getNotificationRegistration:
      deps.notificationRegistration ?? (() => ({ status: 'unsupported' })),
    getDbHealth:
      deps.dbHealth ??
      (async () => ({ ok: false, error: 'database probe not wired by the application' })),
    runCommand: runCommandBounded,
    checkReachability: (url, opts) => httpReachability(url, fetchImpl, opts, proxyRoute()),
    getAppInfo: () => appInfo
  }
}
