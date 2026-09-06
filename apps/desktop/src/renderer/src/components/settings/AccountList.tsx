import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { normalizeHubEndpoint, type AccountUsageCounts } from '@hubfetch/shared'
import { useAccounts } from '@/hooks/use-accounts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppStore } from '@/stores/app'
import { AccountRow } from '@/components/settings/AccountRow'
import { TokenSignInForm } from '@/components/settings/TokenSignInForm'

export function AccountList({ allowAdd }: { allowAdd: boolean }): React.JSX.Element {
  const { t } = useTranslation(['settings', 'auth'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const openSettings = useAppStore((s) => s.openSettings)
  const { accounts, switchAccount, removeAccount, reconnectSession, disconnectHubSession } =
    useAccounts()
  const [addingAccount, setAddingAccount] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [inUseById, setInUseById] = useState<Record<string, AccountUsageCounts>>({})
  const currentEndpoint = normalizeHubEndpoint(endpoint)
  const hasAccounts = (accounts.data?.length ?? 0) > 0
  if (!allowAdd && (accounts.isPending || !hasAccounts)) return <></>

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <h3 className="text-[13px] font-semibold text-ink-strong">
        {t('settings:account.accounts.title')}
      </h3>

      {accounts.isPending && <Skeleton className="h-20" />}

      {accounts.data !== undefined && accounts.data.length > 0 && (
        <div className="flex flex-col gap-2" role="list">
          {accounts.data.map((account) => {
            const inUse = inUseById[account.id] ?? null
            return (
              <div key={account.id} role="listitem" data-account-id={account.id}>
                <AccountRow
                  account={account}
                  endpointMismatch={account.endpoint !== currentEndpoint}
                  switching={switchAccount.isPending && switchAccount.variables === account.id}
                  switchDisabled={switchAccount.isPending}
                  removing={removingId === account.id}
                  removePending={removeAccount.isPending && removeAccount.variables === account.id}
                  inUse={inUse}
                  onSwitch={() => switchAccount.mutate(account.id)}
                  onOpenNetwork={() => openSettings('network')}
                  onReconnect={() => reconnectSession.mutate()}
                  onDisconnect={() => disconnectHubSession.mutate()}
                  reconnecting={reconnectSession.isPending}
                  disconnecting={disconnectHubSession.isPending}
                  onAskRemove={() => setRemovingId(account.id)}
                  onConfirmRemove={() => {
                    removeAccount.mutate(account.id, {
                      onSuccess: (result) => {
                        if (result.ok) {
                          setRemovingId(null)
                          return
                        }
                        if (result.error === 'account-in-use') {
                          setInUseById((current) => ({ ...current, [account.id]: result.counts }))
                        }
                      }
                    })
                  }}
                  onCancelRemove={() => setRemovingId(null)}
                />
              </div>
            )
          })}
        </div>
      )}

      {allowAdd &&
        (!addingAccount ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => setAddingAccount(true)}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('settings:account.accounts.addAccount')}
          </Button>
        ) : (
          <div className="rounded-lg border bg-panel p-3">
            <TokenSignInForm
              submitMode="add"
              onDone={() => {
                setAddingAccount(false)
                void accounts.refetch()
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setAddingAccount(false)}
            >
              {t('settings:account.accounts.cancel')}
            </Button>
          </div>
        ))}
    </div>
  )
}
