import type {
  DiagnosticReport,
  DiagnosticsExportResult,
  DiagnosticsProgress
} from '@hubfetch/shared'

/**
 * Typed access to `window.hubfetch.diagnostics.*` (plan Todo 24). Every call
 * delegates to the central validated IPC path in main — this namespace is a
 * convenience surface, never a sender-validation bypass.
 */
export function runDiagnostics(): Promise<DiagnosticReport> {
  return window.hubfetch.diagnostics.run()
}

export function cancelDiagnostics(): Promise<void> {
  return window.hubfetch.diagnostics.cancel()
}

export function exportSupportBundle(): Promise<DiagnosticsExportResult> {
  return window.hubfetch.diagnostics.exportBundle()
}

export function cancelBundleExport(): Promise<void> {
  return window.hubfetch.diagnostics.cancelExport()
}

export function onDiagnosticsProgress(
  listener: (progress: DiagnosticsProgress) => void
): () => void {
  return window.hubfetch.diagnostics.onProgress(listener)
}
