import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { AccountSwitchResult, AuthState } from '@hubfetch/shared'
import { invoke } from '@/lib/ipc'
import { ACCOUNTS_QUERY_KEY, applyAuthStateChange } from '@/lib/query'
import { useToasts } from '@/components/ui/toaster'
import { useAppStore } from '@/stores/app'

export { ACCOUNTS_QUERY_KEY }

function commitAuth(client: QueryClient, next: AuthState): void {
  applyAuthStateChange(client, useAppStore.getState().auth, next)
  useAppStore.getState().setAuth(next)
}

function isAuthState(value: unknown): value is AuthState {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false
  const status = value.status
  return status === 'signedOut' || status === 'signedIn' || status === 'credential-corrupt'
}

export function commitSignOutResult(client: QueryClient, result: unknown): boolean {
  if (!isAuthState(result)) return false
  commitAuth(client, result)
  return true
}

export function useAccounts() {
  const { t } = useTranslation(['auth', 'settings'])
  const queryClient = useQueryClient()
  const openSettings = useAppStore((s) => s.openSettings)
  const push = useToasts((s) => s.push)

  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => invoke('auth:listAccounts', undefined),
    staleTime: Infinity
  })

  const switchAccount = useMutation({
    mutationFn: (accountId: string) => invoke('auth:switchAccount', { accountId }),
    onSuccess: (result) => {
      if (result.ok) {
        commitAuth(queryClient, result.state)
        return
      }
      reportSwitchFailure(result, t, push, openSettings)
    },
    onError: (err) => push(err.message, 'error')
  })

  const removeAccount = useMutation({
    mutationFn: (accountId: string) => invoke('auth:removeAccount', { accountId }),
    onSuccess: (result) => {
      if (result.ok) {
        commitAuth(queryClient, result.state)
        queryClient.setQueryData(ACCOUNTS_QUERY_KEY, result.accounts)
        push(t('auth:accountRemove.success'), 'success')
        return
      }
      if (result.error === 'account-in-use') {
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
    },
    onError: (err) => push(err.message, 'error')
  })

  const reconnectSession = useMutation({
    mutationFn: () => invoke('auth:connectHubSession', undefined),
    onSuccess: (result) => {
      if (result.ok) {
        commitAuth(queryClient, result.state)
        void accounts.refetch()
        return
      }
      if (result.error !== 'canceled') {
        push(t(`auth:hubSession.${result.error}`), 'error')
      }
    },
    onError: (err) => push(err.message, 'error')
  })

  const disconnectHubSession = useMutation({
    mutationFn: () => invoke('auth:disconnectHubSession', undefined),
    onSuccess: (state) => {
      commitAuth(queryClient, state)
      void accounts.refetch()
    },
    onError: (err) => push(err.message, 'error')
  })

  return { accounts, switchAccount, removeAccount, reconnectSession, disconnectHubSession }
}

function reportSwitchFailure(
  result: Extract<AccountSwitchResult, { ok: false }>,
  t: (key: string) => string,
  push: ReturnType<typeof useToasts.getState>['push'],
  openSettings: (section?: 'network') => void
): void {
  switch (result.error) {
    case 'endpoint-mismatch':
      push(t('auth:accountSwitch.endpointMismatch'), 'error', {
        action: {
          label: t('settings:account.accounts.openNetwork'),
          onClick: () => openSettings('network')
        }
      })
      return
    case 'not-found':
    case 'invalid':
    case 'forbidden':
    case 'network':
      push(t(`auth:accountSwitch.${result.error}`), 'error')
      return
  }
}
