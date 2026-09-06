import {
  ChevronRight,
  Eraser,
  FolderOpen,
  Wrench,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CachedRepo, CacheVerificationRepo } from '@hubfetch/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils'
import { CacheIconAction } from './CacheIconAction'
import { bucketOf, repairHintKey, type RepairBlockReason } from './cache-page-model'

interface CacheRepoCardProps {
  readonly repo: CachedRepo
  readonly icon: React.ComponentType<{ className?: string }>
  readonly isOpen: boolean
  readonly pinnedCommits?: ReadonlySet<string>
  readonly locale: string
  readonly verification?: CacheVerificationRepo
  readonly repairBlock: RepairBlockReason | null
  readonly stale: { commitHashes: string[]; size: number } | null
  readonly cleanPending: boolean
  readonly onToggle: () => void
  readonly onDeleteStale: () => void
  readonly onDeleteRevision: (commitHash: string, size: number) => void
  readonly onReveal: () => void
  readonly onCleanPartials: () => void
  readonly onPrune: () => void
  readonly onRepair: () => void
}

export function CacheRepoCard({
  repo,
  icon: Icon,
  isOpen,
  pinnedCommits,
  locale,
  verification,
  repairBlock,
  stale,
  cleanPending,
  onToggle,
  onDeleteStale,
  onDeleteRevision,
  onReveal,
  onCleanPartials,
  onPrune,
  onRepair
}: CacheRepoCardProps): React.JSX.Element {
  const { t } = useTranslation(['cache', 'common'])
  const repoKey = `${repo.kind}:${repo.id}`
  const repairHint = t(`cache:${repairHintKey(repairBlock)}`)

  return (
    <div data-testid={`cache-repo-${repoKey}`} className="rounded-lg border">
      <div
        className={cn(
          'flex items-center gap-2 rounded-t-lg px-3 py-2.5 transition-colors duration-150 hover:bg-panel',
          !isOpen && 'rounded-b-lg'
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-decor transition-transform duration-150',
              isOpen && 'rotate-90'
            )}
            aria-hidden
          />
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-panel">
            <Icon className="size-3.5 text-ink-muted" aria-hidden />
          </span>
          <span className="min-w-0 truncate font-mono text-[13px] font-medium tracking-tight text-ink-strong">
            {repo.id}
          </span>
          <Badge variant="outline" className="nums">
            {t('cache:revisions', { count: repo.revisions.length })}
          </Badge>
        </button>
        <span className="nums min-w-16 text-right font-mono text-[12px] text-ink-faint">
          {formatBytes(repo.sizeOnDisk)}
        </span>
        {stale && (
          <Button variant="ghost" size="sm" onClick={onDeleteStale}>
            <Trash2 className="size-3.5" aria-hidden />
            {t('cache:deleteStale')}
          </Button>
        )}
        <CacheIconAction
          label={t('cache:prune')}
          hint={t('cache:pruneTooltip')}
          testId={`cache-prune-${repoKey}`}
          onClick={onPrune}
        >
          <Eraser className="size-4" aria-hidden />
        </CacheIconAction>
        <CacheIconAction
          label={t('cache:repair')}
          hint={repairHint}
          disabled={repairBlock !== null}
          testId={`cache-repair-${repoKey}`}
          onClick={onRepair}
        >
          <Wrench className="size-4" aria-hidden />
        </CacheIconAction>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common:showInFolder')}
          onClick={onReveal}
        >
          <FolderOpen className="size-4" aria-hidden />
        </Button>
      </div>
      {isOpen && (
        <div className="border-t px-3 py-1.5">
          <div className="ml-2 border-l border-border-card pl-3.5">
            {repo.revisions.map((rev) => (
              <div key={rev.commitHash} className="flex h-9 items-center gap-2.5">
                <span className="nums w-24 shrink-0 font-mono text-[12px] text-ink-muted">
                  {rev.commitHash.slice(0, 10)}
                </span>
                {rev.refs.length > 0 ? (
                  rev.refs.map((ref) => (
                    <Badge
                      key={ref}
                      variant="outline"
                      className="border-select/25 bg-select/10 text-select"
                    >
                      {ref}
                    </Badge>
                  ))
                ) : pinnedCommits?.has(rev.commitHash) ? (
                  <Badge variant="outline" className="border-select/25 bg-select/10 text-select">
                    {t('cache:pinned')}
                  </Badge>
                ) : (
                  <Badge variant="outline">{t('cache:noRefs')}</Badge>
                )}
                <span className="nums text-[11.5px] text-ink-faint">
                  {t('cache:files', { count: rev.fileCount })}
                </span>
                <span data-visual-mask="timestamp" className="nums text-[11.5px] text-ink-faint">
                  {formatRelativeTime(rev.lastModified, locale)}
                </span>
                <span className="nums ml-auto font-mono text-[12px] text-ink-faint">
                  {formatBytes(rev.sizeOnDisk)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('cache:deleteRevision')}
                  onClick={() => onDeleteRevision(rev.commitHash, rev.sizeOnDisk)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            ))}
            {(repo.partialSize ?? 0) > 0 && (
              <div className="nums flex h-9 items-center justify-between gap-2 text-[11.5px] text-ink-faint">
                {t('cache:partialData', { size: formatBytes(repo.partialSize ?? 0) })}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={cleanPending}
                  onClick={onCleanPartials}
                >
                  {t('cache:cleanPartials')}
                </Button>
              </div>
            )}
            {verification && verification.issues.length > 0 ? (
              <ul data-testid={`cache-issues-${repoKey}`} className="py-1">
                {verification.issues.map((issue) => (
                  <li
                    key={`${issue.issue}:${issue.path}`}
                    className="flex items-start gap-2 py-1 text-[11.5px]"
                  >
                    <Badge variant={bucketOf(issue.issue) === 'unreadable' ? 'error' : 'warning'}>
                      {t(`cache:issues.${issue.issue}`)}
                    </Badge>
                    <span className="min-w-0 break-all font-mono text-ink-muted">{issue.path}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
