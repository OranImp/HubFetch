/**
 * DiagnosticsCoordinator — the main-process owner of diagnostics runs and
 * support-bundle exports (plan Todo 24).
 *
 * Runs the Todo 23 `DiagnosticsService` through a fresh env each time (so
 * settings/proxy changes apply), streams progress over `evt:diagnosticsProgress`,
 * keeps the last report for export, and drives the Todo 24 fail-closed bundle
 * builder. Cancellation is cooperative via AbortControllers; the export temp
 * archive is cleaned on cancel/failure by the builder.
 */
import type {
  AppSettings,
  DiagnosticReport,
  DiagnosticsProgress,
  DownloadTask
} from '@hubfetch/shared'
import type { BundleSources, SupportBundleResult } from './support-bundle'
import { createBundleRedactor, SupportBundleBuilder } from './support-bundle'
import { DiagnosticsService, type DiagnosticsEnv } from './diagnostics'
import type { GitDiagnostics } from './git-diagnostics'
import { secretRegistry } from './security/secret-registry'
import { redactor } from './security/log'

export interface DiagnosticsCoordinatorOptions {
  /** Fresh env per run (current settings/proxy applied at call time). */
  envFactory: () => DiagnosticsEnv
  settings: () => AppSettings
  tasks: () => DownloadTask[]
  /** Current bounded log capture content (main + renderer). */
  logReader: () => { main: string; renderer: string }
  /** Trim the on-disk log files to their budget before an export reads them. */
  flushLogs?: () => Promise<void>
  broadcast: (progress: DiagnosticsProgress) => void
  /**
   * Shared Git/Git-Xet/credential readiness probe (plan Todo 4). The same
   * instance backs CloneManager, so `run()` invalidates it first: a Recheck
   * must never report a pre-run cache hit.
   */
  gitDiagnostics: GitDiagnostics
}

export class DiagnosticsCoordinator {
  private runController: AbortController | null = null
  private exportController: AbortController | null = null
  private lastReport: DiagnosticReport | null = null
  private readonly envFactory: () => DiagnosticsEnv
  private readonly settings: () => AppSettings
  private readonly tasks: () => DownloadTask[]
  private readonly logReader: () => { main: string; renderer: string }
  private readonly flushLogs: (() => Promise<void>) | undefined
  private readonly broadcast: (progress: DiagnosticsProgress) => void
  private readonly gitDiagnostics: GitDiagnostics

  constructor(options: DiagnosticsCoordinatorOptions) {
    this.envFactory = options.envFactory
    this.settings = options.settings
    this.tasks = options.tasks
    this.logReader = options.logReader
    this.flushLogs = options.flushLogs
    this.broadcast = options.broadcast
    this.gitDiagnostics = options.gitDiagnostics
  }

  get report(): DiagnosticReport | null {
    return this.lastReport
  }

  /** Run every probe once; aborts any previous in-flight run. */
  async run(): Promise<DiagnosticReport> {
    this.runController?.abort()
    const controller = new AbortController()
    this.runController = controller
    // Drop the shared probe cache first so this run re-probes the machine
    // (Recheck semantics) instead of serving a pre-run snapshot; the same
    // instance is shared with CloneManager, so its next gate sees fresh state.
    this.gitDiagnostics.invalidate()
    const service = new DiagnosticsService(this.envFactory(), {
      gitDiagnostics: this.gitDiagnostics
    })
    try {
      const report = await service.run(controller.signal, ({ completed, total, currentId }) => {
        this.broadcast({
          phase: 'run',
          percent: total > 0 ? completed / total : 0,
          status: `Running probe ${currentId}`,
          completedChecks: completed,
          totalChecks: total
        })
      })
      this.lastReport = report
      return report
    } finally {
      if (this.runController === controller) this.runController = null
    }
  }

  cancelRun(): void {
    this.runController?.abort()
  }

  /** Build + finalize the support bundle at `target`; fails closed on error. */
  async exportBundle(target: string): Promise<SupportBundleResult> {
    this.exportController?.abort()
    const controller = new AbortController()
    this.exportController = controller
    try {
      const sources = await this.collectSources(controller.signal)
      const builder = new SupportBundleBuilder({
        redactor: createBundleRedactor(redactor),
        leakGuard: () => secretRegistry.liveSecrets(),
        signal: controller.signal,
        onProgress: (percent, status, member) => {
          this.broadcast({ phase: 'export', percent, status, member })
        }
      })
      return await builder.build(target, sources)
    } finally {
      if (this.exportController === controller) this.exportController = null
    }
  }

  cancelExport(): void {
    this.exportController?.abort()
  }

  private async collectSources(signal: AbortSignal): Promise<BundleSources> {
    const env = this.envFactory()
    const report = this.lastReport ?? (await this.run())
    signal.throwIfAborted()
    if (this.flushLogs) await this.flushLogs()
    const info = env.getAppInfo()
    const processInfo = env.getProcessInfo()
    let diskFreeBytes: number | null
    try {
      diskFreeBytes = await env.getDiskFreeBytes(env.getCacheDir())
    } catch {
      diskFreeBytes = null
    }
    const logs = this.logReader()
    return {
      app: {
        app: 'HubFetch',
        version: info.version,
        buildKind: info.buildKind,
        electron: info.electronVersion,
        node: process.versions.node,
        chrome: process.versions.chrome ?? '',
        v8: process.versions.v8 ?? ''
      },
      system: {
        os: {
          platform: processInfo.platform,
          release: processInfo.release,
          arch: processInfo.arch
        },
        cpu: { model: processInfo.cpuModel, count: processInfo.cpuCount },
        memory: { totalBytes: processInfo.totalMemBytes, freeBytes: processInfo.freeMemBytes },
        disk: { freeBytes: diskFreeBytes }
      },
      diagnostics: report,
      settings: this.settings(),
      tasks: this.tasks(),
      mainLog: logs.main,
      rendererLog: logs.renderer
    }
  }
}
