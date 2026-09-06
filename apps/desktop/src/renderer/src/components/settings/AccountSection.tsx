import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'
import { normalizeHubEndpoint } from '@hubfetch/shared'
import { invoke } from '@/lib/ipc'
import { isAuthError } from '@/lib/errors'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { PlanBadge } from '@/components/profile/PlanBadge'
import { ProfileAvatar } from '@/components/profile/ProfileAvatar'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { resolveLocale, useAppStore } from '@/stores/app'
import { commitSignOutResult } from '@/hooks/use-accounts'
import { AccountList } from '@/components/settings/AccountList'
import { TokenSignInForm } from '@/components/settings/TokenSignInForm'

export function AccountSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'auth', 'profile', 'common'])
  const auth = useAppStore((s) => s.auth)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  const signOut = useMutation({
    mutationFn: () => invoke('auth:signOut', undefined),
    onSuccess: (result) => {
      if (commitSignOutResult(queryClient, result)) {
        setConfirmSignOut(false)
        return
      }
      if (typeof result === 'object' && result !== null && 'error' in result) {
        if (result.error === 'account-in-use' && 'counts' in result) {
          push(
            t('auth:accountRemove.inUse', {
              downloads: result.counts.downloads,
              clones: result.counts.clones,
              uploads: result.counts.uploads,
              total: result.counts.total
            }),
            'error'
          )
          return
        }
        push(t('auth:accountRemove.not-found'), 'error')
      }
    }
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-smd font-semibold text-ink-strong">{t('settings:account.title')}</h2>
      {auth.status === 'signedIn' ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <ProfileAvatar
              name={auth.user.name}
              url={auth.user.avatarUrl}
              className="size-9 text-[12px]"
              isPro={auth.user.isPro === true}
              frame="compact"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium text-ink-strong">
                  {auth.user.fullname ?? auth.user.name}
                </span>
                {auth.user.isPro && <PlanBadge kind="pro" />}
              </div>
              <div className="truncate text-[12px] text-ink-muted">@{auth.user.name}</div>
              {auth.user.orgs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {auth.user.orgs.map((org) => (
                    <span key={org.name} className="inline-flex items-center gap-1">
                      <Badge variant="outline">{org.name}</Badge>
                      {org.plan && <PlanBadge kind={org.plan} />}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                closeSettings()
                navigate(`/users/${auth.user.name}`)
              }}
            >
              {t('profile:viewProfile')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirmSignOut(true)}>
              <LogOut className="size-3.5" aria-hidden />
              {t('auth:signOut')}
            </Button>
          </div>
          <AccountList allowAdd />
          <BillingUsageCard />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-ink-faint">{t('auth:hint')}</p>
          <TokenSignInForm />
          <AccountList allowAdd={false} />
        </div>
      )}

      <Dialog
        open={confirmSignOut}
        onOpenChange={(open) => {
          if (!signOut.isPending) setConfirmSignOut(open)
        }}
      >
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold text-ink-strong">
            {t('auth:signOutConfirm.title')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            {t('auth:signOutConfirm.body')}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={signOut.isPending}
              onClick={() => setConfirmSignOut(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              {t('auth:signOut')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function BillingUsageCard(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)

  const usage = useQuery({
    queryKey: ['hub-billing-usage', endpointKey],
    queryFn: () => invoke('hub:billingUsage', undefined),
    retry: (failureCount, error) => failureCount < 2 && !isAuthError(error.message)
  })

  const formatAmount = (cents: number): string =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100)

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-card bg-card-gradient p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[12.5px] font-medium text-ink-strong">
          {t('settings:account.billing.title')}
        </h4>
        {usage.data?.periodStart !== undefined && usage.data.periodEnd !== undefined && (
          <span className="nums text-[11.5px] text-ink-faint">
            {t('settings:account.billing.period', {
              start: formatDate(usage.data.periodStart, locale),
              end: formatDate(usage.data.periodEnd, locale)
            })}
          </span>
        )}
      </div>
      {usage.isPending && <Skeleton className="h-14" />}
      {usage.isError &&
        (isAuthError(usage.error.message) ? (
          <p className="text-[12px] text-ink-faint">{t('settings:account.billing.unauthorized')}</p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[12px] text-ink-muted">{usage.error.message}</p>
            <Button variant="ghost" size="sm" onClick={() => void usage.refetch()}>
              {t('common:retry')}
            </Button>
          </div>
        ))}
      {usage.data !== undefined && usage.data.rows.length === 0 && (
        <p className="text-[12px] text-ink-faint">{t('settings:account.billing.empty')}</p>
      )}
      {usage.data !== undefined && usage.data.rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {usage.data.rows.map((row, index) => (
            <div
              key={`${row.label}-${index}`}
              className="flex items-center justify-between gap-4 text-[12.5px]"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-ink">{row.label}</span>
                {row.detail !== undefined && row.detail !== '' && (
                  <span className="truncate text-[11.5px] text-ink-faint">{row.detail}</span>
                )}
              </div>
              {row.amountCents !== undefined && (
                <span className="nums shrink-0 text-ink-muted">{formatAmount(row.amountCents)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
