/**
 * Bounded, side-effect-free system and dependency readiness probes (plan Todo 23).
 *
 * Every probe reads the machine through the injected `DiagnosticsEnv` adapters
 * and is wrapped by a per-probe deadline plus caller cancellation, so no probe
 * can hang the main process or exceed its configured budget. Results are typed
 * `DiagnosticCheck`s (`pass | warning | failure | unknown` with a normalized
 * reason code and a sanitized user action), each string field is routed through
 * the Todo 22 redactor and path sanitizer, and a strict schema rejects unknown
 * fields before the report leaves the service.
 *
 * Side-effect discipline: the write/symlink probes create and remove a
 * uniquely named temp directory on the target volume and never touch the
 * target; the command probes are read-only (`git --version`, `git xet
 * --version`, `git config --show-origin ...`) and never mutate configuration.
 * Running diagnostics twice against the same machine yields identical results
 * and leaves the machine/config unchanged.
 */
import type { DiagnosticCheck, DiagnosticReport } from '@hubfetch/shared'
import type { DiagnosticCategory, DiagnosticReasonCode, DiagnosticStatus } from '@hubfetch/shared'
import {
  DEFAULT_HUB_ENDPOINT,
  diagnosticCheckSchema,
  diagnosticReportSchema
} from '@hubfetch/shared'
import { normalizeHubEndpoint } from '@hubfetch/shared'
import type { Redactor } from './security/redaction'
import { redactor as processRedactor } from './security/log'
import type {
  DiagnosticsEnv,
  DirectoryProbeOutcome,
  ProcessInfo,
  ReachabilityOutcome
} from './diagnostics-env'
import { sanitizePathText } from './diagnostics-env'
import { GitDiagnostics } from './git-diagnostics'

export type { DiagnosticsEnv } from './diagnostics-env'
export {
  createDefaultEnv,
  diskFreeBytes,
  probeDirectory,
  runCommandBounded,
  sanitizePathText,
  scanDirectorySize,
  CommandAbortedError,
  httpReachability
} from './diagnostics-env'
export type { DefaultEnvDeps } from './diagnostics-env'

/** Default per-probe deadline; every probe is wrapped by this bound. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

export interface DiagnosticsOptions {
  /** Per-probe deadline in milliseconds (default 5000). */
  probeTimeoutMs?: number
  /** Hub endpoint probed for reachability (default https://huggingface.co). */
  hubEndpoint?: string
  /** Free memory (bytes) below which the CPU/memory probe warns. */
  lowMemoryWarningBytes?: number
  /** Free memory (bytes) below which the CPU/memory probe fails. */
  criticalMemoryBytes?: number
  /** Free disk (bytes) below which the disk probe warns. */
  lowDiskWarningBytes?: number
  /** Free disk (bytes) below which the disk probe fails. */
  criticalDiskBytes?: number
  /** Redactor for all probe output (default: the process-wide redactor). */
  redactor?: Redactor
  /** Injectable Git/Git-Xet/credential readiness probe (default: bound to env). */
  gitDiagnostics?: GitDiagnostics
}

const DEFAULT_LOW_MEMORY_BYTES = 512 * 1024 * 1024
const DEFAULT_CRITICAL_MEMORY_BYTES = 128 * 1024 * 1024
const DEFAULT_LOW_DISK_BYTES = 1024 * 1024 * 1024
const DEFAULT_CRITICAL_DISK_BYTES = 128 * 1024 * 1024

/** Body of one check produced by a probe (deadline/cancel handled centrally). */
interface CheckBody {
  status: DiagnosticStatus
  reasonCode: DiagnosticReasonCode
  message: string
  detail?: string
  action?: string
}

interface ProbeDef {
  id: string
  category: DiagnosticCategory
  label: string
  run: (signal: AbortSignal) => Promise<CheckBody>
}

type BoundedOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'timeout' }
  | { kind: 'canceled' }
  | { kind: 'error'; error: string }

/**
 * Run a probe under a per-probe deadline plus caller cancellation. The abort
 * signal the probe receives is owned by this wrapper; a well-behaved adapter
 * (child process, fetch) stops immediately on abort. Even a misbehaving probe
 * that ignores the signal cannot exceed the deadline because the timer settles
 * this promise regardless of what the probe does. Deterministic outcome
 * classes: ok / timeout / canceled / error.
 */
export async function bounded<T>(
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<BoundedOutcome<T>> {
  const controller = new AbortController()
  return await new Promise<BoundedOutcome<T>>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
    }
    const settle = (outcome: BoundedOutcome<T>): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }
    const onOuterAbort = (): void => {
      controller.abort()
      settle({ kind: 'canceled' })
    }
    const timer = setTimeout(() => {
      controller.abort()
      settle({ kind: 'timeout' })
    }, timeoutMs)
    if (outerSignal) {
      if (outerSignal.aborted) {
        settle({ kind: 'canceled' })
        return
      }
      outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    }
    void Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        (value) => {
          if (outerSignal?.aborted) {
            settle({ kind: 'canceled' })
            return
          }
          if (controller.signal.aborted) {
            settle({ kind: 'timeout' })
            return
          }
          settle({ kind: 'ok', value })
        },
        (error) => {
          if (outerSignal?.aborted) {
            settle({ kind: 'canceled' })
            return
          }
          if (controller.signal.aborted) {
            settle({ kind: 'timeout' })
            return
          }
          settle({ kind: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      )
  })
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatMebibytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`
}

/**
 * Main diagnostics service. Construct with an environment (fake adapters in
 * tests, `createDefaultEnv` in production wiring) and run to get a typed,
 * schema-validated, bounded report.
 */
export class DiagnosticsService {
  private readonly env: DiagnosticsEnv
  private readonly options: DiagnosticsOptions
  private readonly redactor: Redactor
  private readonly gitDiagnostics: GitDiagnostics

  constructor(env: DiagnosticsEnv, options: DiagnosticsOptions = {}) {
    this.env = env
    this.options = options
    this.redactor = options.redactor ?? processRedactor
    this.gitDiagnostics =
      options.gitDiagnostics ??
      new GitDiagnostics({
        runner: {
          runCommand: (argv, opts) => this.env.runCommand(argv, opts)
        }
      })
  }

  /** Run every probe once and return a schema-validated, bounded report. */
  async run(
    signal?: AbortSignal,
    onProgress?: (progress: { completed: number; total: number; currentId: string }) => void
  ): Promise<DiagnosticReport> {
    const probes = this.probes()
    const checks: DiagnosticCheck[] = []
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index] as ProbeDef
      checks.push(await this.runProbe(probe, signal))
      onProgress?.({ completed: index + 1, total: probes.length, currentId: probe.id })
    }
    checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const report: DiagnosticReport = {
      checks,
      completedAt: new Date().toISOString()
    }
    const parsed = diagnosticReportSchema.safeParse(report)
    if (!parsed.success) {
      throw new Error(`diagnostics produced a non-conforming report: ${parsed.error.message}`)
    }
    return parsed.data
  }

  private timeoutMs(): number {
    return this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  }

  private async runProbe(def: ProbeDef, outerSignal?: AbortSignal): Promise<DiagnosticCheck> {
    const timeoutMs = this.timeoutMs()
    const startedAt = Date.now()
    const outcome = await bounded(timeoutMs, outerSignal, (signal) => def.run(signal))
    let body: CheckBody
    switch (outcome.kind) {
      case 'ok':
        body = outcome.value
        break
      case 'timeout':
        body = {
          status: 'failure',
          reasonCode: 'timeout',
          message: `${def.label} probe timed out after ${timeoutMs} ms`,
          action: 'Recheck the diagnostic.'
        }
        break
      case 'canceled':
        body = {
          status: 'unknown',
          reasonCode: 'canceled',
          message: `${def.label} probe was canceled`
        }
        break
      case 'error':
        body = {
          status: 'unknown',
          reasonCode: 'probe-error',
          message: `${def.label} probe failed`,
          detail: this.redact(outcome.error)
        }
        break
    }
    return this.finalize(def, body, Date.now() - startedAt, new Date().toISOString())
  }

  /** Apply redaction (Todo 22) and personal-path sanitization to probe text. */
  private redact(text: string): string {
    return sanitizePathText(this.redactor.redactText(text))
  }

  private finalize(
    def: ProbeDef,
    body: CheckBody,
    durationMs: number,
    checkedAt: string
  ): DiagnosticCheck {
    const check: DiagnosticCheck = {
      id: def.id,
      category: def.category,
      status: body.status,
      reasonCode: body.reasonCode,
      message: this.redact(body.message),
      detail: body.detail !== undefined ? this.redact(body.detail) : undefined,
      action: body.action !== undefined ? this.redact(body.action) : undefined,
      durationMs,
      checkedAt
    }
    const parsed = diagnosticCheckSchema.safeParse(check)
    if (!parsed.success) {
      throw new Error(`probe ${def.id} produced a non-conforming check: ${parsed.error.message}`)
    }
    return parsed.data as DiagnosticCheck
  }

  private probes(): ProbeDef[] {
    return [
      this.probeApp(),
      this.probeSystem(),
      this.probeCpuMemory(),
      this.probeDisk(),
      this.probeCachePath(),
      this.probeCacheWritable(),
      this.probeDestination(),
      this.probeSymlink(),
      this.probeNotifications(),
      this.probeNetwork(),
      this.probeGitVersion(),
      this.probeGitXet(),
      this.probeGitGcm(),
      this.probeGitCredentials(),
      this.probeGitSsh(),
      this.probeDb()
    ]
  }

  private probeApp(): ProbeDef {
    return {
      id: 'app.identity',
      category: 'app',
      label: 'App identity',
      run: async () => {
        let info
        try {
          info = this.env.getAppInfo()
        } catch {
          return {
            status: 'unknown',
            reasonCode: 'probe-error',
            message: 'App identity could not be read'
          }
        }
        return {
          status: 'pass',
          reasonCode: 'ok',
          message: `HubFetch ${info.version} (${info.buildKind} build)`,
          detail: `Electron ${info.electronVersion}`
        }
      }
    }
  }

  private probeSystem(): ProbeDef {
    return {
      id: 'system.windows',
      category: 'system',
      label: 'Windows version',
      run: async () => {
        let info: ProcessInfo
        try {
          info = this.env.getProcessInfo()
        } catch {
          return {
            status: 'unknown',
            reasonCode: 'probe-error',
            message: 'System information could not be read'
          }
        }
        return {
          status: 'pass',
          reasonCode: 'ok',
          message: `Windows ${info.release} (${info.platform}, ${info.arch})`
        }
      }
    }
  }

  private probeCpuMemory(): ProbeDef {
    return {
      id: 'system.cpu-memory',
      category: 'system',
      label: 'CPU and memory',
      run: async () => {
        let info: ProcessInfo
        try {
          info = this.env.getProcessInfo()
        } catch {
          return {
            status: 'unknown',
            reasonCode: 'probe-error',
            message: 'CPU and memory could not be read'
          }
        }
        const warning = this.options.lowMemoryWarningBytes ?? DEFAULT_LOW_MEMORY_BYTES
        const critical = this.options.criticalMemoryBytes ?? DEFAULT_CRITICAL_MEMORY_BYTES
        if (info.freeMemBytes <= critical) {
          return {
            status: 'failure',
            reasonCode: 'critical-memory',
            message: `Only ${formatMebibytes(info.freeMemBytes)} of system memory is free`,
            action: 'Close memory-heavy applications and recheck.'
          }
        }
        if (info.freeMemBytes <= warning) {
          return {
            status: 'warning',
            reasonCode: 'low-memory',
            message: `Only ${formatMebibytes(info.freeMemBytes)} of system memory is free`
          }
        }
        return {
          status: 'pass',
          reasonCode: 'ok',
          message: `${info.cpuCount} logical CPUs; ${formatBytes(info.totalMemBytes)} RAM`,
          detail: info.cpuModel
        }
      }
    }
  }

  private probeDisk(): ProbeDef {
    return {
      id: 'disk.free-space',
      category: 'disk',
      label: 'Disk free space',
      run: async () => {
        const cacheDir = this.env.getCacheDir()
        const free = await this.env.getDiskFreeBytes(cacheDir)
        if (free === null) {
          return {
            status: 'unknown',
            reasonCode: 'unavailable',
            message: 'Free disk space could not be measured'
          }
        }
        const warning = this.options.lowDiskWarningBytes ?? DEFAULT_LOW_DISK_BYTES
        const critical = this.options.criticalDiskBytes ?? DEFAULT_CRITICAL_DISK_BYTES
        if (free <= critical) {
          return {
            status: 'failure',
            reasonCode: 'critical-space',
            message: `Only ${formatBytes(free)} free on the cache volume`,
            action: 'Free disk space before downloading large models.'
          }
        }
        if (free <= warning) {
          return {
            status: 'warning',
            reasonCode: 'low-space',
            message: `Only ${formatBytes(free)} free on the cache volume`
          }
        }
        return {
          status: 'pass',
          reasonCode: 'ok',
          message: `${formatBytes(free)} free on the cache volume`
        }
      }
    }
  }

  private probeCachePath(): ProbeDef {
    return {
      id: 'cache.path',
      category: 'cache',
      label: 'Hub cache',
      run: async (signal) => {
        const cacheDir = this.env.getCacheDir()
        const scan = await this.env.scanDirectorySize(cacheDir, signal)
        if (scan.error !== undefined && scan.error.includes('ENOENT')) {
          return {
            status: 'warning',
            reasonCode: 'missing',
            message: 'The Hub cache directory does not exist yet',
            action: 'The cache is created on the first download.'
          }
        }
        if (scan.error !== undefined) {
          return {
            status: 'unknown',
            reasonCode: 'unavailable',
            message: 'The Hub cache directory could not be scanned',
            detail: scan.error
          }
        }
        if (scan.bounded) {
          return {
            status: 'warning',
            reasonCode: 'bounded',
            message: `The Hub cache has at least ${scan.entryCount} entries`,
            detail: 'The size scan was capped; the total size is unknown'
          }
        }
        return {
          status: 'pass',
          reasonCode: 'ok',
          message: `The Hub cache has ${scan.entryCount} entries (${formatBytes(scan.sizeBytes ?? 0)})`
        }
      }
    }
  }

  private probeCacheWritable(): ProbeDef {
    return {
      id: 'cache.read-write',
      category: 'cache',
      label: 'Hub cache writability',
      run: async (signal) => {
        const outcome: DirectoryProbeOutcome = await this.env.probeDirectory(
          this.env.getCacheDir(),
          signal
        )
        if (outcome.writable) {
          return {
            status: 'pass',
            reasonCode: 'ok',
            message: 'The Hub cache directory is writable'
          }
        }
        return {
          status: 'failure',
          reasonCode: 'unwritable',
          message: 'The Hub cache directory is not writable',
          detail: outcome.error,
          action: 'Choose a writable cache location in Settings.'
        }
      }
    }
  }

  private probeDestination(): ProbeDef {
    return {
      id: 'destination.access',
      category: 'destination',
      label: 'Download destination',
      run: async (signal) => {
        const outcome = await this.env.probeDirectory(this.env.getDestinationDir(), signal)
        if (outcome.writable) {
          return {
            status: 'pass',
            reasonCode: 'ok',
            message: 'The download destination is writable'
          }
        }
        return {
          status: 'failure',
          reasonCode: 'unwritable',
          message: 'The download destination is not writable',
          detail: outcome.error,
          action: 'Choose a writable download location in Settings.'
        }
      }
    }
  }

  private probeSymlink(): ProbeDef {
    return {
      id: 'symlink.capability',
      category: 'symlink',
      label: 'Symlink support',
      run: async (signal) => {
        const outcome = await this.env.probeDirectory(this.env.getDestinationDir(), signal)
        if (outcome.symlinkCapable) {
          return { status: 'pass', reasonCode: 'ok', message: 'Symlink creation is available' }
        }
        return {
          status: 'warning',
          reasonCode: 'degraded',
          message: 'Symlink creation is not available',
          action:
            'Enable Windows Developer Mode or run elevated so cached files can be deduplicated.'
        }
      }
    }
  }

  private probeNotifications(): ProbeDef {
    return {
      id: 'notifications.registration',
      category: 'notifications',
      label: 'Notification registration',
      run: async () => {
        let reg
        try {
          reg = this.env.getNotificationRegistration()
        } catch {
          return {
            status: 'unknown',
            reasonCode: 'probe-error',
            message: 'Notification registration status could not be read'
          }
        }
        switch (reg.status) {
          case 'registered':
            return {
              status: 'pass',
              reasonCode: 'ok',
              message: 'Windows toast notifications are registered'
            }
          case 'disabled':
            return {
              status: 'warning',
              reasonCode: 'disabled',
              message: 'System notifications are disabled in settings',
              action: 'Enable notifications in Settings to receive toast alerts.'
            }
          case 'unsupported':
            return {
              status: 'warning',
              reasonCode: 'unsupported',
              message: 'System notifications are unavailable in this build',
              detail: reg.reason
            }
          case 'failed':
            return {
              status: 'failure',
              reasonCode: 'unsupported',
              message: 'Windows toast notification registration failed',
              detail: reg.reason,
              action: 'Recheck after repairing the Start Menu shortcut.'
            }
        }
      }
    }
  }

  private probeNetwork(): ProbeDef {
    return {
      id: 'network.huggingface',
      category: 'network',
      label: 'Hugging Face reachability',
      run: async (signal) => {
        let endpoint: string
        try {
          endpoint = normalizeHubEndpoint(this.options.hubEndpoint ?? DEFAULT_HUB_ENDPOINT)
        } catch {
          return {
            status: 'unknown',
            reasonCode: 'unavailable',
            message: 'The configured Hub endpoint is invalid'
          }
        }
        const outcome: ReachabilityOutcome = await this.env.checkReachability(endpoint, {
          signal
        })
        if (outcome.reachable) {
          return {
            status: 'pass',
            reasonCode: 'ok',
            message: `Hugging Face is reachable (HTTP ${outcome.statusCode})`,
            detail: `route: ${outcome.proxyRoute}`
          }
        }
        return {
          status: 'failure',
          reasonCode: 'unreachable',
          message: 'Hugging Face is not reachable through the configured network route',
          detail: outcome.error,
          action: 'Check your connection or proxy settings in Settings → Network.'
        }
      }
    }
  }

  private probeGitVersion(): ProbeDef {
    return {
      id: 'git.version',
      category: 'git',
      label: 'Git',
      run: async () => {
        const diag = await this.gitDiagnostics.check()
        switch (diag.git.status) {
          case 'installed':
            return {
              status: 'pass',
              reasonCode: 'ok',
              message: 'Git is installed',
              detail: diag.git.version ?? 'version not parseable'
            }
          case 'missing':
            return {
              status: 'failure',
              reasonCode: 'missing',
              message: 'Git is not installed',
              action: 'Install Git (winget install --id Git.Git -e) and recheck.'
            }
          case 'denied':
            return {
              status: 'failure',
              reasonCode: 'denied',
              message: 'Git could not be executed',
              action: 'Allow HubFetch to run Git (antivirus or execution policy) and recheck.'
            }
          case 'timeout':
            return {
              status: 'failure',
              reasonCode: 'timeout',
              message: '`git --version` did not respond in time',
              action: 'Recheck after confirming `git --version` returns promptly.'
            }
          case 'nonzero':
            return {
              status: 'failure',
              reasonCode: 'nonzero',
              message: '`git --version` exited with a nonzero code'
            }
        }
      }
    }
  }

  private probeGitXet(): ProbeDef {
    return {
      id: 'git.xet',
      category: 'git',
      label: 'Git-Xet',
      run: async () => {
        const diag = await this.gitDiagnostics.check()
        switch (diag.xet.status) {
          case 'configured':
            return {
              status: 'pass',
              reasonCode: 'ok',
              message: 'Git-Xet filters are configured',
              detail: diag.xet.version
                ? `${diag.xet.filterCount} filter.xet.* entries; Git-Xet ${diag.xet.version}`
                : `${diag.xet.filterCount} filter.xet.* entries`
            }
          case 'old':
            return {
              status: 'warning',
              reasonCode: 'outdated',
              message: `Git-Xet ${diag.xet.version ?? 'version unknown'} is older than the supported version`,
              action: 'Upgrade Git-Xet (winget install --id git-xet.git-xet -e) and recheck.'
            }
          case 'uninitialized':
            return {
              status: 'warning',
              reasonCode: 'unconfigured',
              message: 'Git-Xet is installed but its filters are not configured',
              action: 'Run `git xet install` in a terminal, then recheck.'
            }
          case 'missing':
            return {
              status: 'warning',
              reasonCode: 'missing',
              message: 'Git-Xet is not installed',
              action: 'Install Git-Xet (winget install --id git-xet.git-xet -e) to clone Xet repos.'
            }
          case 'timeout':
            return {
              status: 'warning',
              reasonCode: 'timeout',
              message: 'The Git-Xet version probe timed out',
              action: 'Recheck after confirming `git xet version` returns promptly.'
            }
          case 'nonzero':
            return {
              status: 'warning',
              reasonCode: 'nonzero',
              message: 'Git-Xet reported an error while reading its version'
            }
          case 'unknown':
            return {
              status: 'warning',
              reasonCode: 'unavailable',
              message: 'Git-Xet readiness could not be determined'
            }
        }
      }
    }
  }

  private probeGitGcm(): ProbeDef {
    return {
      id: 'git.gcm',
      category: 'credentials',
      label: 'Git Credential Manager',
      run: async () => {
        const diag = await this.gitDiagnostics.check()
        switch (diag.gcm.status) {
          case 'available':
            return {
              status: 'pass',
              reasonCode: 'ok',
              message: 'Git Credential Manager is available',
              detail: diag.gcm.version ?? 'version not parseable'
            }
          case 'missing':
            return {
              status: 'warning',
              reasonCode: 'missing',
              message: 'Git Credential Manager is not installed',
              action: 'Install Git Credential Manager to store HTTPS credentials safely.'
            }
          case 'denied':
            return {
              status: 'warning',
              reasonCode: 'denied',
              message: 'Git Credential Manager could not be executed'
            }
          case 'timeout':
            return {
              status: 'warning',
              reasonCode: 'timeout',
              message: 'The Git Credential Manager probe timed out'
            }
          case 'nonzero':
            return {
              status: 'warning',
              reasonCode: 'nonzero',
              message: 'Git Credential Manager reported an error'
            }
          case 'unknown':
            return {
              status: 'unknown',
              reasonCode: 'unavailable',
              message: 'Git Credential Manager could not be checked (Git not found)'
            }
        }
      }
    }
  }

  private probeGitCredentials(): ProbeDef {
    return {
      id: 'git.credentials',
      category: 'credentials',
      label: 'Git credentials',
      run: async () => {
        const diag = await this.gitDiagnostics.check()
        switch (diag.credentials.status) {
          case 'configured': {
            const note = diag.credentials.hasGcm
              ? `${diag.credentials.helperCount} helper(s), including Git Credential Manager`
              : `${diag.credentials.helperCount} helper(s)`
            return {
              status: 'pass',
              reasonCode: 'ok',
              message: 'Git credential helpers are configured',
              detail: note
            }
          }
          case 'plaintext':
            return {
              status: 'warning',
              reasonCode: 'plaintext-helper',
              message: 'A plaintext Git credential helper is configured',
              action: 'Configure Git Credential Manager instead of the plaintext store helper.'
            }
          case 'none':
            return {
              status: 'warning',
              reasonCode: 'no-credential-helper',
              message: 'No Git credential helper is configured',
              action: 'Configure Git Credential Manager to store credentials safely.'
            }
          case 'timeout':
            return {
              status: 'unknown',
              reasonCode: 'timeout',
              message: 'The Git credential configuration probe timed out'
            }
          case 'unknown':
            return {
              status: 'unknown',
              reasonCode: 'unavailable',
              message: 'The Git credential configuration could not be read'
            }
        }
      }
    }
  }

  private probeGitSsh(): ProbeDef {
    return {
      id: 'git.ssh',
      category: 'credentials',
      label: 'SSH',
      run: async () => {
        const diag = await this.gitDiagnostics.check()
        switch (diag.ssh.status) {
          case 'available':
            return {
              status: 'pass',
              reasonCode: 'ok',
              message: 'SSH is available',
              detail: diag.ssh.version ?? undefined
            }
          case 'missing':
            return {
              status: 'warning',
              reasonCode: 'missing',
              message: 'SSH is not installed',
              action: 'Install the OpenSSH client to clone repositories over SSH.'
            }
          case 'denied':
            return {
              status: 'warning',
              reasonCode: 'denied',
              message: 'SSH could not be executed'
            }
          case 'timeout':
            return {
              status: 'warning',
              reasonCode: 'timeout',
              message: 'The SSH probe timed out'
            }
          case 'nonzero':
            return {
              status: 'warning',
              reasonCode: 'nonzero',
              message: 'SSH reported an error'
            }
          case 'unknown':
            return {
              status: 'unknown',
              reasonCode: 'unavailable',
              message: 'SSH availability could not be determined'
            }
        }
      }
    }
  }

  private probeDb(): ProbeDef {
    return {
      id: 'database.health',
      category: 'database',
      label: 'Database health',
      run: async (signal) => {
        let outcome
        try {
          outcome = await this.env.getDbHealth(signal)
        } catch (error) {
          return {
            status: 'unknown',
            reasonCode: 'probe-error',
            message: 'The database health check could not be run',
            detail: error instanceof Error ? error.message : String(error)
          }
        }
        if (outcome.ok) {
          return { status: 'pass', reasonCode: 'ok', message: 'The local database is healthy' }
        }
        return {
          status: 'failure',
          reasonCode: 'unhealthy',
          message: 'The local database health check failed',
          detail: outcome.error,
          action: 'Reopen the app; if the problem persists, reset local data in Settings.'
        }
      }
    }
  }
}
