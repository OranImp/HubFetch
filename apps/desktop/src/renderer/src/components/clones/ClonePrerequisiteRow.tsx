import { useTranslation } from 'react-i18next'
import { CheckCircle2, Copy, ExternalLink, XCircle } from 'lucide-react'
import {
  cloneToolRowActions,
  type CloneToolId,
  type DiagnosticCheck
} from '@hubfetch/shared'
import { performCloneToolInstall } from '@/lib/clone-tools'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useToasts } from '@/components/ui/toaster'

export type ClonePrerequisiteTool = CloneToolId | 'ssh'

/**
 * Maps a diagnostic check to the underlying tool state string that
 * `cloneToolRowActions` expects. The report's closed 4-value `status`
 * collapses the probe's finer outcome into `reasonCode` (e.g. Xet
 * "installed but not configured" is `status: 'warning'` +
 * `reasonCode: 'unconfigured'`).
 */
function checkState(
  check: DiagnosticCheck | undefined,
  tool: ClonePrerequisiteTool
): string {
  if (!check) return 'unknown'
  if (check.status === 'pass') return 'pass'
  if (tool === 'git-xet') {
    switch (check.reasonCode) {
      case 'outdated':
        return 'old'
      case 'unconfigured':
        return 'uninitialized'
      case 'missing':
        return 'missing'
      case 'timeout':
        return 'timeout'
      case 'nonzero':
        return 'nonzero'
      default:
        return 'unknown'
    }
  }
  // git / gcm / ssh: the helper treats every non-pass state identically.
  return 'missing'
}

export interface ClonePrerequisiteRowProps {
  /** Which prerequisite this row shows; 'ssh' rows are message-only (no actions). */
  tool: ClonePrerequisiteTool
  label: string
  /** Matching diagnostic check; undefined while the report has not landed. */
  check?: DiagnosticCheck
  /** True when the Git check passed (GCM row only; GCM ships with Git for Windows). */
  gitPass: boolean
  /** Message to display (callers fall back to a localized default). */
  message: string
  /** Warning-colored failure for recommended tools; error-colored for required ones. */
  warning?: boolean
  /** Compact styling for the fixed-width clone detail drawer. */
  compact?: boolean
}

/**
 * Shared clone-prerequisite row used by the clone create page and the clone
 * detail drawer. Renders status icon + label + message plus the state-specific
 * Install / Copy-winget / Copy-configure actions from `cloneToolRowActions`.
 * SSH rows never get actions. Actions wrap below the status line so the fixed
 * drawer width (`w-[21rem]`) is never widened.
 */
export function ClonePrerequisiteRow({
  tool,
  label,
  check,
  gitPass,
  message,
  warning,
  compact
}: ClonePrerequisiteRowProps): React.JSX.Element {
  const { t } = useTranslation(['clones'])
  const push = useToasts((s) => s.push)

  const actions = cloneToolRowActions({
    tool,
    status: checkState(check, tool),
    gitPass
  })
  // Destructure to locals so the string|null narrowing survives into onClick.
  const wingetCommand = actions.showCopyWinget ? actions.wingetCommand : null
  const configureCommand = actions.showCopyConfigure ? actions.configureCommand : null
  const installTool: CloneToolId | null = tool === 'ssh' ? null : tool

  const copyText = (text: string): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => push(t('clones:diagnostics.copied'), 'success'))
      .catch(() => push(t('clones:diagnostics.copyFailed'), 'error'))
  }

  const pass = check?.status === 'pass'
  const hasActions = actions.showInstall || wingetCommand !== null || configureCommand !== null

  return (
    <div
      data-testid={`clone-prereq-row-${tool}`}
      className={cn('flex flex-col', compact ? 'gap-1' : 'gap-1.5')}
    >
      <div className={cn('flex items-center gap-2', compact ? 'text-[12px]' : 'text-[12.5px]')}>
        {pass ? (
          <CheckCircle2
            className={cn('shrink-0 text-success', compact ? 'size-3.5' : 'size-4')}
            aria-hidden
          />
        ) : (
          <XCircle
            className={cn(
              'shrink-0',
              compact ? 'size-3.5' : 'size-4',
              warning ? 'text-warning' : 'text-error'
            )}
            aria-hidden
          />
        )}
        <span
          className={
            compact
              ? 'min-w-0 flex-1 truncate text-ink-muted'
              : 'min-w-[120px] font-medium text-ink-strong'
          }
        >
          {label}
        </span>
        <span
          className={cn(
            compact ? 'min-w-0 max-w-40 truncate text-right' : 'flex-1',
            pass ? 'text-success' : warning ? 'text-warning' : 'text-error'
          )}
          title={message}
        >
          {message}
        </span>
      </div>
      {hasActions ? (
        <div className={cn('flex flex-wrap items-center gap-1.5', compact ? 'pl-[22px]' : 'pl-6')}>
          {actions.showInstall && installTool ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => performCloneToolInstall(installTool)}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t('clones:diagnostics.install')}
            </Button>
          ) : null}
          {wingetCommand ? (
            <Button variant="ghost" size="sm" onClick={() => copyText(wingetCommand)}>
              <Copy className="size-3.5" aria-hidden />
              {t('clones:diagnostics.copyWinget')}
            </Button>
          ) : null}
          {configureCommand ? (
            <Button variant="ghost" size="sm" onClick={() => copyText(configureCommand)}>
              <Copy className="size-3.5" aria-hidden />
              {t('clones:diagnostics.copyConfigure')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
