import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CloneRecord, DiagnosticCheck } from '@hubfetch/shared'
import { Copy, FolderOpen, RefreshCw, Trash2, TriangleAlert, XCircle } from 'lucide-react'
import {
  cloneDetailLines,
  cloneQueuePosition,
  describeClonePhase,
  isTerminalCloneStatus
} from '@/lib/clone-detail'
import { runDiagnostics } from '@/lib/diagnostics'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CloneStatusBadge } from '@/components/clones/CloneStatusBadge'
import { ClonePrerequisiteRow } from '@/components/clones/ClonePrerequisiteRow'

const GIT_CHECK_ID = 'git.version'
const GIT_XET_CHECK_ID = 'git.xet'
const GIT_GCM_CHECK_ID = 'git.gcm'
const GIT_SSH_CHECK_ID = 'git.ssh'

function checkById(
  checks: readonly DiagnosticCheck[] | undefined,
  id: string
): DiagnosticCheck | undefined {
  return checks?.find((check) => check.id === id)
}

export type CloneDrawerAction = 'cancel' | 'retry' | 'open' | 'copy' | 'viewParent' | 'remove'

export interface CloneDetailDrawerProps {
  record: CloneRecord
  records: readonly CloneRecord[]
  busy: boolean
  onClose: () => void
  onAction: (action: CloneDrawerAction, record: CloneRecord) => void
}

/**
 * Right-hand detail drawer with FIXED dimensions: the panel width never changes
 * as progress events stream in; content scrolls inside the frame instead.
 */
export function CloneDetailDrawer({
  record,
  records,
  busy,
  onClose,
  onAction
}: CloneDetailDrawerProps): React.JSX.Element {
  const { t, i18n } = useTranslation(['clones', 'common', 'errors'])
  const queryClient = useQueryClient()
  const parent = record.retryOf ? (records.find((r) => r.id === record.retryOf) ?? null) : null
  const lines = useMemo(
    () => cloneDetailLines(t, record, i18n.language),
    [t, record, i18n.language]
  )
  const position = cloneQueuePosition(records, record.id)

  const indeterminate = record.status === 'running' && (record.progress?.total ?? 0) === 0
  const progressText = record.progress
    ? t('clones:progress.summary', {
        phase: describeClonePhase(t, record.progress.phase),
        percent: t('clones:progress.percent', { percent: record.progress.percent }),
        counters: t('clones:progress.counters', {
          done: record.progress.done,
          total: record.progress.total
        })
      })
    : record.status === 'running' || record.status === 'cancelling'
      ? t('clones:progress.starting')
      : undefined

  const retryable =
    record.status === 'failed' || record.status === 'cancelled' || record.status === 'interrupted'
  const openable = record.status === 'completed' || record.status === 'interrupted'
  const removable = isTerminalCloneStatus(record.status)

  // Prerequisites — reuse the existing Todo 28 diagnostics run for the drawer.
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => runDiagnostics(),
    staleTime: 60_000
  })
  const [rechecked, setRechecked] = useState(false)

  const rerunDiagnostics = useMutation({
    mutationFn: () => runDiagnostics(),
    onSuccess: (report) => {
      queryClient.setQueryData(['diagnostics'], report)
      setRechecked(true)
    }
  })

  const gitCheck = checkById(diagnostics.data?.checks, GIT_CHECK_ID)
  const gitXetCheck = checkById(diagnostics.data?.checks, GIT_XET_CHECK_ID)
  const gcmCheck = checkById(diagnostics.data?.checks, GIT_GCM_CHECK_ID)
  const sshCheck = checkById(diagnostics.data?.checks, GIT_SSH_CHECK_ID)

  // Restart hint: after a Recheck, if a shown prerequisite row is still not
  // passing, Windows may not have picked up the new PATH yet.
  const shownChecks = [gitCheck, gitXetCheck, record.transport === 'https' ? gcmCheck : sshCheck]
  const showRestartHint = rechecked && shownChecks.some((check) => check?.status !== 'pass')

  const bodyId = useId()
  const detailRows = lines.map((line) => (
    <div key={line.label} className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
        {line.label}
      </dt>
      <dd className="min-w-0 break-words text-[12.5px] leading-relaxed text-ink-muted">
        {line.value}
      </dd>
    </div>
  ))

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        aria-describedby={bodyId}
        className="top-0 right-0 left-auto h-full w-[21rem] max-w-[calc(100vw-3rem)] translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0 p-5 overflow-y-auto"
      >
        <DialogTitle className="flex items-center gap-2 pr-6">
          <CloneStatusBadge status={record.status} />
          <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] font-medium">
            {record.repoId}
          </span>
        </DialogTitle>

        <div id={bodyId} className="mt-3 flex flex-col gap-4">
          {record.status === 'interrupted' ? (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[12.5px] leading-relaxed text-ink">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <span>{t('clones:banner.interrupted')}</span>
            </p>
          ) : null}

          {record.status === 'running' || record.status === 'cancelling' ? (
            <div className="flex flex-col gap-1">
              <Progress
                value={record.progress ? record.progress.percent / 100 : undefined}
                indeterminate={indeterminate}
                aria-valuetext={progressText}
              />
              <span className="nums text-[11.5px] text-ink-muted">{progressText}</span>
            </div>
          ) : null}

          <dl className="flex flex-col gap-2.5">
            {detailRows}
            {position !== null && position > 0 ? (
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                  {t('clones:queuePositionLabel')}
                </dt>
                <dd className="nums text-[12.5px] text-ink-muted">#{position}</dd>
              </div>
            ) : null}
            {parent ? (
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                  {t('clones:attempt', { n: record.attempt })}
                </dt>
                <dd>
                  <button
                    type="button"
                    onClick={() => onAction('viewParent', parent)}
                    className="rounded-md text-[12.5px] text-link underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                  >
                    {t('clones:detail.retryOfAttempt', { id: parent.attempt })}
                  </button>
                </dd>
              </div>
            ) : null}
          </dl>

          {retryable ? (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border-card bg-panel p-3">
              <p className="text-[12px] font-semibold text-ink-strong">
                {t('clones:detail.retryInfo')}
              </p>
              <p className="text-[12px] leading-relaxed text-ink-muted">
                {t('clones:detail.retryInfoBody')}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t('clones:action.copyDetails')}
                  disabled={busy}
                  onClick={() => onAction('copy', record)}
                >
                  <Copy className="size-3.5" aria-hidden />
                  {t('clones:action.copyDetails')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('clones:action.copyDetails')}</TooltipContent>
            </Tooltip>
            {(record.status === 'queued' || record.status === 'running') && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onAction('cancel', record)}
              >
                <XCircle className="size-3.5" aria-hidden />
                {t('clones:action.cancel')}
              </Button>
            )}
            {retryable && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onAction('retry', record)}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {t('clones:action.retry')}
              </Button>
            )}
            {openable && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onAction('open', record)}
              >
                <FolderOpen className="size-3.5" aria-hidden />
                {t('clones:action.openFolder')}
              </Button>
            )}
            {removable && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onAction('remove', record)}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t('clones:action.remove')}
              </Button>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border-card pt-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[12.5px] font-semibold text-ink-strong">
                {t('clones:detail.prerequisites')}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => rerunDiagnostics.mutate()}
                disabled={rerunDiagnostics.isPending}
              >
                <RefreshCw
                  className={cn('size-3.5', rerunDiagnostics.isPending && 'animate-spin')}
                  aria-hidden
                />
                {t('clones:diagnostics.recheck')}
              </Button>
            </div>
            {diagnostics.isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <ClonePrerequisiteRow
                  compact
                  tool="git"
                  label={t('clones:diagnostics.git')}
                  check={gitCheck}
                  gitPass={gitCheck?.status === 'pass'}
                  message={
                    gitCheck?.message ??
                    (gitCheck?.status === 'pass'
                      ? t('clones:diagnostics.pass')
                      : t('clones:diagnostics.gitMissing'))
                  }
                />
                <ClonePrerequisiteRow
                  compact
                  tool="git-xet"
                  label={t('clones:diagnostics.gitXet')}
                  check={gitXetCheck}
                  gitPass={gitCheck?.status === 'pass'}
                  warning
                  message={
                    gitXetCheck?.message ??
                    (gitXetCheck?.status === 'pass'
                      ? t('clones:diagnostics.pass')
                      : t('clones:diagnostics.gitXetMissing'))
                  }
                />
                {record.transport === 'https' ? (
                  <ClonePrerequisiteRow
                    compact
                    tool="gcm"
                    label={t('clones:diagnostics.credentialHelper')}
                    check={gcmCheck}
                    gitPass={gitCheck?.status === 'pass'}
                    warning
                    message={
                      gcmCheck?.message ??
                      (gcmCheck?.status === 'pass'
                        ? t('clones:diagnostics.pass')
                        : t('clones:diagnostics.credentialHelperMissing'))
                    }
                  />
                ) : (
                  <ClonePrerequisiteRow
                    compact
                    tool="ssh"
                    label={t('clones:diagnostics.sshAgent')}
                    check={sshCheck}
                    gitPass={gitCheck?.status === 'pass'}
                    message={
                      sshCheck?.message ??
                      (sshCheck?.status === 'pass'
                        ? t('clones:diagnostics.pass')
                        : t('clones:diagnostics.sshMissing'))
                    }
                  />
                )}
              </div>
            )}

            {showRestartHint ? (
              <p className="text-[11.5px] text-ink-faint">{t('clones:diagnostics.restartHint')}</p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
