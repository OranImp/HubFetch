import type { CloneRecord } from '@hubfetch/shared'
import { Copy, FolderOpen, GitBranch, RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  cloneQueuePosition,
  describeCloneAuth,
  describeClonePhase,
  describeCloneProxy,
  describeCloneRevision,
  formatCloneTimestamp
} from '@/lib/clone-detail'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CloneStatusBadge } from '@/components/clones/CloneStatusBadge'

/** Labeled action buttons a task row exposes for one attempt. */
export type CloneRowAction = 'cancel' | 'retry' | 'open' | 'copy' | 'view' | 'viewParent'

export interface CloneTaskCardProps {
  record: CloneRecord
  records: readonly CloneRecord[]
  /** Whether any mutation on this attempt is in flight. */
  busy: boolean
  onAction: (action: CloneRowAction, record: CloneRecord) => void
}

/**
 * One clone attempt row. Flat single card — no nested cards. Every control is
 * an icon + tooltip with a localized aria-label; status is a text badge, never
 * color alone.
 */
export function CloneTaskCard({
  record,
  records,
  busy,
  onAction
}: CloneTaskCardProps): React.JSX.Element {
  const { t, i18n } = useTranslation(['clones', 'common'])
  const position = cloneQueuePosition(records, record.id)
  const parent = record.retryOf ? (records.find((r) => r.id === record.retryOf) ?? null) : null
  const live = record.status === 'running' || record.status === 'cancelling'
  const indeterminate = record.status === 'running' && (record.progress?.total ?? 0) === 0
  const progressValue = record.progress ? record.progress.percent / 100 : undefined
  const cancelling = record.status === 'cancelling'

  const progressText = record.progress
    ? t('clones:progress.summary', {
        phase: describeClonePhase(t, record.progress.phase),
        percent: t('clones:progress.percent', { percent: record.progress.percent }),
        counters: t('clones:progress.counters', {
          done: record.progress.done,
          total: record.progress.total
        })
      })
    : live
      ? t('clones:progress.starting')
      : undefined

  return (
    <div
      data-testid={`clone-card-${record.id}`}
      className="flex flex-col gap-2.5 rounded-lg border border-border-card bg-card-gradient p-4"
    >
      <div className="flex items-center gap-2">
        <CloneStatusBadge status={record.status} />
        <button
          type="button"
          onClick={() => onAction('view', record)}
          aria-label={t('clones:action.viewDetails', { id: record.repoId })}
          className="min-w-0 flex-1 truncate text-left font-mono text-[13.5px] font-medium text-ink-strong transition-colors duration-150 outline-none hover:text-link focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        >
          {record.repoId}
        </button>
        <span className="nums flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-faint">
          <GitBranch className="size-3.5" aria-hidden />
          {t('clones:attempt', { n: record.attempt })}
          {parent ? (
            <button
              type="button"
              onClick={() => onAction('viewParent', parent)}
              className="rounded-md text-ink-muted underline-offset-2 outline-none hover:text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            >
              {t('clones:detail.retryOfAttempt', { id: parent.attempt })}
            </button>
          ) : null}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
        <span>{t(`clones:kind.${record.repoKind}`)}</span>
        <span className="max-w-64 truncate" title={describeCloneRevision(t, record.revision)}>
          {describeCloneRevision(t, record.revision)}
        </span>
        <span>{t(`clones:transport.${record.transport}`)}</span>
        <span>{describeCloneAuth(t, record.auth)}</span>
        <span className="flex min-w-0 items-center gap-1 text-ink-faint">
          <span className="truncate" title={describeCloneProxy(t, record.proxy)}>
            {describeCloneProxy(t, record.proxy)}
          </span>
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-1 text-[11.5px] text-ink-faint">
        <span className="shrink-0">{t('clones:detail.destination')}:</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[11px]" title={record.destination}>
          {record.destination}
        </code>
      </div>

      {live ? (
        <div className="flex flex-col gap-1">
          <Progress
            value={progressValue}
            indeterminate={indeterminate}
            aria-valuetext={progressText}
          />
          <span className="nums text-[11px] text-ink-muted">{progressText}</span>
        </div>
      ) : null}

      {record.error ? (
        <p className="flex min-w-0 items-start gap-1.5 text-[12px] text-error" title={record.error}>
          <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{record.error}</span>
        </p>
      ) : null}

      <div className="flex items-center gap-3 text-[11px] text-ink-faint">
        <span className="nums">
          {t('clones:detail.updated', {
            time: formatCloneTimestamp(record.updatedAt, i18n.language)
          })}
        </span>
        {position !== null && (
          <span className="nums">{t('clones:queuePosition', { n: position })}</span>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('clones:action.copyDetails')}
                disabled={busy}
                onClick={() => onAction('copy', record)}
              >
                <Copy className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('clones:action.copyDetails')}</TooltipContent>
          </Tooltip>
          {record.status === 'queued' || record.status === 'running' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('clones:action.cancel')}
                  disabled={busy}
                  onClick={() => onAction('cancel', record)}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('clones:action.cancel')}</TooltipContent>
            </Tooltip>
          ) : null}
          {cancelling ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('clones:action.cancel')}
                  disabled
                  onClick={() => onAction('cancel', record)}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('clones:action.disabledCancel')}</TooltipContent>
            </Tooltip>
          ) : null}
          {record.status === 'failed' ||
          record.status === 'cancelled' ||
          record.status === 'interrupted' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('clones:action.retry')}
                  disabled={busy}
                  onClick={() => onAction('retry', record)}
                >
                  <RefreshCw className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('clones:action.retry')}</TooltipContent>
            </Tooltip>
          ) : null}
          {record.status === 'completed' || record.status === 'interrupted' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('clones:action.openFolder')}
                  disabled={busy}
                  onClick={() => onAction('open', record)}
                >
                  <FolderOpen className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('clones:action.openFolder')}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      </div>
    </div>
  )
}
