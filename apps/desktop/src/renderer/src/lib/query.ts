import { QueryClient } from '@tanstack/react-query'
import type { AuthState } from '@hubfetch/shared'

/** Query families whose payload comes from the currently configured Hub endpoint. */
const HUB_REMOTE_QUERY_ROOTS = new Set([
  'access-requests',
  'arrowPreview',
  'collection',
  'collections',
  'datasetRows',
  'datasetSampleRows',
  'datasetSplits',
  'discussion',
  'discussionDiff',
  'discussions',
  'fileText',
  'ggufHeader',
  'globalSearch',
  'home',
  'hub-billing-usage',
  'hub-following',
  'hub-notifications',
  'hub-profile',
  'hub-watched',
  'inference-available',
  'my-repos',
  'onnxPreview',
  'org-members',
  'paper',
  'papers',
  'parquetMeta',
  'parquetRows',
  'post',
  'post-can-create',
  'post-comments',
  'readme',
  'repo',
  'repo-access',
  'safetensors',
  'search',
  'searchPage',
  'space-logs',
  'space-secrets',
  'space-variables',
  'tree',
  'user-likes',
  'user-overview',
  'user-repos',
  'user-search'
])

/** Local library rows scoped to the signed-in account (not Hub HTTP). */
const ACCOUNT_LIBRARY_QUERY_ROOTS = new Set(['accounts-list', 'inbox', 'follows'])

export const ACCOUNTS_QUERY_KEY = ['accounts-list'] as const

export function isHubRemoteQuery(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0]
  return typeof root === 'string' && HUB_REMOTE_QUERY_ROOTS.has(root)
}

/** Hub HTTP families plus account-scoped local library queries. */
export function isAccountBackedQuery(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0]
  return (
    isHubRemoteQuery(queryKey) ||
    (typeof root === 'string' && ACCOUNT_LIBRARY_QUERY_ROOTS.has(root))
  )
}

export function accountIdOf(auth: AuthState): string | null {
  return auth.status === 'signedIn' ? auth.accountId : null
}

/**
 * Drop Hub/account-backed cache and in-flight remote mutations without
 * refetching. Device-global favorites/history/appearance queries are left
 * untouched. Callers refetch only after the auth event commits.
 */
export function dropAccountPartition(client: QueryClient): void {
  void client.cancelQueries({
    predicate: (query) => isAccountBackedQuery(query.queryKey)
  })
  client.removeQueries({
    predicate: (query) => isAccountBackedQuery(query.queryKey)
  })
  for (const mutation of client.getMutationCache().getAll()) {
    client.getMutationCache().remove(mutation)
  }
}

export function refetchAccountPartition(client: QueryClient): void {
  void client.invalidateQueries({
    predicate: (query) => isAccountBackedQuery(query.queryKey)
  })
}

/** Returns true when the committed identity changed and the partition was dropped. */
export function applyAuthStateChange(
  client: QueryClient,
  previous: AuthState,
  next: AuthState
): boolean {
  if (accountIdOf(previous) === accountIdOf(next)) return false
  dropAccountPartition(client)
  return true
}

/**
 * Stale-while-revalidate everywhere: cached pages render instantly while a
 * background refetch runs. The main process adds its own response cache on top.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false
    }
  }
})
