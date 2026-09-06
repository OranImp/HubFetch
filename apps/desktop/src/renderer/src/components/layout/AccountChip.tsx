import { useTranslation } from 'react-i18next'
import { Check, Loader2, UserCircle2 } from 'lucide-react'
import { normalizeHubEndpoint } from '@hubfetch/shared'
import { useAccounts } from '@/hooks/use-accounts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProfileAvatar } from '@/components/profile/ProfileAvatar'
import { useAppStore } from '@/stores/app'
import { cn } from '@/lib/utils'

/**
 * TopBar account control: signed-in chip opens a validated account menu.
 * Active identity follows the committed AuthState — never an optimistic pick.
 */
export function AccountChip(): React.JSX.Element {
  const { t } = useTranslation(['nav', 'auth', 'settings'])
  const auth = useAppStore((s) => s.auth)
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const openSettings = useAppStore((s) => s.openSettings)
  const { accounts, switchAccount } = useAccounts()
  const currentEndpoint = normalizeHubEndpoint(endpoint)
  const signedIn = auth.status === 'signedIn'
  const pendingId = switchAccount.isPending ? switchAccount.variables : undefined

  const label = signedIn
    ? t('nav:accountSignedIn', { name: auth.user.fullname ?? auth.user.name })
    : t('nav:account')

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={label}
              data-account-chip=""
              className={cn(
                'app-no-drag flex shrink-0 items-center text-ink-muted transition-colors duration-150 hover:bg-panel-2 hover:text-ink data-[state=open]:bg-panel-2 data-[state=open]:text-ink',
                signedIn
                  ? 'h-8 max-w-[11rem] gap-1.5 rounded-full px-1.5'
                  : 'size-8 justify-center rounded-full'
              )}
            >
              {signedIn ? (
                <>
                  <ProfileAvatar
                    name={auth.user.name}
                    url={auth.user.avatarUrl}
                    isPro={auth.user.isPro === true}
                    frame="compact"
                    eager
                    className="size-5 text-[10px]"
                  />
                  <span className="hidden min-w-0 truncate font-mono text-[11.5px] sm:block">
                    {auth.user.name}
                  </span>
                </>
              ) : (
                <UserCircle2 className="size-[18px]" aria-hidden />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="px-2 py-1.5 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">
          {t('settings:account.accounts.title')}
        </div>
        {(accounts.data ?? []).map((account) => {
          const mismatch = account.endpoint !== currentEndpoint
          const switching = pendingId === account.id
          const active = account.active
          return (
            <DropdownMenuItem
              key={account.id}
              disabled={mismatch || switchAccount.isPending || active}
              data-account-id={account.id}
              data-account-active={active ? 'true' : 'false'}
              data-account-pending={switching ? 'true' : 'false'}
              aria-current={active ? 'true' : undefined}
              onSelect={(event) => {
                event.preventDefault()
                if (mismatch || active || switchAccount.isPending) return
                switchAccount.mutate(account.id)
              }}
              className={cn(mismatch && 'opacity-60')}
            >
              <ProfileAvatar
                name={account.user.name}
                url={account.user.avatarUrl}
                isPro={account.user.isPro === true}
                frame="compact"
                className="size-5 text-[10px]"
              />
              <span className="min-w-0 flex-1 truncate">
                {account.user.fullname ?? account.user.name}
              </span>
              {switching ? (
                <Loader2 className="size-3.5 animate-spin text-ink-faint" aria-hidden />
              ) : active ? (
                <Check className="size-3.5 text-select" aria-hidden />
              ) : null}
            </DropdownMenuItem>
          )
        })}
        {(accounts.data ?? []).some((account) => account.endpoint !== currentEndpoint) && (
          <DropdownMenuItem onSelect={() => openSettings('network')}>
            {t('settings:account.accounts.openNetwork')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings('account')}>
          {t('settings:account.accounts.manage')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
