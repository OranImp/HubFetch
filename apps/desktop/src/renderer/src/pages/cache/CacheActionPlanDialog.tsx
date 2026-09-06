import { useTranslation } from 'react-i18next'
import type { CacheActionPlan, CacheApplyFailureReason } from '@hubfetch/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { formatBytes } from '@/lib/utils'
import { isStalePlanReason } from './cache-page-model'

interface CacheActionPlanDialogProps {
  readonly plan: CacheActionPlan | null
  readonly applying: boolean
  readonly failureReason: CacheApplyFailureReason | null
  readonly onClose: () => void
  readonly onApply: () => void
  readonly onReplan: () => void
}

export function CacheActionPlanDialog({
  plan,
  applying,
  failureReason,
  onClose,
  onApply,
  onReplan
}: CacheActionPlanDialogProps): React.JSX.Element {
  const { t } = useTranslation(['cache', 'common'])
  const stale = failureReason !== null && isStalePlanReason(failureReason)
  const canApply = plan !== null && !applying && !stale

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(36rem,calc(100vh-4rem))] w-[28rem] flex-col">
        <DialogTitle className="pr-8 text-[14px] font-semibold">
          {plan?.action === 'repair' ? t('cache:plan.repairTitle') : t('cache:plan.pruneTitle')}
        </DialogTitle>
        <DialogDescription className="mt-2 text-[13px] text-ink-muted">
          {plan?.action === 'repair'
            ? t('cache:plan.repairBody', { commit: plan.resolvedCommit.slice(0, 10) })
            : t('cache:plan.pruneBody')}
        </DialogDescription>
        {plan ? (
          <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            <p className="nums text-[12.5px] text-ink">
              {plan.action === 'repair'
                ? t('cache:plan.download', { size: formatBytes(plan.estimatedBytes) })
                : t('cache:plan.reclaim', { size: formatBytes(plan.estimatedBytes) })}
            </p>
            {plan.action === 'repair' ? (
              <p className="text-[12px] text-ink-muted">
                {plan.accountLabel
                  ? t('cache:plan.accountRequired', { label: plan.accountLabel })
                  : t('cache:plan.accountAnonymous')}
              </p>
            ) : null}
            <p className="text-[12px] text-ink-faint">
              {plan.protectedCommits.length > 0 || plan.protectedTaskIds.length > 0
                ? t('cache:plan.protected', {
                    commits: plan.protectedCommits.length,
                    tasks: plan.protectedTaskIds.length
                  })
                : t('cache:plan.protectedNone')}
            </p>
            <ul
              data-testid="cache-plan-entries"
              className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-card"
            >
              {plan.entries.map((entry) => (
                <li
                  key={entry.path}
                  className="flex items-start justify-between gap-2 border-b border-border-card px-2.5 py-1.5 last:border-b-0"
                >
                  <span className="min-w-0 break-all font-mono text-[11.5px] text-ink-muted">
                    {entry.path}
                  </span>
                  <span className="nums shrink-0 font-mono text-[11.5px] text-ink-faint">
                    {formatBytes(entry.estimatedBytes)}
                  </span>
                </li>
              ))}
            </ul>
            {failureReason ? (
              <p role="alert" data-testid="cache-plan-error" className="text-[12.5px] text-error">
                {stale
                  ? t('cache:plan.stale')
                  : t(`cache:apply.failure.${failureReason}`)}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          {stale ? (
            <Button
              variant="cta"
              size="sm"
              data-testid="cache-plan-replan"
              onClick={onReplan}
            >
              {t('cache:plan.replan')}
            </Button>
          ) : (
            <Button
              variant="cta"
              size="sm"
              data-testid="cache-plan-apply"
              loading={applying}
              disabled={!canApply}
              onClick={onApply}
            >
              {t('cache:plan.apply')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
