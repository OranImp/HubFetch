import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listClones, onClonesChanged } from '@/lib/clones'

/**
 * Authoritative clone-list query plus the `evt:clones` subscription (Todo 33).
 *
 * - Initial mount runs `clones:list` — this is the restart/reload recovery path.
 * - Every push event carries the authoritative FULL list from the manager, so
 *   last-write-wins heals gap/out-of-order deliveries while the page is open.
 * - Regaining window focus refetches the authoritative list — the reconnect
 *   recovery path (a missed event while blurred is never silently stale).
 * - `useClonesQuery` returns the query; components call `refetch()`/`reconcile`
 *   after their own mutations to re-sync from main.
 */
export const CLONES_QUERY_KEY = ['clones'] as const

export function useClonesQuery() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: CLONES_QUERY_KEY,
    queryFn: () => listClones()
  })

  // Live push subscription: each payload is the authoritative snapshot.
  useEffect(() => {
    return onClonesChanged((records) => {
      queryClient.setQueryData(CLONES_QUERY_KEY, records)
    })
  }, [queryClient])

  // Reconcile from the authoritative list after a reconnect (window focus).
  useEffect(() => {
    const onFocus = (): void => {
      void queryClient.invalidateQueries({ queryKey: CLONES_QUERY_KEY })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [queryClient])

  return query
}
