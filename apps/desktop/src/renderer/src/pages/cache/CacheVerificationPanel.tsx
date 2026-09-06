import { useTranslation } from 'react-i18next'
import type { CacheVerificationProgress, CacheVerificationReport } from '@hubfetch/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { formatRelativeTime } from '@/lib/utils'
import {
  countsOf,
  verificationProgressValue,
  type VerificationCounts
} from './cache-page-model'

interface CacheVerificationPanelProps {
  readonly progress: CacheVerificationProgress | null
  readonly report: CacheVerificationReport | null
  readonly error: string | null
  readonly canceled: boolean
  readonly locale: string
  readonly verifying: boolean
  readonly onRetry: () => void
}

function CountCell({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'success' | 'warning' | 'error' | 'neutral'
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border-card bg-card-gradient px-2.5 py-2">
      <span className="text-[11.5px] text-ink-faint">{label}</span>
      <Badge variant={tone} className="nums w-fit">
        {value}
      </Badge>
    </div>
  )
}

function phaseCopy(
  t: (key: string, opts?: Record<string, unknown>) => string,
  progress: CacheVerificationProgress
): string {
  switch (progress.phase) {
    case 'scanning':
      return t('cache:progress.scanning')
    case 'verifying':
      return t('cache:progress.verifying', {
        current: progress.currentRepo ?? '—',
        completed: progress.completedRepos,
        total: progress.totalRepos
      })
    case 'done':
      return t('cache:progress.done')
  }
}

export function CacheVerificationPanel({
  progress,
  report,
  error,
  canceled,
  locale,
  verifying,
  onRetry
}: CacheVerificationPanelProps): React.JSX.Element {
  const { t } = useTranslation(['cache', 'common'])
  const counts: VerificationCounts | null = report ? countsOf(report) : null
  const value = progress ? verificationProgressValue(progress) : report ? 1 : undefined

  return (
    <section
      data-testid="cache-verification-panel"
      className="flex min-h-[7.5rem] flex-col gap-2.5 rounded-lg border border-border-card bg-card-gradient p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-[12.5px] text-ink-muted">
          {progress
            ? phaseCopy(t, progress)
            : canceled
              ? t('cache:verifyCanceled')
              : report
                ? t('cache:scopeNote')
                : t('cache:neverVerified')}
        </p>
        <p
          data-visual-mask="timestamp"
          className="nums shrink-0 text-[11.5px] text-ink-faint"
        >
          {report
            ? t('cache:lastVerified', { time: formatRelativeTime(report.scannedAt, locale) })
            : t('cache:neverVerified')}
        </p>
      </div>
      <Progress
        value={value}
        indeterminate={verifying && value === undefined}
        aria-label={t('cache:verify')}
        aria-valuetext={progress ? phaseCopy(t, progress) : undefined}
      />
      <div
        data-testid="cache-verification-counts"
        className="grid min-h-14 grid-cols-3 gap-2"
      >
        <CountCell
          label={t('cache:counts.verified', { count: counts?.verified ?? 0 })}
          value={counts?.verified ?? 0}
          tone="success"
        />
        <CountCell
          label={t('cache:counts.corrupt', { count: counts?.corrupt ?? 0 })}
          value={counts?.corrupt ?? 0}
          tone={counts && counts.corrupt > 0 ? 'warning' : 'neutral'}
        />
        <CountCell
          label={t('cache:counts.unreadable', { count: counts?.unreadable ?? 0 })}
          value={counts?.unreadable ?? 0}
          tone={counts && counts.unreadable > 0 ? 'error' : 'neutral'}
        />
      </div>
      {error ? (
        <div
          role="alert"
          data-testid="cache-verify-error"
          className="flex flex-col gap-2 rounded-lg border border-border-card bg-panel px-3 py-2"
        >
          <p className="text-[12.5px] font-medium text-ink-strong">{t('cache:verifyError')}</p>
          <p className="text-[12px] text-ink-muted">{error}</p>
          <Button variant="secondary" size="sm" className="self-start" onClick={onRetry}>
            {t('common:retry')}
          </Button>
        </div>
      ) : null}
      {report?.ok && !error ? (
        <p data-testid="cache-verify-clean" className="text-[12px] text-ink-muted">
          {t('cache:verifyCleanBody')}
        </p>
      ) : null}
      {report?.truncated ? (
        <p className="text-[12px] text-ink-faint">{t('cache:truncated')}</p>
      ) : null}
    </section>
  )
}
