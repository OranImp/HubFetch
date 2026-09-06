import { useTranslation } from 'react-i18next'
import type { AccountSummary, AccountUsageCounts } from '@hubfetch/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PlanBadge } from '@/components/profile/PlanBadge'
import { ProfileAvatar } from '@/components/profile/ProfileAvatar'
import { cn } from '@/lib/utils'

const ROLE_KEYS = {
  read: 'settings:account.hub.roleLabels.read',
  write: 'settings:account.hub.roleLabels.write',
  fineGrained: 'settings:account.hub.roleLabels.fineGrained'
} as const

function roleLabelKey(role: string): string | null {
  if (role === 'read' || role === 'write' || role === 'fineGrained') return ROLE_KEYS[role]
  return null
}

export interface AccountRowModel {
  readonly account: AccountSummary
  readonly endpointMismatch: boolean
  readonly switching: boolean
  readonly switchDisabled: boolean
  readonly removing: boolean
  readonly removePending: boolean
  readonly inUse: AccountUsageCounts | null
  readonly onSwitch: () => void
  readonly onOpenNetwork: () => void
  readonly onReconnect: () => void
  readonly onDisconnect: () => void
  readonly reconnecting: boolean
  readonly disconnecting: boolean
  readonly onAskRemove: () => void
  readonly onConfirmRemove: () => void
  readonly onCancelRemove: () => void
}

export function AccountRow({
  account,
  endpointMismatch,
  switching,
  switchDisabled,
  removing,
  removePending,
  inUse,
  onSwitch,
  onOpenNetwork,
  onReconnect,
  onDisconnect,
  reconnecting,
  disconnecting,
  onAskRemove,
  onConfirmRemove,
  onCancelRemove
}: AccountRowModel): React.JSX.Element {
  const { t } = useTranslation(['settings', 'auth'])
  const isActive = account.active
  const removeBlocked = inUse !== null && inUse.total > 0
  const roleKey = account.tokenRole === undefined ? null : roleLabelKey(account.tokenRole)

  return (
    <div
      data-account-id={account.id}
      data-account-active={isActive ? 'true' : 'false'}
      data-account-pending={switching ? 'true' : 'false'}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 transition-colors duration-150',
        isActive && 'border-select bg-select/5',
        endpointMismatch && 'opacity-60'
      )}
    >
      <ProfileAvatar
        name={account.user.name}
        url={account.user.avatarUrl}
        className="size-8 text-[11px]"
        isPro={account.user.isPro === true}
        frame="compact"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink-strong">
            {account.user.fullname ?? account.user.name}
          </span>
          {account.user.isPro && <PlanBadge kind="pro" />}
          {isActive && (
            <Badge variant="select" className="text-[10px]">
              {t('settings:account.accounts.active')}
            </Badge>
          )}
          {account.invalid && (
            <Badge variant="error" className="text-[10px]">
              {t('settings:account.accounts.invalid')}
            </Badge>
          )}
        </div>
        <div className="truncate text-[11.5px] text-ink-muted">@{account.user.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="neutral" className="text-[10px]">
            {t('settings:account.hub.tokenSession')}
          </Badge>
          {account.tokenDisplayName && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {account.tokenDisplayName}
            </Badge>
          )}
          {account.tokenRole && (
            <Badge variant="outline" className="text-[10px]">
              {roleKey !== null ? t(roleKey) : account.tokenRole}
            </Badge>
          )}
          {account.hubSession && (
            <Badge variant="success" className="text-[10px]">
              {t('auth:hubSession.connected')}
            </Badge>
          )}
          {endpointMismatch && (
            <Badge variant="warning" className="text-[10px]">
              {t('settings:account.accounts.endpointMismatch')}
            </Badge>
          )}
        </div>
        {endpointMismatch && (
          <p className="mt-1.5 text-[11px] text-ink-faint">
            {t('settings:account.accounts.endpointMismatchHint')}
          </p>
        )}
        {removeBlocked && inUse !== null && (
          <p className="mt-1.5 text-[11px] text-error" role="status">
            {t('settings:account.accounts.inUse', {
              downloads: inUse.downloads,
              clones: inUse.clones,
              uploads: inUse.uploads
            })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {!isActive && endpointMismatch && (
          <Button variant="secondary" size="sm" onClick={onOpenNetwork}>
            {t('settings:account.accounts.openNetwork')}
          </Button>
        )}
        {!isActive && !endpointMismatch && (
          <Button
            variant="secondary"
            size="sm"
            loading={switching}
            disabled={switchDisabled}
            onClick={onSwitch}
          >
            {t('settings:account.accounts.switch')}
          </Button>
        )}
        {isActive && !account.hubSession && (
          <Button variant="ghost" size="sm" loading={reconnecting} onClick={onReconnect}>
            {t('auth:hubSession.connect')}
          </Button>
        )}
        {isActive && account.hubSession && (
          <Button variant="ghost" size="sm" loading={disconnecting} onClick={onDisconnect}>
            {t('auth:hubSession.disconnect')}
          </Button>
        )}
        {!isActive &&
          (!removing ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={removePending || removeBlocked}
              onClick={onAskRemove}
            >
              {t('settings:account.accounts.remove')}
            </Button>
          ) : (
            <>
              <Button
                variant="danger"
                size="sm"
                loading={removePending}
                disabled={removeBlocked}
                onClick={onConfirmRemove}
              >
                {t('settings:account.accounts.confirmRemove')}
              </Button>
              <Button variant="ghost" size="sm" disabled={removePending} onClick={onCancelRemove}>
                {t('settings:account.accounts.cancel')}
              </Button>
            </>
          ))}
      </div>
    </div>
  )
}
