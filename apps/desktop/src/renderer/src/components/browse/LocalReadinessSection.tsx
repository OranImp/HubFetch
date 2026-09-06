import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { DownloadPlan, ExportTool, RepoKind } from '@hubfetch/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { buildLocalReadiness } from '@/lib/local-readiness'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'
import { DownloadCreateDialog } from '@/components/downloads/DownloadCreateDialog'
import { LocalReadinessPanel } from '@/components/browse/LocalReadinessPanel'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'

type RepoSibling = {
  readonly rfilename: string
  readonly size?: number
}

type LocalReadinessSectionProps = {
  readonly kind: RepoKind
  readonly repoId: string
  readonly siblings?: readonly RepoSibling[]
  readonly loading: boolean
}

export function LocalReadinessSection({
  kind,
  repoId,
  siblings,
  loading
}: LocalReadinessSectionProps): React.JSX.Element | null {
  const { t } = useTranslation(['detail', 'common', 'integrations', 'errors'])
  const endpointKey = useHubEndpointKey()
  const push = useToasts((s) => s.push)
  const [plan, setPlan] = useState<DownloadPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planFiles, setPlanFiles] = useState<string[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const files = useMemo(
    () => (siblings ?? []).map((entry) => ({ path: entry.rfilename, size: entry.size ?? 0 })),
    [siblings]
  )

  const targets = useQuery({
    queryKey: ['export-targets'],
    queryFn: () => invoke('export:targets', undefined),
    staleTime: 5 * 60_000
  })
  const cache = useQuery({
    queryKey: ['cache'],
    queryFn: () => invoke('cache:scan', undefined),
    staleTime: 5 * 60_000
  })

  const draft = useMemo(
    () =>
      buildLocalReadiness({
        files,
        cachedPaths: new Set(),
        exportTargets: targets.data ?? []
      }),
    [files, targets.data]
  )
  const candidatePaths = useMemo(
    () => draft.groups.flatMap((group) => group.files.map((file) => file.path)),
    [draft]
  )

  const planned = useQuery({
    queryKey: ['readiness-plan', kind, repoId, endpointKey, candidatePaths.join('\0')],
    queryFn: () =>
      invoke('downloads:plan', {
        request: { repoId, kind, files: candidatePaths }
      }),
    enabled: candidatePaths.length > 0,
    staleTime: 60_000,
    retry: false
  })

  const cachedPaths = useMemo(() => {
    void cache.data
    return new Set(
      (planned.data?.files ?? []).filter((row) => row.alreadyCached).map((row) => row.path)
    )
  }, [cache.data, planned.data])

  const readiness = useMemo(
    () =>
      buildLocalReadiness({
        files,
        cachedPaths,
        exportTargets: targets.data ?? []
      }),
    [cachedPaths, files, targets.data]
  )

  const resolvePlan = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      const selected = [...paths]
      setPlanFiles(selected)
      setPlanLoading(true)
      setPlanError(null)
      try {
        const result = await invoke('downloads:plan', {
          request: { repoId, kind, files: selected }
        })
        setPlan(result)
        setCreateOpen(true)
      } catch (err) {
        setPlanError(err instanceof Error ? err.message : String(err))
        setCreateOpen(true)
      } finally {
        setPlanLoading(false)
      }
    },
    [kind, repoId]
  )

  const startPlanned = useMutation({
    mutationFn: (paths: string[]) =>
      invoke('downloads:startPlanned', {
        request: { planId: plan?.planId ?? '', paths }
      }),
    onSuccess: () => {
      push(t('detail:downloadStarted'), 'success')
      setCreateOpen(false)
      setPlan(null)
      setPlanError(null)
      setPlanFiles(null)
      void planned.refetch()
    },
    onError: (err) => {
      push(t('detail:downloadFailed', { error: err.message }), 'error')
    }
  })

  const exportRun = useMutation({
    mutationFn: (args: { tool: ExportTool; filePath: string }) =>
      invoke('export:start', {
        request: { tool: args.tool, kind, repoId, filePath: args.filePath }
      }),
    onSuccess: () => push(t('common:running'), 'info'),
    onError: (err) => push(describeError(t, err), 'error')
  })

  if (loading && siblings === undefined) {
    return (
      <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border-card p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (readiness.groups.length === 0) return null

  return (
    <>
      <LocalReadinessPanel
        readiness={readiness}
        downloadPending={planLoading || startPlanned.isPending}
        exportPending={exportRun.isPending}
        onDownload={(paths) => {
          void resolvePlan(paths)
        }}
        onExport={(tool, filePath) => {
          void exportRun.mutateAsync({ tool, filePath })
        }}
      />
      <DownloadCreateDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) {
            setPlan(null)
            setPlanError(null)
            setPlanFiles(null)
          }
        }}
        plan={plan}
        loading={planLoading}
        error={planError ?? undefined}
        onRetry={() => planFiles && void resolvePlan(planFiles)}
        pending={startPlanned.isPending}
        onConfirm={(paths) => {
          void startPlanned.mutateAsync(paths)
        }}
      />
    </>
  )
}
